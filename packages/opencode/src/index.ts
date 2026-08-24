import { type Plugin, tool } from "@opencode-ai/plugin";
import type { ToolPart } from "@opencode-ai/sdk";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { compressToolOutput, HeadroomStage, originOf, proxyHealthy, resolveHeadroom, retrieveOriginal, saveOriginals, searchOriginals, stopSpawnedProxies, type StageMessage } from "acp-headroom-core";

/**
 * ACP+Headroom for OpenCode — same sent-view architecture as acp-headroom-pi:
 *
 * - `experimental.chat.messages.transform` compresses oversized COMPLETED tool
 *   results older than the last user message right before the LLM call; the
 *   model's current-turn working set is never touched.
 * - `experimental.chat.system.transform` injects marker-usage instructions.
 * - `headroom_retrieve` / `headroom_status` tools let the model pull originals
 *   back by hash and inspect savings.
 *
 * Config (env-driven, shared with every acp-headroom adapter):
 *   HEADROOM_PROXY_URL   proxy base URL    (default http://127.0.0.1:8787)
 *   HEADROOM_MIN_CHARS   min result size    (default 4000)
 *   HEADROOM_CCR_DIR     disk backup dir    (default ~/.acp-headroom/ccr)
 *   HEADROOM_AUTOSTART   spawn proxy if down ("0" disables, default on)
 */

const settings = () => {
	const base = {
		proxyUrl: process.env.HEADROOM_PROXY_URL,
		minChars: numEnv("HEADROOM_MIN_CHARS"),
		maxPerTurn: numEnv("HEADROOM_MAX_PER_TURN"),
		// Real-kompress on large payloads routinely exceeds 3s server-side
		// (proxy's own budget is 30s) — give it 10s by default.
		timeoutMs: numEnv("HEADROOM_TIMEOUT_MS") ?? 10_000,
		autoStart: process.env.HEADROOM_AUTOSTART !== "0",
	};
	// Adaptive pressure (ACP): escalate aggressiveness as the real,
	// provider-reported context fills toward the model's window. Explicit
	// env config always wins over escalation.
	if (pressure.limit > 0 && base.minChars === undefined) {
		const ratio = usage.contextTokens / pressure.limit;
		// Bands mirror acp-kernel's nudge config: minContextLimitPct 0.45,
		// maxContextLimitPct 0.75.
		if (ratio >= 0.75) return { ...base, minChars: 800, maxPerTurn: 24 };
		if (ratio >= 0.45) return { ...base, minChars: 2000, maxPerTurn: 12 };
	}
	return base;
};

function numEnv(name: string): number | undefined {
	const v = Number(process.env[name]);
	return Number.isFinite(v) && v > 0 ? v : undefined;
}

function isAnthropic(m?: { providerID?: string; api?: { npm?: string } }): boolean {
	if (!m) return false;
	return m.providerID === "anthropic" || (m.api?.npm ?? "").includes("anthropic");
}

// opencode built-in hidden agents whose requests must pass through untouched.
const INTERNAL_AGENTS = new Set(["title", "summary", "compaction"]);

// Per-instance runtime state (one plugin instance per opencode server):
// real provider-reported usage refreshed each LLM call, plus the active
// model's context window limit captured from chat.params.
const usage = { contextTokens: 0, outputTokens: 0, cost: 0 };
const pressure = { limit: 0 };
// Lightweight ACP range compression: refs ([mN]) address older messages; the
// model writes summaries via acp_compress; transform folds ranges on every
// later round. Memory-only by design — an opencode restart yields a fresh
// projection, so dangling ranges cannot exist. ponytail: single-instance map,
// no cross-session isolation; add session keying only if concurrent sessions
// ever show interference.
const acpState = {
	nextRef: 1,
	refByInfo: new Map<string, number>(),
	ranges: [] as Array<{ start: number; end: number; summary: string; truncated?: boolean }>,
	sessionId: "",
	loadedFor: "",
};

// --- Backlog adopted from opencode-acp source review ---
// GC safety net: at 95% of the window, evict the OLDEST folded summaries
// (keep the 2 newest) so total summary overhead stays bounded even in
// month-scale sessions. Eviction persists (truncated flag) and folding
// renders evicted ranges as one-liners — hashes are re-collectable via
// headroom_search over disk backups, so nothing becomes unrecoverable.
const GC_RATIO = 0.95;
const GC_KEEP_NEWEST = 2;

