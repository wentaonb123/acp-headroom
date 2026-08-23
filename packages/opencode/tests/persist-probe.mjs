process.env.HEADROOM_RANGES_DIR = process.env.HEADROOM_RANGES_DIR || "D:/tmp/acp-ranges-dbg";
import { AcpHeadroomPlugin } from "../dist/index.js";

const hooks = await AcpHeadroomPlugin({ client: { tui: { showToast: async () => {} } }, project: {}, directory: ".", worktree: ".", $: {}, serverUrl: new URL("http://127.0.0.1:1") });
const mk = (id) => ({ info: { id, role: "assistant", cost: 0, tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [{ type: "text", text: `content of ${id}` }] });
await hooks["chat.params"]({ sessionID: "dbg-1", model: { id: "m", providerID: "p", limit: { context: 1000000 } } }, {});
const output = { messages: [mk("d1"), mk("d2"), { info: { role: "user" }, parts: [] }] };
await hooks["experimental.chat.messages.transform"]({}, output);
console.log("tagged:", JSON.stringify(output.messages[0].parts[0].text));
const r1 = Number(/\[m(\d+)\]/.exec(output.messages[0].parts[0].text)[1]);
const res = await hooks.tool.acp_compress.execute({ from: `m${r1}`, to: `m${r1 + 1}`, summary: "debug fold" });
console.log("compress result:", JSON.stringify(res));
const fs = await import("node:fs");
console.log("dir exists:", fs.existsSync(process.env.HEADROOM_RANGES_DIR), fs.readdirSync(process.env.HEADROOM_RANGES_DIR).length ? fs.readdirSync(process.env.HEADROOM_RANGES_DIR) : "(empty)");
try { console.log("file:", fs.readFileSync(process.env.HEADROOM_RANGES_DIR + "/dbg-1.json", "utf8")); } catch (e) { console.log("read failed:", e.message); }
