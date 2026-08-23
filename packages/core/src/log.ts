/** Tiny stderr logger, gated by ACP_HEADROOM_DEBUG — hosts with real logging
 *  (pi log file, opencode client.app.log) wrap or ignore these; core stays
 *  dependency-free. */
export function logWarn(scope: string, event: Record<string, unknown>): void {
	if (!process.env.ACP_HEADROOM_DEBUG) return;
	console.error(`[acp-headroom][${scope}]`, JSON.stringify(event));
}
