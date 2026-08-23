/** Host-neutral Headroom settings. Hosts embed this in their own config files
 *  (pi: acp.json `headroom` key; opencode: env or plugin opts). */
export interface HeadroomSettings {
	enabled?: boolean;
	/** Base URL of the local Headroom compression proxy. Default:
	 *  env HEADROOM_PROXY_URL > "http://127.0.0.1:8787". */
	proxyUrl?: string;
	/** Minimum tool-result text length (chars) before compression is attempted.
	 *  Default: 4000 (~1K tokens). */
	minChars?: number;
	/** Max proxy calls per apply round (latency cap). Largest results are
	 *  prioritized. Default: 8. */
	maxPerTurn?: number;
	/** Per-request timeout to the proxy. On timeout/absence the original text
	 *  passes through uncompressed (fail-open). Default: 3000. */
	timeoutMs?: number;
	/** Tool names whose outputs must never be compressed (merged with the
	 *  built-in default list). */
	protectedTools?: string[];
	/** Try to spawn the proxy when it is not reachable at startup.
	 *  Default: true. */
	autoStart?: boolean;
}

export interface ResolvedHeadroomConfig {
	enabled: boolean;
	proxyUrl: string;
	minChars: number;
	maxPerTurn: number;
	timeoutMs: number;
	protectedTools: string[];
	autoStart: boolean;
}

/** Tools defined by this package family — their outputs are markers/stats,
 *  never compressible payloads. Hosts add their own via settings.protectedTools. */
export const DEFAULT_PROTECTED_TOOLS = ["headroom_compress", "headroom_status", "headroom_retrieve"];

export const DEFAULT_HEADROOM_CONFIG: ResolvedHeadroomConfig = {
	enabled: true,
	proxyUrl: "http://127.0.0.1:8787",
	minChars: 4000,
	maxPerTurn: 8,
	timeoutMs: 3000,
	protectedTools: DEFAULT_PROTECTED_TOOLS,
	autoStart: true,
};

export function resolveHeadroom(settings: HeadroomSettings | false | undefined | null): ResolvedHeadroomConfig {
	if (settings === false) return { ...DEFAULT_HEADROOM_CONFIG, enabled: false };
	const s = typeof settings === "object" && settings !== null ? settings : {};
	return {
		enabled: s.enabled !== false,
		proxyUrl: normalizeBase(process.env.HEADROOM_PROXY_URL ?? s.proxyUrl ?? DEFAULT_HEADROOM_CONFIG.proxyUrl),
		minChars: posInt(s.minChars, DEFAULT_HEADROOM_CONFIG.minChars),
		maxPerTurn: posInt(s.maxPerTurn, DEFAULT_HEADROOM_CONFIG.maxPerTurn),
		timeoutMs: posInt(s.timeoutMs, DEFAULT_HEADROOM_CONFIG.timeoutMs),
		protectedTools: unique([...DEFAULT_PROTECTED_TOOLS, ...(Array.isArray(s.protectedTools) ? s.protectedTools.filter((t): t is string => typeof t === "string") : [])]),
		autoStart: s.autoStart !== false,
	};
}

function posInt(v: unknown, fallback: number): number {
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

function normalizeBase(url: string): string {
	return url.replace(/\/+$/, "");
}

function unique(items: string[]): string[] {
	return [...new Set(items)];
}