function gcEvictOldestAnchors(): void {
	if (pressure.limit <= 0 || usage.contextTokens <= 0) return;
	if (usage.contextTokens / pressure.limit < GC_RATIO) return;
	let changed = false;
	for (const r of acpState.ranges.slice(0, Math.max(0, acpState.ranges.length - GC_KEEP_NEWEST))) {
		if (!r.truncated) {
			r.truncated = true;
			changed = true;
		}
	}
	if (changed) void saveRanges();
}

// Range persistence: folds survive opencode restarts (pi persists compressed
// blocks too — without this, every restart re-inflates context back to the
// pre-fold size). Keyed per session; refs are positional and stable for
// unchanged history, so restored ranges keep pointing at the right messages.
// Storage lives inside opencode's own data tree (XDG-aware), matching where
// the host keeps per-session plugin state.
function rangesDir(): string {
	if (process.env.HEADROOM_RANGES_DIR) return path.resolve(process.env.HEADROOM_RANGES_DIR);
	const dataHome = process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share");
	return path.join(dataHome, "opencode", "storage", "plugin", "acp-headroom");
}

function legacyRangesDir(): string {
	return path.join(homedir(), ".acp-headroom", "ranges");
}

async function loadRanges(sessionId: string): Promise<void> {
	if (!sessionId || acpState.loadedFor === sessionId) return;
	acpState.loadedFor = sessionId;
	// Disk truth replaces in-memory state wholesale — otherwise a session
	// without a persisted file would inherit the previous session's folds.
	const ranges: Array<{ start: number; end: number; summary: string; truncated?: boolean }> = [];
	let next = 1;
	let raw: string | undefined;
	try {
		raw = await fs.readFile(path.join(rangesDir(), `${sessionId}.json`), "utf8");
	} catch {
		// One-time migration from the pre-0.2.4 location (~/.acp-headroom/ranges).
		try {
			raw = await fs.readFile(path.join(legacyRangesDir(), `${sessionId}.json`), "utf8");
			await fs.mkdir(rangesDir(), { recursive: true });
			await fs.writeFile(path.join(rangesDir(), `${sessionId}.json`), raw, "utf8");
		} catch {
			raw = undefined;
		}
	}
	if (raw !== undefined) {
		try {
			const data = JSON.parse(raw) as { nextRef?: unknown; ranges?: Array<{ start?: unknown; end?: unknown; summary?: unknown; truncated?: unknown }> };
			if (Array.isArray(data.ranges)) {
				for (const r of data.ranges) {
					if (typeof r.start === "number" && typeof r.end === "number" && typeof r.summary === "string") {
						ranges.push({ start: r.start, end: r.end, summary: r.summary, truncated: r.truncated === true ? true : undefined });
						next = Math.max(next, r.end + 1);
					}
				}
				if (typeof data.nextRef === "number") next = Math.max(next, data.nextRef);
			}
		} catch {
			// corrupt file → fresh empty state (fail-open)
		}
	}
	acpState.ranges = ranges;
	acpState.nextRef = Math.max(acpState.nextRef, next);
}

async function saveRanges(): Promise<void> {
	if (!acpState.sessionId) return;
	try {
		const dir = rangesDir();
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, `${acpState.sessionId}.json`), JSON.stringify({ nextRef: acpState.nextRef, ranges: acpState.ranges }), "utf8");
	} catch {
		// fail-open: folding still works this round even if persistence failed
	}
}
// Context composition: char counts by category from the last transform walk,
// rescaled to the provider-reported total (chars/4 proportions, calibrated).
const composition = {
	toolUncompressed: 0,
	ccrMarkers: 0,
	user: 0,
	assistant: 0,
	other: 0,
	totalTokens: 0,
};
let lastTier: number | null = null; // severity index of the last toast (0/1/2)
let lastToastTokens = 0;
// Nudge damping: re-inject only when the tier changes OR context grew ≥10%
// of the window since the last injection — mirrors opencode-acp's anchored
// nudge bookkeeping without the full anchor machinery.
let lastNudgeTier = "";
let lastNudgeTokens = 0;

