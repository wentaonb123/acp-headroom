import { type Plugin, tool } from "@opencode-ai/plugin";
import type { ToolPart } from "@opencode-ai/sdk";
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
	ranges: [] as Array<{ start: number; end: number; summary: string }>,
};
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
let lastTier: string | null = null;

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

	return {
		async "chat.params"(input) {
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

			// Pressure-tier transition toast — fires only when the tier actually
			// changes (never on the first round), with a one-line composition.
			const tier = computeTier();
			if (lastTier !== null && tier !== lastTier && pressure.limit > 0) {
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
			lastTier = tier;

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
				let anchored = false;
				for (let i = 0; i < lastUserIdx; i++) {
					const ref = refOf(i);
					if (ref === undefined || ref < r.start || ref > r.end) continue;
					for (const part of msgs[i]!.parts ?? []) {
						if (part.type === "tool") {
							if (part.state?.status === "completed") part.state.output = `[m${r.start}..m${r.end} folded]`;
							continue;
						}
						const p = part as { text?: unknown };
						if (typeof p.text !== "string") continue;
						p.text = anchored ? "" : `[m${r.start}..m${r.end} compressed] ${r.summary}`;
						anchored = true;
					}
				}
			}
		},

		async "experimental.chat.system.transform"(input, output) {
			void input;
			output.system.push(...SYSTEM_LINES);
			// Nudge signal (ACP model-driven half): when context pressure rises
			// above the comfort zone, tell the model to actively manage context.
			const tier = computeTier();
			if (tier !== "normal") {
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

			async event({ event }) {
				if (event.type === "session.created") {
					stage.resetSession();
					acpState.nextRef = 1;
					acpState.refByInfo.clear();
					acpState.ranges.length = 0;
				}
			},

		async dispose() {
			stopSpawnedProxies();
		},

		tool: {
			acp_compress: tool({
				description:
					"Compress a contiguous range of OLDER conversation messages into one summary you write. Reference messages by their [mN] tags (from/to inclusive). Use when the whole range is consumed — finished explorations, resolved threads, completed phases. Never include the current working set or verbatim-critical user instructions.",
				args: {
					from: tool.schema.string().describe("First ref in the range, e.g. \"m12\""),
					to: tool.schema.string().describe("Last ref in the range (inclusive), e.g. \"m40\""),
					summary: tool.schema.string().describe("Your detailed summary preserving decisions, constraints, outcomes and open questions"),
				},
				async execute(args) {
					const parse = (s: string) => {
						const m = /^m(\d+)$/i.exec(s.trim());
						return m ? Number(m[1]) : null;
					};
					const start = parse(args.from);
					const end = parse(args.to);
					if (start === null || end === null || start < 1 || end < start) {
						return `Invalid range "${args.from}..${args.to}". Use [mN] tags, from <= to.`;
					}
					if (end >= acpState.nextRef) {
						return `Unknown refs: tags only go up to m${acpState.nextRef - 1}.`;
					}
					let count = 0;
					for (const ref of acpState.refByInfo.values()) {
						if (ref >= start && ref <= end) count++;
					}
					acpState.ranges.push({ start, end, summary: args.summary });
					// Natural distillation: folding a range that overlaps earlier
					// ranges swallows them — no explicit tier machinery needed.
					return `Range ${args.from}..${args.to} folded (${count} messages). The summary replaces it in subsequent context; earlier overlapping folds are absorbed.`;
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
				async execute() {
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
				},
			}),
		},
	};
};
