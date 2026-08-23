import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { after, before, describe, it } from "node:test";
import { AcpHeadroomPlugin } from "../dist/index.js";

const BIG_TEXT = "x".repeat(6000);
const HASH12 = "a1b2c3d4e5f6";

let server: Server;
let port = 0;
let compressCalls = 0;

before(async () => {
	server = createServer((req, res) => {
		const url = req.url ?? "";
		if (url === "/health") {
			res.writeHead(200).end("ok");
			return;
		}
		if (url === "/v1/compress") {
			compressCalls += 1;
			let body = "";
			req.on("data", (c: Buffer) => { body += c.toString(); });
			req.on("end", () => {
				void body;
				res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
					messages: [{ role: "tool", content: `[compressed] Retrieve original: hash=${HASH12}` }],
					tokens_before: 1500,
					tokens_after: 20,
					ccr_hashes: [HASH12],
				}));
			});
			return;
		}
		res.writeHead(404).end();
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const addr = server.address();
	assert.ok(addr && typeof addr === "object");
	port = addr.port;
	process.env.HEADROOM_PROXY_URL = `http://127.0.0.1:${port}`;
	process.env.HEADROOM_AUTOSTART = "0";
	process.env.ACP_HEADROOM_DEBUG = "1";
	// Isolate CCR backups — never touch the real ~/.acp-headroom/ccr.
	process.env.HEADROOM_CCR_DIR = mkdtempSync(tmpdir() + "/acp-headroom-test-");
});

after(() => new Promise<void>((r) => server.close(() => r())));

function assistantMessage(tokens: { input: number; output: number }, cost = 0.01): any {
	return {
		info: {
			id: "m" + Math.random().toString(36).slice(2),
			role: "assistant",
			cost,
			tokens: { input: tokens.input, output: tokens.output, reasoning: 0, cache: { read: 500, write: 0 } },
		},
		parts: [],
	};
}

function toolPart(id: string, toolName: string, output: string): any {
	return {
		id,
		type: "tool",
		tool: toolName,
		state: { status: "completed", input: {}, output, title: toolName, metadata: {}, time: { start: 0, end: 1 } },
	};
}

async function loadPlugin() {
	const toasts: unknown[] = [];
	const hooks = await AcpHeadroomPlugin({
		client: { tui: { showToast: async (opts: any) => { toasts.push(opts?.body?.message); } } },
		project: {} as any,
		directory: ".",
		worktree: ".",
		$: {} as any,
		serverUrl: new URL("http://127.0.0.1:1"),
	} as any);
	return { hooks, toasts };
}

// One instance across all tests — matches real opencode (loaded once per
// server) and lets later tests observe earlier rounds' accumulated stats.
const ctx = await loadPlugin();

