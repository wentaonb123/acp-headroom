import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const LOG = new URL("./mock-proxy.log", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const log = (m) => { console.log(m); try { appendFileSync(LOG, m + "\n"); } catch {} };

createServer((req, res) => {
	log(`${new Date().toISOString()} ${req.method} ${req.url}`);
	if (req.url === "/health") { res.writeHead(200).end("ok"); return; }
	if (req.url === "/v1/compress") {
		let body = "";
		req.on("data", (c) => { body += c; });
		req.on("end", () => {
			log(`  payload bytes=${body.length} head=${JSON.stringify(body.slice(0, 120))}`);
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
				messages: [{ role: "tool", content: "[compressed] Retrieve original: hash=feedface0001 (local-test mock; call headroom_retrieve if you need the original)" }],
				tokens_before: Math.round(body.length / 4),
				tokens_after: 40,
				ccr_hashes: ["feedface0001"],
			}));
		});
		return;
	}
	res.writeHead(404).end();
}).listen(8787, "127.0.0.1", () => log("[mock] listening on http://127.0.0.1:8787"));
