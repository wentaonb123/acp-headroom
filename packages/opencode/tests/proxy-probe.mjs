import { compressToolOutput } from "acp-headroom-core";
import { readFileSync } from "node:fs";

const proxy = "http://127.0.0.1:8787";
const samples = {
	"log-lines": readFileSync("C:/Users/12546/.acp-headroom/ccr/a796ac917fe8d0b44166facc.txt", "utf8"),
	"minified-js": readFileSync("D:/work/pi-acm/acp-headroom/packages/core/dist/index.js", "utf8"),
	"json-config": JSON.stringify({ mcp: { serena: { command: ["uvx", "serena"] } }, plugin: ["x", "y"], provider: { a: { b: 1, c: 2 } } }).repeat(80),
};

for (const [name, text] of Object.entries(samples)) {
	const t0 = Date.now();
	const out = await compressToolOutput(proxy, { toolName: "bash", text, timeoutMs: 10000 });
	const ms = Date.now() - t0;
	if (!out) { console.log(`${name}: NULL (${ms}ms)`); continue; }
	console.log(`${name}: ${text.length} -> ${out.text.length} chars (${Math.round(text.length / Math.max(1, out.text.length))}x) in ${ms}ms`);
	console.log(`  hashes=${out.hashes.length} tokens=${out.tokensBefore}->${out.tokensAfter}`);
	console.log(`  head=${JSON.stringify(out.text.slice(0, 140))}`);
}