function computeTier(): string {
	if (pressure.limit <= 0 || usage.contextTokens <= 0) return "normal";
	const ratio = usage.contextTokens / pressure.limit;
	// Same bands as settings(): 45% (acp-kernel minContextLimitPct) and
	// 75% (maxContextLimitPct).
	return ratio >= 0.75 ? "aggressive" : ratio >= 0.45 ? "elevated" : "normal";
}

function resetComposition(): void {
	composition.toolUncompressed = 0;
	composition.ccrMarkers = 0;
	composition.user = 0;
	composition.assistant = 0;
	composition.other = 0;
	composition.totalTokens = 0;
}

const SYSTEM_LINES = [
	"Large tool results may be mechanically compressed into short summaries carrying CCR retrieval hashes (marker formats: 'Retrieve more: hash=<hex>' or 'Retrieve original: hash=<hex>').",
	"When you need the exact full content of a compressed result, call headroom_retrieve with the hex hash from its marker.",
	"To find something you only vaguely remember from an older tool output, call headroom_search with keywords instead of guessing hashes.",
	// Proactive compression teaching (pi's WHEN TO COMPRESS, condensed):
	"Compress proactively regardless of context size: once you have extracted the key facts from a large tool result (build/test logs, diffs, directory listings, research output), call headroom_compress on that text and reference its marker instead of echoing the bulk into your reply.",
	// Range compression teaching (ACP dialect):
	"Older messages carry [mN] reference tags. When a whole stretch of older conversation is fully consumed — a finished exploration, a resolved thread, a completed task phase — call acp_compress with from/to covering its refs and a detailed summary you write; the range collapses to that summary in subsequent context. Never compress the current working set or verbatim-critical user instructions.",
];

const COMPACTION_LINES = [
	"Context note: some tool results in this conversation were mechanically compressed into short CCR summaries carrying retrieval hashes ('Retrieve more/original: hash=<hex>').",
	"When summarizing, preserve those hash references verbatim — the full originals remain recoverable via the headroom_retrieve tool.",
];

