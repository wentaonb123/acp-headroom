import { createHash } from "node:crypto";
import { resolveHeadroom, type HeadroomSettings, type ResolvedHeadroomConfig } from "./config.js";
import { compressToolOutput, originOf, proxyHealthy, saveOriginals, startProxy } from "./client.js";
import { logWarn } from "./log.js";

/** Minimal message view hosts must project their tool results into.
 *  pi projects CoreMessage; opencode feeds per-result calls via its adapter. */
export interface StageMessage {
	id: string;
	role: string;
	text?: string;
	toolName?: string;
}

/** Canonical CCR retrieval-marker prefixes the proxy embeds in compressed
 *  text (see headroom transforms/content_router.py). A tool result carrying
 *  one is already compressed — never send it again. */
const ALREADY_COMPRESSED = ["Retrieve more: hash=", "Retrieve original: hash=", "<<ccr:"];

export interface HeadroomStats {
	applied: number;
	savedTokens: number;
}

export interface HeadroomApplyResult {
	/** Message id → compressed replacement text. Caller substitutes into its
	 *  own message structure before sending to the LLM. */
	replacements: Map<string, string>;
	applied: number;
	savedTokens: number;
	/** False only when the proxy was unreachable this round. */
	available: boolean;
}

/** Fresh result object per call — a shared constant would hand every caller
 *  the same Map instance. */
function emptyResult(): HeadroomApplyResult {
	return { replacements: new Map(), applied: 0, savedTokens: 0, available: true };
}

interface CacheEntry {
	text: string;
	tokensBefore: number;
	tokensAfter: number;
	hashes: string[];
}

// ponytail: naive clear at 500 entries — a session's candidates are far fewer;
// swap for LRU only if a months-long session ever shows re-compression cost.
const CACHE_MAX = 500;

export class HeadroomStage {
	stats: HeadroomStats = { applied: 0, savedTokens: 0 };
	private cache = new Map<string, CacheEntry>();
	private proxyTried = false;
	private unavailableNotified = false;

	constructor(readonly getSettings: () => HeadroomSettings | false | undefined | null = () => undefined) {}

	resetSession(): void {
		this.stats = { applied: 0, savedTokens: 0 };
		this.cache.clear();
		this.proxyTried = false;
		this.unavailableNotified = false;
	}

	/** Compress oversized tool results. Returns id → replacement text; never
	 *  throws (fail-open). */
	async apply(coreMessages: StageMessage[]): Promise<HeadroomApplyResult> {
		const cfg = resolveHeadroom(this.getSettings());
		if (!cfg.enabled || coreMessages.length === 0) return emptyResult();
		try {
			return await this.applyInner(coreMessages, cfg);
		} catch (e) {
			logWarn("headroom", { event: "stage-error", error: e instanceof Error ? e.message : String(e) });
			return emptyResult();
		}
	}