describe("acp-headroom-opencode plugin", () => {
	it("compresses completed tool parts older than the last user message", async () => {
		const { hooks } = ctx;
		const output = {
			messages: [
				assistantMessage({ input: 12000, output: 300 }),
				{ info: { role: "assistant", cost: 0.01, tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [toolPart("p1", "read", BIG_TEXT)] },
				assistantMessage({ input: 13000, output: 400 }),
				{ info: { role: "user" }, parts: [] },
				{ info: { role: "assistant", cost: 0.02, tokens: { input: 14000, output: 60, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [toolPart("p2", "read", BIG_TEXT)] },
			],
		} as any;

		await (hooks as any)["experimental.chat.messages.transform"]({}, output);

		// p1 sits before the final user message → compressed.
		const p1 = output.messages[1].parts[0];
		assert.match(p1.state.output, /Retrieve original: hash=a1b2c3d4e5f6/);
		assert.equal(p1.state.metadata.acpHeadroom, "compressed");
		assert.ok(compressCalls >= 1);

		// p2 comes after the last user message → untouched working set.
		const p2 = output.messages[4].parts[0];
		assert.equal(p2.state.output, BIG_TEXT);
	});

	it("reports provider-reported usage in headroom_status", async () => {
		const { hooks } = ctx;
		const status = await (hooks as any).tool.headroom_status.execute({});
		assert.match(status, /context at last LLM call: 14000 input tokens/); // newest assistant wins
		assert.match(status, /1 results compressed/);
		assert.match(status, /session usage: 810 output tokens, \$0\.05/);
	});

	it("injects marker-usage instructions into the system prompt", async () => {
		const { hooks } = ctx;
		const output = { system: ["base"] } as any;
		await (hooks as any)["experimental.chat.system.transform"]({}, output);
		assert.equal(output.system.length, 4); // base + 3 instruction lines
		assert.ok(output.system.some((l: string) => l.includes("headroom_retrieve")));
	});

	it("headroom_retrieve fails open with a friendly message", async () => {
		const { hooks } = ctx;
		const result = await (hooks as any).tool.headroom_retrieve.execute({ hash: "000000000000" });
		assert.match(result, /No original found/);
	});

	it("adaptive pressure escalates as context fills toward the model limit", async () => {
		const { hooks } = ctx;
		await (hooks as any)["chat.params"]({ model: { id: "m", providerID: "p", limit: { context: 200_000 } } }, {});

		// Normal zone (30%).
		let output = {
			messages: [
				{ info: { role: "assistant", cost: 0, tokens: { input: 59_500, output: 0, reasoning: 0, cache: { read: 500, write: 0 } } }, parts: [] },
			],
		} as any;
		await (hooks as any)["experimental.chat.messages.transform"]({}, output);
		let status = await (hooks as any).tool.headroom_status.execute({});
		assert.match(status, /30% \[normal\]/);
		assert.match(status, /minChars: 4000/);

		// Aggressive zone (90%): minChars drops from default 4000 to 800.
		output = {
			messages: [
				{ info: { role: "assistant", cost: 0, tokens: { input: 179_500, output: 0, reasoning: 0, cache: { read: 500, write: 0 } } }, parts: [] },
			],
		} as any;
		await (hooks as any)["experimental.chat.messages.transform"]({}, output);
		status = await (hooks as any).tool.headroom_status.execute({});
		assert.match(status, /90% \[aggressive\]/);
		assert.match(status, /minChars: 800/);
	});

	it("nudge signal appears in system prompt only under pressure", async () => {
		const { hooks } = ctx;
		const sysOut = { system: [] as string[] } as any;

		// Comfortable zone: static lines only, no nudge.
		await (hooks as any)["chat.params"]({ model: { id: "m", providerID: "p", limit: { context: 1_000_000 } } }, {});
		await (hooks as any)["experimental.chat.messages.transform"]({}, {
			messages: [{ info: { role: "assistant", cost: 0, tokens: { input: 100_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [] }],
		} as any);
		await (hooks as any)["experimental.chat.system.transform"]({}, sysOut);
		assert.ok(!sysOut.system.some((l: string) => l.includes("Context pressure")), "no nudge at low pressure");

		// Elevated zone (65%): nudge line injected.
		await (hooks as any)["experimental.chat.messages.transform"]({}, {
			messages: [{ info: { role: "assistant", cost: 0, tokens: { input: 649_000, output: 0, reasoning: 0, cache: { read: 1000, write: 0 } } }, parts: [] }],
		} as any);
		const sysOut2 = { system: [] as string[] } as any;
		await (hooks as any)["experimental.chat.system.transform"]({}, sysOut2);
		const nudge = sysOut2.system.find((l: string) => l.includes("Context pressure"));
		assert.ok(nudge, "nudge present under elevated pressure");
		assert.match(nudge!, /65%.*elevated/);
	});

	it("compaction hook injects hash-preservation instructions", async () => {
		const { hooks } = ctx;
		const output = { context: [] as string[], prompt: undefined } as any;
		await (hooks as any)["experimental.session.compacting"]({ sessionID: "s1" }, output);
		assert.equal(output.context.length, 2);
		assert.ok(output.context.some((l: string) => l.includes("headroom_retrieve")));
	});

	it("tracks context composition and reports the breakdown", async () => {
		const { hooks } = ctx;
		const bigTool = "y".repeat(8000);
		const output = {
			messages: [
				{ info: { role: "user" }, parts: [{ type: "text", text: "hello world ".repeat(100) }] },
				{ info: { role: "assistant", cost: 0, tokens: { input: 10_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [{ type: "text", text: "assistant reply ".repeat(50) }, toolPart("p9", "bash", bigTool)] },
				{ info: { role: "user" }, parts: [] },
			],
		} as any;
		await (hooks as any)["experimental.chat.messages.transform"]({}, output);
		const status = await (hooks as any).tool.headroom_status.execute({});
		assert.match(status, /context breakdown \(est\.\):/);
		assert.match(status, /ccr markers\s+\d/);
		assert.match(status, /user msgs\s+\d/);
	});

	it("fires a toast only when the pressure tier changes", async () => {
		const { hooks, toasts } = ctx;
		const before = toasts.length;
		const round = (inputTokens: number) => (hooks as any)["experimental.chat.messages.transform"]({}, {
			messages: [
				{ info: { role: "assistant", cost: 0, tokens: { input: inputTokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [] },
			],
		} as any);
		await (hooks as any)["chat.params"]({ model: { id: "m", providerID: "p", limit: { context: 100_000 } } }, {});
		await round(10_000);   // normal → normal: no toast
		assert.equal(toasts.length, before);
		await round(85_000);   // normal → aggressive: toast
		assert.equal(toasts.length, before + 1);
		const body = JSON.stringify(toasts[toasts.length - 1]);
		assert.ok(body.includes("aggressive"), body);
	});

	it("headroom_compress compresses on demand and saves the original", async () => {
		const { hooks } = ctx;
		const result = await (hooks as any).tool.headroom_compress.execute({ text: BIG_TEXT, tool_name: "read" });
		assert.match(result, /Retrieve original: hash=a1b2c3d4e5f6/);
		assert.match(result, /compressed from 6000 to \d+ chars/);
	});

	it("headroom_search finds saved originals by keyword", async () => {
		const { hooks } = ctx;
		const result = await (hooks as any).tool.headroom_search.execute({ query: "xxxxx" });
		assert.match(result, /a1b2c3d4e5f6: /);
		const miss = await (hooks as any).tool.headroom_search.execute({ query: "zzz-not-there" });
		assert.match(miss, /No matches/);
	});

	it("registers exactly the four model-facing tools", async () => {
		const { hooks } = ctx;
		assert.deepEqual(
			Object.keys((hooks as any).tool).sort(),
			["headroom_compress", "headroom_retrieve", "headroom_search", "headroom_status"],
		);
		await (hooks as any).dispose();
	});
});
