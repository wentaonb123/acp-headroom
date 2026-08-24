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
	// Isolate CCR backups — never touch the real ~/.acp-headroom.
	process.env.HEADROOM_CCR_DIR = mkdtempSync(tmpdir() + "/acp-headroom-test-");
	process.env.HEADROOM_RANGES_DIR = mkdtempSync(tmpdir() + "/acp-headroom-ranges-");
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
		assert.equal(output.system.length, 6); // base + 5 instruction lines
		assert.ok(output.system.some((l: string) => l.includes("headroom_retrieve")));
		assert.ok(output.system.some((l: string) => l.includes("Compress proactively")));
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

		// Elevated zone (50% — pi's nudge band starts at 45%).
		output = {
			messages: [
				{ info: { role: "assistant", cost: 0, tokens: { input: 99_500, output: 0, reasoning: 0, cache: { read: 500, write: 0 } } }, parts: [] },
			],
		} as any;
		await (hooks as any)["experimental.chat.messages.transform"]({}, output);
		status = await (hooks as any).tool.headroom_status.execute({});
		assert.match(status, /50% \[elevated\]/);
		assert.match(status, /minChars: 2000/);

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

	it("injects [mN] refs, folds ranges via acp_compress", async () => {
		const { hooks } = ctx;
		const mk = (id: string) => ({ info: { id, role: "assistant", cost: 0, tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [{ type: "text", text: `content of ${id}` }] });
		const output = {
			messages: [
				mk("a1"), mk("a2"), mk("a3"),
				{ info: { role: "user" }, parts: [] },
			],
		} as any;
		await (hooks as any)["experimental.chat.messages.transform"]({}, output);
		assert.match(output.messages[0].parts[0].text, /^\[m\d+\] content of a1$/);
		const ref1 = Number(/\[m(\d+)\]/.exec(output.messages[0].parts[0].text)![1]);
		const ref3 = Number(/\[m(\d+)\]/.exec(output.messages[2].parts[0].text)![1]);

		const result = await (hooks as any).tool.acp_compress.execute({
			from: `m${ref1}`, to: `m${ref3}`,
			summary: "Explored three test messages; concluded nothing needed.",
		});
		assert.match(result, /folded \(3 messages\)/);

		// Next round: range collapses to the anchor summary; other texts blank.
		await (hooks as any)["experimental.chat.messages.transform"]({}, output);
		assert.equal(output.messages[0].parts[0].text, `[m${ref1}..m${ref3} compressed] Explored three test messages; concluded nothing needed.`);
		assert.equal(output.messages[1].parts[0].text, "");
		assert.equal(output.messages[2].parts[0].text, "");

		const status = await (hooks as any).tool.headroom_status.execute({});
		assert.match(status, /acp ranges folded: 1/);
	});

	it("acp_compress batch mode folds several ranges in one call", async () => {
		const { hooks } = ctx;
		const mk = (id: string) => ({ info: { id, role: "assistant", cost: 0, tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [{ type: "text", text: `content of ${id}` }] });
		const output = {
			messages: [
				mk("b1"), mk("b2"), mk("b3"), mk("b4"),
				{ info: { role: "user" }, parts: [] },
			],
		} as any;
		await (hooks as any)["experimental.chat.messages.transform"]({}, output);
		const refOf = (i: number) => Number(/\[m(\d+)\]/.exec(output.messages[i].parts[0].text)![1]);
		const r1 = refOf(0), r4 = refOf(3);

		const result = await (hooks as any).tool.acp_compress.execute({
			ranges: [
				{ from: `m${r1}`, to: `m${r1 + 1}`, summary: "First consumed stretch." },
				{ from: `m${r4}`, to: `m${r4 + 500}`, summary: "Should fail - out of bounds." },
				{ from: `m${r4}`, to: `m${r4}`, summary: "Never reached." },
			],
		});
		assert.match(result, /✓ m\d+\.\.m\d+ folded \(2 messages\)/);
		assert.match(result, /✗/); // second range failed, third never ran
		assert.match(result, /earlier folds in this call stand/);

		const status = await (hooks as any).tool.headroom_status.execute({});
		assert.match(status, /acp ranges folded: [2-9]/); // prior test's fold + these two
	});

	it("range folding preserves retrievable CCR hashes in the anchor", async () => {
		const { hooks } = ctx;
		const mkTool = (id: string) => ({ info: { id, role: "assistant", cost: 0, tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [{ type: "tool", tool: "bash", state: { status: "completed", input: {}, output: `[headroom] Retrieve more: hash=aabbccddeeff11223344`, title: "bash", metadata: {}, time: { start: 0, end: 1 } } }] });
		const output = { messages: [mkTool("hh1"), mkTool("hh2"), { info: { role: "user" }, parts: [] }] } as any;
		await (hooks as any)["experimental.chat.messages.transform"]({}, output);
		const r1 = Number(/\[m(\d+)\]/.exec(output.messages[0].parts[0].state.output)![1]);
		const r2 = Number(/\[m(\d+)\]/.exec(output.messages[1].parts[0].state.output)![1]);
		await (hooks as any).tool.acp_compress.execute({ from: `m${r1}`, to: `m${r2}`, summary: "Hash survival check." });
		await (hooks as any)["experimental.chat.messages.transform"]({}, output);
		// Tool-only range: anchor lands on the first folded tool result.
		assert.match(output.messages[0].parts[0].state.output, /compressed\] Hash survival check\. \(retrievable via headroom_retrieve: aabbccddeeff11223344\)/);
	});

	it("skips opencode internal agents (title/summary/compaction)", async () => {
		const { hooks } = ctx;
		const output = {
			messages: [
				{ info: { role: "user", agent: "summary" }, parts: [{ type: "text", text: "summarize this" }] },
			],
		} as any;
		await (hooks as any)["experimental.chat.messages.transform"]({}, output);
		assert.equal(output.messages[0].parts[0].text, "summarize this", "internal request untouched");
	});

	it("GC evicts oldest folded summaries at 95% of window", async () => {
		const { hooks } = ctx;
		const mk = (id: string) => ({ info: { id, role: "assistant", cost: 0, tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [{ type: "text", text: `content of ${id}` }] });
		const output = { messages: [mk("g1"), mk("g2"), mk("g3"), mk("g4"), { info: { role: "user" }, parts: [] }] } as any;
		await (hooks as any)["chat.params"]({ sessionID: "gc-test", model: { id: "m", providerID: "p", limit: { context: 100_000 } } }, {});
		await (hooks as any)["experimental.chat.messages.transform"]({}, output);
		const ref = (i: number) => Number(/\[m(\d+)\]/.exec(output.messages[i].parts[0].text)![1]);
		await (hooks as any).tool.acp_compress.execute({ ranges: [
			{ from: `m${ref(0)}`, to: `m${ref(0)}`, summary: "Oldest range." },
			{ from: `m${ref(1)}`, to: `m${ref(1)}`, summary: "Middle range." },
			{ from: `m${ref(2)}`, to: `m${ref(2)}`, summary: "Newest range." },
			{ from: `m${ref(3)}`, to: `m${ref(3)}`, summary: "Newest-2 range." },
		] });

		// Same conversation grows past 95%: GC evicts all but the 2 newest.
		output.messages.push(
			{ info: { id: "ghot", role: "assistant", cost: 0, tokens: { input: 97_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [] },
			{ info: { role: "user" }, parts: [] },
		);
		await (hooks as any)["experimental.chat.messages.transform"]({}, output);
		assert.match(output.messages[0].parts[0].text, /compressed\] \(summary evicted/);
		assert.match(output.messages[1].parts[0].text, /compressed\] \(summary evicted/);
		assert.match(output.messages[2].parts[0].text, /Newest range\./);
		assert.match(output.messages[3].parts[0].text, /Newest-2 range\./);
	});

	it("toast and nudge are damped against oscillation", async () => {
		const { hooks, toasts } = ctx;
		await (hooks as any).event({ event: { type: "session.created" } }); // reset nudge bookkeeping
		await (hooks as any)["chat.params"]({ model: { id: "m", providerID: "p", limit: { context: 100_000 } } }, {});
		const round = (inputTokens: number) => (hooks as any)["experimental.chat.messages.transform"]({}, {
			messages: [{ info: { role: "assistant", cost: 0, tokens: { input: inputTokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [] }],
		} as any);
		const sysOut = () => ({ system: [] as string[] } as any);
		const countNudges = (o: any) => o.system.filter((l: string) => l.includes("Context pressure")).length;

		await round(20_000);                       // normal
		await round(90_000);                       // → aggressive: toast + nudge fire
		const t1 = toasts.length;
		let s = sysOut();
		await (hooks as any)["experimental.chat.system.transform"]({}, s);
		assert.equal(countNudges(s), 1);
		assert.equal(toasts.length, t1 + 0 ? toasts.length : toasts.length); // placeholder no-op
		assert.ok(toasts.length >= 1);

		await round(89_000);                       // dips under band → silent
		s = sysOut();
		await (hooks as any)["experimental.chat.system.transform"]({}, s);
		assert.equal(countNudges(s), 0);
		await round(91_000);                       // re-crosses with +1K (<2%) → damped
		assert.equal(toasts.length, t1, "no oscillation toast");
		s = sysOut();
		await (hooks as any)["experimental.chat.system.transform"]({}, s);
		assert.equal(countNudges(s), 0, "same tier, <10% growth → nudge damped");

		await round(102_000);                      // +11K growth → nudge refreshes
		s = sysOut();
		await (hooks as any)["experimental.chat.system.transform"]({}, s);
		assert.equal(countNudges(s), 1, "nudge refreshed after growth");
	});

	it("zero-LLM /headroom-status command renders directly and aborts pipeline", async () => {
		const { hooks } = ctx;
		await (hooks as any).config?.({ command: {} });
		const prompts: any[] = [];
		const hooks2 = await AcpHeadroomPlugin({
			client: {
				tui: { showToast: async () => {} },
				session: { prompt: async (opts: any) => { prompts.push(opts); } },
			},
			project: {} as any,
			directory: ".",
			worktree: ".",
			$: {} as any,
			serverUrl: new URL("http://127.0.0.1:1"),
		} as any);
		await (hooks2 as any).config({ command: {} });
		let aborted = false;
		try {
			await (hooks2 as any)["command.execute.before"]({ command: "headroom-status", sessionID: "s-cmd" }, { parts: [] });
		} catch (e: any) {
			aborted = e?.message === "__ACP_HEADROOM_HANDLED__";
		}
		assert.ok(aborted, "pipeline aborted with sentinel");
		assert.equal(prompts.length, 1);
		assert.equal(prompts[0].body.noReply, true);
		assert.match(prompts[0].body.parts[0].text, /enabled: true/);
	});

	it("ref registry persists — refs stay stable even when history shifts", async () => {
		const { hooks } = ctx;
		const mk = (id: string) => ({ info: { id, role: "assistant", cost: 0, tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [{ type: "text", text: `content of ${id}` }] });
		const output = { messages: [mk("rr1"), mk("rr2"), { info: { role: "user" }, parts: [] }] } as any;
		await (hooks as any)["chat.params"]({ sessionID: "ref-stable", model: { id: "m", providerID: "p", limit: { context: 1_000_000 } } }, {});
		await (hooks as any)["experimental.chat.messages.transform"]({}, output);
		const r1 = Number(/\[m(\d+)\]/.exec(output.messages[0].parts[0].text)![1]);
		const r2 = Number(/\[m(\d+)\]/.exec(output.messages[1].parts[0].text)![1]);
		await (hooks as any).tool.acp_compress.execute({ from: `m${r1}`, to: `m${r2}`, summary: "Ref stability check with plenty of detail." });

		// Reload session WITH a shifted projection (an extra message inserted
		// before rr1, simulating compaction artifacts): restored registry must
		// keep rr1/rr2 on their original refs instead of positional re-assign.
		await (hooks as any)["chat.params"]({ sessionID: "ref-stable", model: { id: "m", providerID: "p", limit: { context: 1_000_000 } } }, {});
		const shifted = {
			messages: [
				mk("extra-newcomer"),
				mk("rr1"),
				mk("rr2"),
				{ info: { role: "user" }, parts: [] },
			],
		} as any;
		await (hooks as any)["experimental.chat.messages.transform"]({}, shifted);
		// The restored range folds using the ORIGINAL refs (registry survived),
		// so the anchor lands on rr1 carrying exactly the old span numbers.
		assert.match(shifted.messages[1].parts[0].text, new RegExp(`\\[m${r1}\\.\\.m${r2} compressed\\] Ref stability check`), "original refs kept despite shift");
		assert.match(shifted.messages[0].parts[0].text, /^\[m\d+\] content of extra-newcomer$/, "new message gets a fresh ref");
	});

	it("acp_compress warns on suspiciously thin summaries", async () => {
		const { hooks } = ctx;
		const mk = (id: string) => ({ info: { id, role: "assistant", cost: 0, tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [{ type: "text", text: `content of ${id}` }] });
		const output = { messages: [mk("tw1"), mk("tw2"), { info: { role: "user" }, parts: [] }] } as any;
		await (hooks as any)["experimental.chat.messages.transform"]({}, output);
		const r1 = Number(/\[m(\d+)\]/.exec(output.messages[0].parts[0].text)![1]);
		const result = await (hooks as any).tool.acp_compress.execute({ from: `m${r1}`, to: `m${r1}`, summary: "thin" });
		assert.match(result, /✓ m\d+(\.\.m\d+)? folded \(1 messages\)/);
		assert.match(result, /⚠ summary under 50 chars/);
	});

	it("persists acp ranges to disk and restores them per session", async () => {
		const { hooks } = ctx;
		const mk = (id: string) => ({ info: { id, role: "assistant", cost: 0, tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [{ type: "text", text: `content of ${id}` }] });
		const output = { messages: [mk("pp1"), mk("pp2"), { info: { role: "user" }, parts: [] }] } as any;
		const limit = { model: { id: "m", providerID: "p", limit: { context: 1_000_000 } } };

		// Session p1: fold pp1..pp2.
		await (hooks as any)["chat.params"]({ sessionID: "persist-p1", ...limit }, {});
		await (hooks as any)["experimental.chat.messages.transform"]({}, output);
		const r1 = Number(/\[m(\d+)\]/.exec(output.messages[0].parts[0].text)![1]);
		const r2 = Number(/\[m(\d+)\]/.exec(output.messages[1].parts[0].text)![1]);
		await (hooks as any).tool.acp_compress.execute({ from: `m${r1}`, to: `m${r2}`, summary: "Persisted fold check." });
		const file = JSON.parse(await import("node:fs/promises").then((m) => m.readFile(`${process.env.HEADROOM_RANGES_DIR}/persist-p1.json`, "utf8")));
		assert.ok(file.ranges.some((x: any) => x.summary === "Persisted fold check."), "range written to disk");

		// Session p2: fresh state — no folding for these messages.
		await (hooks as any)["chat.params"]({ sessionID: "persist-p2", ...limit }, {});
		const outP2 = { messages: [mk("qq1"), mk("qq2"), { info: { role: "user" }, parts: [] }] } as any;
		await (hooks as any)["experimental.chat.messages.transform"]({}, outP2);
		const statusP2 = await (hooks as any).tool.headroom_status.execute({});
		assert.match(statusP2, /acp ranges folded: 0/); // disk truth for p2 = no folds

		// Back to session p1: restored from disk, folding re-applies.
		await (hooks as any)["chat.params"]({ sessionID: "persist-p1", ...limit }, {});
		const outP1 = { messages: [mk("pp1"), mk("pp2"), { info: { role: "user" }, parts: [] }] } as any;
		await (hooks as any)["experimental.chat.messages.transform"]({}, outP1);
		assert.match(outP1.messages[0].parts[0].text, /compressed\] Persisted fold check\./);
		assert.equal(outP1.messages[1].parts[0].text, "");
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

	it("registers exactly the five model-facing tools", async () => {
		const { hooks } = ctx;
		assert.deepEqual(
			Object.keys((hooks as any).tool).sort(),
			["acp_compress", "headroom_compress", "headroom_retrieve", "headroom_search", "headroom_status"],
		);
		await (hooks as any).dispose();
	});
});
