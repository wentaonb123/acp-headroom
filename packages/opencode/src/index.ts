import { type Plugin, tool } from "@opencode-ai/plugin";
import type { ToolPart } from "@opencode-ai/sdk";
import { HeadroomStage, originOf, proxyHealthy, resolveHeadroom, retrieveOriginal, type StageMessage } from "acp-headroom-core";

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

const settings = () => ({
	proxyUrl: process.env.HEADROOM_PROXY_URL,
	minChars: numEnv("HEADROOM_MIN_CHARS"),
	autoStart: process.env.HEADROOM_AUTOSTART !== "0",
});

function numEnv(name: string): number | undefined {
	const v = Number(process.env[name]);
	return Number.isFinite(v) && v > 0 ? v : undefined;
}

const SYSTEM_LINES = [
	"Large tool results may be mechanically compressed into CCR markers containing hashes.",
	"When you need exact content from a compressed result, call headroom_retrieve with the hash from its 'Retrieve original: hash=<...>' marker.",
];

export const AcpHeadroomPlugin: Plugin = async ({ client }) => {
	const stage = new HeadroomStage(settings);

	// Real provider-reported usage, refreshed on every LLM call by the
	// messages transform (opencode gives exact numbers — no chars/4 guessing).
	const usage = { contextTokens: 0, outputTokens: 0, cost: 0 };

	return {
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

			const result = await stage.apply(projected);
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

		tool: {
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
					return [
						`enabled: ${cfg.enabled}`,
						`proxy: ${originOf(cfg.proxyUrl)} (${healthy ? "healthy" : "unreachable"})`,
						`minChars: ${cfg.minChars}, timeoutMs: ${cfg.timeoutMs}, autoStart: ${cfg.autoStart}`,
						`session stats: ${stage.stats.applied} results compressed, ~${stage.stats.savedTokens} tokens saved`,
						`context at last LLM call: ${usage.contextTokens} input tokens (provider-reported)`,
						`session usage: ${usage.outputTokens} output tokens, $${usage.cost.toFixed(4)}`,
					].join("\n");
				},
			}),
		},
	};
};