export const AcpHeadroomPlugin: Plugin = async ({ client }) => {
	const stage = new HeadroomStage(settings);

	// Real provider-reported usage lives at module scope (shared with the
	// settings() closure); see bottom of file.

	const renderStatus = async (): Promise<string> => {
		const cfg = resolveHeadroom(settings());
		const healthy = await proxyHealthy(cfg.proxyUrl);
		const ratio = pressure.limit > 0 ? usage.contextTokens / pressure.limit : 0;
		const tier = computeTier();
		const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
		const lines = [
			`enabled: ${cfg.enabled}`,
			`proxy: ${originOf(cfg.proxyUrl)} (${healthy ? "healthy" : "unreachable"})`,
			`minChars: ${cfg.minChars}, maxPerTurn: ${cfg.maxPerTurn}, timeoutMs: ${cfg.timeoutMs}, autoStart: ${cfg.autoStart}`,
			`context at last LLM call: ${usage.contextTokens} input tokens (provider-reported)` + (pressure.limit > 0 ? ` / ${pressure.limit} = ${(ratio * 100).toFixed(0)}% [${tier}]` : ""),
			`session stats: ${stage.stats.applied} results compressed, ~${stage.stats.savedTokens} tokens saved`,
			`acp ranges folded: ${acpState.ranges.length}`,
			`session usage: ${usage.outputTokens} output tokens, $${usage.cost.toFixed(4)}`,
		];
		if (composition.totalTokens > 0) {
			const pct = (n: number) => Math.round((n / composition.totalTokens) * 100);
			lines.push(
				"context breakdown (est.):",
				`  tool results  ${fmtK(composition.toolUncompressed)} (${pct(composition.toolUncompressed)}%)`,
				`  ccr markers   ${fmtK(composition.ccrMarkers)} (${pct(composition.ccrMarkers)}%)`,
				`  user msgs     ${fmtK(composition.user)} (${pct(composition.user)}%)`,
				`  assistant     ${fmtK(composition.assistant)} (${pct(composition.assistant)}%)`,
				`  other         ${fmtK(composition.other)} (${pct(composition.other)}%)`,
			);
		}
		return lines.join("\n");
	};

	return {
		async "chat.params"(input) {
			acpState.sessionId = input.sessionID ?? "";
			// Awaited: a floating load would resolve mid-turn and clobber folds
			// pushed by acp_compress with stale disk truth (real race, see tests).
			await loadRanges(acpState.sessionId);
			// Reserve the output budget for OpenAI-family windows (they count
			// output against the limit; Anthropic does not — same rule as
			// acp-kernel's shouldReserveOutputHeadroom). Conservative default.
			const m = input.model;
			const ctx = m?.limit?.context ?? 0;
			const out = m?.limit?.output ?? 0;
			pressure.limit = ctx > 0 && out > 0 && out < ctx && !isAnthropic(m) ? ctx - out : ctx;
		},

		async "experimental.chat.messages.transform"(input, output) {
			void input;
			const msgs = output.messages;

			// Skip opencode's internal agents (title/summary/compaction): these
			// hidden small LLM calls must not be mutated, and letting them write
			// usage/pressure state would corrupt the main session's stats
			// (same failure mode as opencode-acp's Bug 37).
			const lastMsg = msgs[msgs.length - 1];
			const agentName = (lastMsg?.info as { agent?: unknown } | undefined)?.agent;
			if (typeof agentName === "string" && INTERNAL_AGENTS.has(agentName)) return;

			// Real provider-reported usage + composition, recomputed fresh each
			// round (the transform always receives the complete projection).
			usage.contextTokens = 0;
			usage.outputTokens = 0;
			usage.cost = 0;
			resetComposition();
			let estChars = 0;
			for (const msg of msgs) {
				const role = msg.info.role;
				if (role === "assistant") {
					const t = msg.info.tokens;
					if (t) {
						// Chronological walk ⇒ the newest assistant message wins.
						usage.contextTokens = t.input + t.cache.read + t.cache.write;
						usage.outputTokens += t.output;
					}
					usage.cost += msg.info.cost;
				}
				for (const part of msg.parts ?? []) {
					if (part.type === "tool") {
						const out = part.state?.status === "completed" ? part.state.output : undefined;
						if (typeof out !== "string") { composition.other += 40; continue; }
						if (out.includes("Retrieve more: hash=") || out.includes("Retrieve original: hash=")) composition.ccrMarkers += out.length;
						else composition.toolUncompressed += out.length;
						continue;
					}
					const textLen = typeof (part as { text?: unknown }).text === "string" ? ((part as { text: string }).text.length) : 0;
					if (role === "user") composition.user += textLen || 20;
					else if (role === "assistant") composition.assistant += textLen;
					else composition.other += textLen;
				}
			}
			estChars = Math.round((composition.toolUncompressed + composition.ccrMarkers + composition.user + composition.assistant + composition.other) / 4);
			if (estChars > 0 && usage.contextTokens > 0) {
				const scale = usage.contextTokens / estChars;
				composition.toolUncompressed = Math.round((composition.toolUncompressed / 4) * scale);
				composition.ccrMarkers = Math.round((composition.ccrMarkers / 4) * scale);
				composition.user = Math.round((composition.user / 4) * scale);
				composition.assistant = Math.round((composition.assistant / 4) * scale);
				composition.other = Math.round((composition.other / 4) * scale);
				composition.totalTokens = usage.contextTokens;
			}

			// GC safety net before folding: at ≥95% of the window, evict oldest
			// summaries so this round's anchors render as one-liners.
			gcEvictOldestAnchors();

			// Pressure-tier transition toast — fires only when the tier actually
			// worsens AND context grew ≥2% of the window since the last toast
			// (damped: no oscillation spam around a band boundary).
			const tier = computeTier();
			const severity = tier === "aggressive" ? 2 : tier === "elevated" ? 1 : 0;
			if (
				lastTier !== null &&
				severity > lastTier &&
				usage.contextTokens - lastToastTokens >= pressure.limit * 0.02
			) {
				lastToastTokens = usage.contextTokens;
				const pct = Math.round((usage.contextTokens / pressure.limit) * 100);
				const toolPct = composition.totalTokens > 0 ? Math.round(((composition.toolUncompressed + composition.ccrMarkers) / composition.totalTokens) * 100) : 0;
				void client.tui.showToast({
					body: {
						title: `ACP+Headroom: ${tier}`,
						message: `Context at ${pct}% of window; tool results take ~${toolPct}% (${composition.totalTokens.toLocaleString()} tokens). Compression now more aggressive.`,
						variant: tier === "aggressive" ? "warning" : "info",
					},
				}).catch(() => {});
			}
			lastTier = severity;

			// Tool results after the last user message are the model's active
			// working set — never touched.
			let lastUserIdx = -1;
			for (let i = msgs.length - 1; i >= 0; i--) {
				if (msgs[i]!.info.role === "user") { lastUserIdx = i; break; }
			}

			const projected: StageMessage[] = [];
			for (let i = 0; i < lastUserIdx; i++) {
				for (const part of msgs[i]!.parts) {
					if (part.type !== "tool") continue;
					const state = (part as ToolPart).state;
					if (state.status !== "completed") continue;
					projected.push({ id: (part as ToolPart).id, role: "tool", text: state.output, toolName: (part as ToolPart).tool });
				}
			}
			// No early return when projected is empty — stage.apply() no-ops on
			// empty arrays, and the ACP ref/fold pass below must still run.

			// Adapter already filtered by position (i < lastUserIdx), so the
			// stage's own recent-turn guard would double-filter on a projection
			// that contains no user messages.
			const result = await stage.apply(projected, { protectRecent: false });

			if (stage.stats.applied === result.applied && stage.stats.savedTokens > 0) {
				// First compression of the session — one-time heads-up.
				void client.tui.showToast({
					body: { title: "ACP+Headroom", message: `Compressed ${result.applied} tool results (~${stage.stats.savedTokens} tokens saved). Use headroom_retrieve to restore originals.`, variant: "info" },
				}).catch(() => {});
			}

			for (const msg of msgs.slice(0, lastUserIdx)) {
				for (const part of msg.parts) {
					if (part.type !== "tool") continue;
					const p = part as ToolPart;
					const replacement = result.replacements.get(p.id);
					if (replacement !== undefined && p.state.status === "completed") {
						p.state.output = replacement;
						p.state.metadata = { ...(p.state.metadata ?? {}), acpHeadroom: "compressed" };
					}
				}
			}

			// --- ACP: assign refs to older messages, tag visible text, fold ranges ---
			// Runs AFTER mechanical compression so tool-result hashes survive inside
			// folded ranges, and regardless of whether anything compressed above.
			await loadRanges(acpState.sessionId);
			for (let i = 0; i < lastUserIdx; i++) {
				const infoId = (msgs[i]!.info as { id?: string }).id;
				if (infoId && !acpState.refByInfo.has(infoId)) {
					acpState.refByInfo.set(infoId, acpState.nextRef++);
				}
			}
			const refOf = (i: number): number | undefined => {
				const infoId = (msgs[i]!.info as { id?: string }).id;
				return infoId !== undefined ? acpState.refByInfo.get(infoId) : undefined;
			};
			for (let i = 0; i < lastUserIdx; i++) {
				const ref = refOf(i);
				if (ref === undefined) continue;
				for (const part of msgs[i]!.parts ?? []) {
					if (part.type === "tool") {
						if (part.state?.status === "completed" && !part.state.output.startsWith("[m")) {
							part.state.output = `[m${ref}] ${part.state.output}`;
						}
						continue;
					}
					const p = part as { text?: unknown };
					if (typeof p.text === "string" && !p.text.startsWith("[m") && p.text.length > 0) {
						p.text = `[m${ref}] ${p.text}`;
					}
				}
			}
			for (const r of acpState.ranges) {
				// Pass 1: collect in-range parts and every CCR hash found in tool
				// outputs — folding must NOT orphan those retrieval paths (pi keeps
				// hash references alive in summaries too). GC-evicted ranges render
				// as one-liners; their originals stay recoverable via headroom_search.
				const hashes = new Set<string>();
				const inRange: Array<{ kind: "tool" | "text"; tool?: ToolPart; textPart?: { text?: unknown } }> = [];
				for (let i = 0; i < lastUserIdx; i++) {
					const ref = refOf(i);
					if (ref === undefined || ref < r.start || ref > r.end) continue;
					for (const part of msgs[i]!.parts ?? []) {
						if (part.type === "tool") {
							if (part.state?.status === "completed") {
								inRange.push({ kind: "tool", tool: part as ToolPart });
								if (!r.truncated) {
									for (const h of ((part.state as { output?: unknown }).output as string | undefined)?.matchAll(/[a-f0-9]{12,24}/gi) ?? []) {
										hashes.add(h[0].toLowerCase());
									}
								}
							}
							continue;
						}
						const p = part as { text?: unknown };
						if (typeof p.text === "string") inRange.push({ kind: "text", textPart: p });
					}
				}
				// Pass 2: anchor carries the model's summary plus surviving hashes.
				const sumText = r.truncated ? "(summary evicted; originals via headroom_search)" : r.summary;
				const suffix = !r.truncated && hashes.size > 0 ? ` (retrievable via headroom_retrieve: ${Array.from(hashes).slice(0, 20).join(", ")})` : "";
				let anchored = false;
				for (const item of inRange) {
					if (item.kind === "tool") {
						(item.tool!.state as { output: string }).output = `[m${r.start}..m${r.end} folded]`;
						continue;
					}
					item.textPart!.text = anchored ? "" : `[m${r.start}..m${r.end} compressed] ${sumText}${suffix}`;
					anchored = true;
				}
				// Tool-only range: no text part carried the anchor — park it on
				// the first folded result so summary + hashes stay visible.
				if (!anchored) {
					const firstTool = inRange.find((i2) => i2.kind === "tool");
					if (firstTool) {
						(firstTool.tool!.state as { output: string }).output =
							`[m${r.start}..m${r.end} compressed] ${sumText}${suffix}`;
					}
				}
			}
		},

		async "experimental.chat.system.transform"(input, output) {
			void input;
			output.system.push(...SYSTEM_LINES);
			// Nudge signal (ACP model-driven half): when context pressure rises
			// above the comfort zone, tell the model to actively manage context.
			// Damped: same tier re-injects only after ≥10% window growth.
			const tier = computeTier();
			if (
				tier !== "normal" &&
				(tier !== lastNudgeTier || usage.contextTokens - lastNudgeTokens >= pressure.limit * 0.1)
			) {
				lastNudgeTier = tier;
				lastNudgeTokens = usage.contextTokens;
				const pct = pressure.limit > 0 ? Math.round((usage.contextTokens / pressure.limit) * 100) : 0;
				output.system.push(
					`[acp-headroom] Context pressure: ${pct}% of window (${tier}). ` +
					"Actively manage it: call headroom_compress on bulky content before echoing it into replies; " +
					"reference CCR hash markers instead of re-pasting originals; use headroom_search to find details rather than re-reading; call headroom_status if unsure.",
				);
			}
		},

		async "experimental.session.compacting"(input, output) {
			void input;
			// Overflow self-heal, opencode dialect: the summarizer sees compressed
			// markers, not originals — teach it to keep the retrieval paths alive.
			output.context.push(...COMPACTION_LINES);
		},

			config: async (opencodeConfig) => {
			opencodeConfig.command ??= {};
			opencodeConfig.command["headroom-status"] = {
				template: "",
				description: "ACP+Headroom status (instant, no LLM)",
			};
		},

		async "command.execute.before"(input) {
			if (input.command !== "headroom-status") return;
			// Zero-LLM command (opencode-acp dialect): render directly from
			// plugin state, inject as a noReply message, then abort the normal
			// pipeline — no model roundtrip, instant output.
			const text = await renderStatus();
			void client.session
				.prompt({
					path: { id: input.sessionID },
					body: { noReply: true, parts: [{ type: "text", text }] },
				})
				.catch(() => {});
			throw new Error("__ACP_HEADROOM_HANDLED__");
		},

		async event({ event }) {
				if (event.type === "session.created") {
					stage.resetSession();
					acpState.nextRef = 1;
					acpState.refByInfo.clear();
					acpState.ranges.length = 0;
					acpState.loadedFor = ""; // next chat.params reloads (empty) from disk
					lastNudgeTier = "";
					lastNudgeTokens = 0;
				}
			},

		async dispose() {
			stopSpawnedProxies();
		},

		tool: {
			acp_compress: tool({
				description:
					"Compress contiguous ranges of OLDER conversation messages into summaries you write. Reference messages by their [mN] tags (from/to inclusive). Pass `ranges` to fold several consumed stretches in ONE call (saves intermediate inference rounds), or the single from/to/summary form. Use when a whole stretch is consumed — finished explorations, resolved threads, completed phases. Never include the current working set or verbatim-critical user instructions.",
				args: {
					ranges: tool.schema
						.array(
							tool.schema.object({
								from: tool.schema.string().describe("First ref in the range, e.g. \"m12\""),
								to: tool.schema.string().describe("Last ref in the range (inclusive)"),
								summary: tool.schema.string().describe("Your detailed summary preserving decisions, constraints, outcomes and open questions"),
							}),
						)
						.optional()
						.describe("Batch mode: fold multiple ranges in one call; stops at the first invalid range"),
					from: tool.schema.string().optional().describe('Single-range mode: first ref, e.g. "m12"'),
					to: tool.schema.string().optional().describe("Single-range mode: last ref (inclusive)"),
					summary: tool.schema.string().optional().describe("Single-range mode: your summary"),
				},
				async execute(args) {
					const parse = (s: string) => {
						const m = /^m(\d+)$/i.exec(s.trim());
						return m ? Number(m[1]) : null;
					};
					const batch =
						args.ranges ??
						(args.from !== undefined || args.to !== undefined || args.summary !== undefined
							? [{ from: args.from!, to: args.to!, summary: args.summary! }]
							: []);
					if (batch.length === 0) {
						return 'Nothing to fold. Provide ranges:[{from,to,summary},...] or from/to/summary.';
					}
					const results: string[] = [];
					for (const r of batch) {
						const start = parse(r.from);
						const end = parse(r.to);
						if (start === null || end === null || start < 1 || end < start) {
							results.push(`✗ "${r.from}..${r.to}": invalid range (use [mN] tags, from <= to); earlier folds in this call stand.`);
							break;
						}
						if (end >= acpState.nextRef) {
							results.push(`✗ "${r.from}..${r.to}": unknown refs (tags only go up to m${acpState.nextRef - 1}); earlier folds in this call stand.`);
							break;
						}
						let count = 0;
						for (const ref of acpState.refByInfo.values()) {
							if (ref >= start && ref <= end) count++;
						}
						acpState.ranges.push({ start, end, summary: r.summary });
					await saveRanges();
						results.push(`✓ ${r.from}..${r.to} folded (${count} messages)`);
					}
					// Natural distillation: folding a range that overlaps earlier
					// ranges swallows them — no explicit tier machinery needed.
					return `${results.join("\n")}\nSummaries replace their ranges in subsequent context; overlapping folds are absorbed.`;
				},
			}),

			headroom_compress: tool({
				description:
					"Compress a large piece of text through the Headroom proxy right now. Returns a short CCR summary carrying retrieval hashes; the original stays recoverable via headroom_retrieve. Use it to shrink bulky content you are about to echo into your reply.",
				args: {
					text: tool.schema.string().describe("The exact text to compress"),
					tool_name: tool.schema.string().optional().describe("Optional source name for provenance"),
				},
				async execute(args) {
					const cfg = resolveHeadroom(settings());
					const outcome = await compressToolOutput(cfg.proxyUrl, { toolName: args.tool_name ?? "manual", text: args.text, timeoutMs: cfg.timeoutMs });
					if (!outcome || outcome.text.length >= args.text.length) {
						return "Compression not beneficial (proxy unreachable or no size gain); keep the original text.";
					}
					await saveOriginals(outcome.hashes, args.text);
					return `${outcome.text}\n[compressed from ${args.text.length} to ${outcome.text.length} chars; hashes: ${outcome.hashes.join(", ") || "none"}]`;
				},
			}),

			headroom_search: tool({
				description:
					"Full-text search across all compressed-original backups on local disk. Returns ranked hash + snippet hits; pair with headroom_retrieve to expand a hit.",
				args: {
					query: tool.schema.string().describe("Space-separated keywords"),
				},
				async execute(args) {
					const hits = await searchOriginals(args.query);
					if (hits.length === 0) return "No matches in compressed originals.";
					return hits.map((h) => `${h.hash}: …${h.snippet}…`).join("\n");
				},
			}),

			headroom_retrieve: tool({
				description:
					"Retrieve the full original of a compressed tool result by its hash. Use whenever a tool output contains 'Retrieve original: hash=<...>' markers and you need the exact untruncated content.",
				args: { hash: tool.schema.string().describe("The hex hash from a CCR retrieval marker") },
				async execute(args) {
					const cfg = resolveHeadroom(settings());
					const original = await retrieveOriginal(cfg.proxyUrl, args.hash);
					return original ?? `No original found for hash ${args.hash} (expired from proxy cache and local backup).`;
				},
			}),

			headroom_status: tool({
				description: "Report ACP+Headroom compression status: proxy reachability, results compressed this session, estimated tokens saved.",
				args: {},
				execute: renderStatus,
			}),
		},
	};
};
