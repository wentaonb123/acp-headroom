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
		if (ratio >= 0.8) return { ...base, minChars: 800, maxPerTurn: 24 };
		if (ratio >= 0.6) return { ...base, minChars: 2000, maxPerTurn: 12 };
	}
	return base;
};

function numEnv(name: string): number | undefined {
	const v = Number(process.env[name]);
	return Number.isFinite(v) && v > 0 ? v : undefined;
}

// Per-instance runtime state (one plugin instance per opencode server):
// real provider-reported usage refreshed each LLM call, plus the active
// model's context window limit captured from chat.params.
const usage = { contextTokens: 0, outputTokens: 0, cost: 0 };
const pressure = { limit: 0 };

const SYSTEM_LINES = [
	"Large tool results may be mechanically compressed into short summaries carrying CCR retrieval hashes (marker formats: 'Retrieve more: hash=<hex>' or 'Retrieve original: hash=<hex>').",
	"When you need the exact full content of a compressed result, call headroom_retrieve with the hex hash from its marker.",
	"To find something you only vaguely remember from an older tool output, call headroom_search with keywords instead of guessing hashes.",
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
			pressure.limit = input.model?.limit?.context ?? 0;
		},

		async "experimental.chat.messages.transform"(input, output) {
			void input;
			const msgs = output.messages;

			// Real provider-reported usage: context fullness from the newest
			// assistant message, session totals recomputed fresh each round (the
			// transform always receives the complete projected conversation).
			usage.contextTokens = 0;
			usage.outputTokens = 0;
			usage.cost = 0;
			for (const msg of msgs) {
				if (msg.info.role !== "assistant") continue;
				const t = msg.info.tokens;
				if (t) {
					// Chronological walk ⇒ the newest assistant message wins.
					usage.contextTokens = t.input + t.cache.read + t.cache.write;
					usage.outputTokens += t.output;
				}
				usage.cost += msg.info.cost;
			}

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
			if (projected.length === 0) return;

			// Adapter already filtered by position (i < lastUserIdx), so the
			// stage's own recent-turn guard would double-filter on a projection
			// that contains no user messages.
			const result = await stage.apply(projected, { protectRecent: false });
			if (result.replacements.size === 0) return;

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
		},

		async "experimental.chat.system.transform"(input, output) {
			void input;
			output.system.push(...SYSTEM_LINES);
		},

		async "experimental.session.compacting"(input, output) {
			void input;
			// Overflow self-heal, opencode dialect: the summarizer sees compressed
			// markers, not originals — teach it to keep the retrieval paths alive.
			output.context.push(...COMPACTION_LINES);
		},

		async event({ event }) {
			if (event.type === "session.created") stage.resetSession();
		},

		async dispose() {
			stopSpawnedProxies();
		},

		tool: {
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
					const tier = ratio >= 0.8 ? "aggressive" : ratio >= 0.6 ? "elevated" : "normal";
					return [
						`enabled: ${cfg.enabled}`,
						`proxy: ${originOf(cfg.proxyUrl)} (${healthy ? "healthy" : "unreachable"})`,
						`minChars: ${cfg.minChars}, maxPerTurn: ${cfg.maxPerTurn}, timeoutMs: ${cfg.timeoutMs}, autoStart: ${cfg.autoStart}`,
						`context at last LLM call: ${usage.contextTokens} input tokens (provider-reported)` + (pressure.limit > 0 ? ` / ${pressure.limit} = ${(ratio * 100).toFixed(0)}% [${tier}]` : ""),
						`session stats: ${stage.stats.applied} results compressed, ~${stage.stats.savedTokens} tokens saved`,
						`session usage: ${usage.outputTokens} output tokens, $${usage.cost.toFixed(4)}`,
					].join("\n");
				},
			}),
		},
	};
};