	private async applyInner(coreMessages: StageMessage[], cfg: ResolvedHeadroomConfig): Promise<HeadroomApplyResult> {
		if (!(await this.ensureProxy(cfg))) return { ...emptyResult(), available: false };

		const modelId = "default";

		// Current-turn results are the model's active working set — never touched.
		let lastUserIdx = -1;
		for (let i = coreMessages.length - 1; i >= 0; i--) {
			if (coreMessages[i]!.role === "user") { lastUserIdx = i; break; }
		}

		const candidates = coreMessages
			.map((m, index) => ({ m, index }))
			.filter(({ m, index }) =>
				m.role === "tool"
				&& typeof m.text === "string"
				&& m.text.length >= cfg.minChars
				&& !cfg.protectedTools.includes(m.toolName ?? "")
				&& index < lastUserIdx
				&& !ALREADY_COMPRESSED.some((marker) => m.text!.includes(marker)));

		if (candidates.length === 0) return emptyResult();

		// Latency cap: only the largest results within the per-round budget.
		const budget = new Set(
			[...candidates]
				.sort((a, b) => b.m.text!.length - a.m.text!.length)
				.slice(0, cfg.maxPerTurn)
				.map(({ index }) => index),
		);

		const result: HeadroomApplyResult = { replacements: new Map(), applied: 0, savedTokens: 0, available: true };
		// Cache key includes proxy origin + modelId: the compressed output (and
		// its CCR hashes) belong to whichever proxy produced them, so a
		// mid-session config change must not keep serving stale entries.
		const cachePrefix = `${originOf(cfg.proxyUrl)}|${modelId}|`;
		for (const { m, index } of candidates) {
			if (!budget.has(index)) continue;
			const text = m.text!;
			const key = `${cachePrefix}${sha256(text)}`;
			let entry = this.cache.get(key);
			if (!entry) {
				const outcome = await compressToolOutput(cfg.proxyUrl, { toolName: m.toolName ?? "", text, model: modelId, timeoutMs: cfg.timeoutMs });
				if (!outcome || outcome.text.length >= text.length) continue;
				entry = { text: outcome.text, tokensBefore: outcome.tokensBefore, tokensAfter: outcome.tokensAfter, hashes: outcome.hashes };
				if (this.cache.size >= CACHE_MAX) this.cache.clear();
				this.cache.set(key, entry);
				await saveOriginals(entry.hashes, text);
			}
			result.replacements.set(m.id, entry.text);
			result.applied += 1;
			result.savedTokens += Math.max(0, estimate(entry.tokensBefore, text) - estimate(entry.tokensAfter, entry.text));
		}
		if (result.applied > 0) {
			this.stats.applied += result.applied;
			this.stats.savedTokens += result.savedTokens;
			logWarn("headroom", { event: "applied", count: result.applied, savedTokens: result.savedTokens });
		}
		return result;
	}

	/** Called by host startup after its own spawn attempt so request-path
	 *  ensureProxy() never blocks on startProxy polling (up to 40s when the
	 *  binary is absent) — it only fast health-checks afterwards. */
	markProxyAttempted(): void {
		this.proxyTried = true;
	}

	/** Compress a single result right now (execute-time mode used by hosts
	 *  without a pre-LLM context hook). Returns the replacement text or null
	 *  when the result should pass through untouched. Never throws. */
	async applyOne(toolName: string, text: string): Promise<string | null> {
		const cfg = resolveHeadroom(this.getSettings());
		if (!cfg.enabled || typeof text !== "string" || text.length < cfg.minChars) return null;
		if (cfg.protectedTools.includes(toolName)) return null;
		if (ALREADY_COMPRESSED.some((marker) => text.includes(marker))) return null;
		try {
			if (!(await this.ensureProxy(cfg))) return null;
			const outcome = await compressToolOutput(cfg.proxyUrl, { toolName, text, model: "default", timeoutMs: cfg.timeoutMs });
			if (!outcome || outcome.text.length >= text.length) return null;
			await saveOriginals(outcome.hashes, text);
			const key = `${originOf(cfg.proxyUrl)}|default|${sha256(text)}`;
			this.cache.set(key, { text: outcome.text, tokensBefore: outcome.tokensBefore, tokensAfter: outcome.tokensAfter, hashes: outcome.hashes });
			this.stats.applied += 1;
			this.stats.savedTokens += Math.max(0, estimate(outcome.tokensBefore, text) - estimate(outcome.tokensAfter, outcome.text));
			return outcome.text;
		} catch (e) {
			logWarn("headroom", { event: "apply-one-error", error: e instanceof Error ? e.message : String(e) });
			return null;
		}
	}

	private async ensureProxy(cfg: ResolvedHeadroomConfig): Promise<boolean> {
		if (await proxyHealthy(cfg.proxyUrl)) return true;
		if (cfg.autoStart && !this.proxyTried) {
			this.proxyTried = true;
			if (await startProxy(cfg.proxyUrl)) return true;
		}
		if (!this.unavailableNotified) {
			this.unavailableNotified = true;
			logWarn("headroom", { event: "proxy-unavailable", proxyUrl: cfg.proxyUrl, effect: "pass-through-uncompressed" });
		}
		return false;
	}
}

/** Prefer the proxy's tokenizer-backed counts; fall back to chars/4. */
function estimate(tokens: number, text: string): number {
	return tokens > 0 ? tokens : Math.ceil(text.length / 4);
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}
