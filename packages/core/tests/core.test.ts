import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidHash, resolveHeadroom, DEFAULT_PROTECTED_TOOLS, DEFAULT_HEADROOM_CONFIG } from "../dist/index.js";

test("isValidHash accepts 12 and 24 hex, rejects others", () => {
	assert.equal(isValidHash("a".repeat(12)), true);
	assert.equal(isValidHash("b".repeat(24)), true);
	assert.equal(isValidHash("A1B2C3D4E5F6"), true);
	assert.equal(isValidHash("a".repeat(11)), false);
	assert.equal(isValidHash("a".repeat(25)), false);
	assert.equal(isValidHash("zzzzzzzzzzzz"), false);
	assert.equal(isValidHash(""), false);
});

test("resolveHeadroom: env wins over settings, defaults fill gaps", () => {
	const prev = process.env.HEADROOM_PROXY_URL;
	try {
		delete process.env.HEADROOM_PROXY_URL;
		const cfg = resolveHeadroom({ minChars: 100 });
		assert.equal(cfg.proxyUrl, DEFAULT_HEADROOM_CONFIG.proxyUrl);
		assert.equal(cfg.minChars, 100);
		assert.equal(cfg.enabled, true);
		assert.deepEqual(cfg.protectedTools.slice(0, DEFAULT_PROTECTED_TOOLS.length), DEFAULT_PROTECTED_TOOLS);

		process.env.HEADROOM_PROXY_URL = "http://127.0.0.1:9999///";
		assert.equal(resolveHeadroom(undefined).proxyUrl, "http://127.0.0.1:9999");
	} finally {
		if (prev === undefined) delete process.env.HEADROOM_PROXY_URL;
		else process.env.HEADROOM_PROXY_URL = prev;
	}
});

test("resolveHeadroom: false disables; junk values fall back", () => {
	assert.equal(resolveHeadroom(false).enabled, false);
	const cfg = resolveHeadroom({ minChars: -5, maxPerTurn: Number.NaN });
	assert.equal(cfg.minChars, DEFAULT_HEADROOM_CONFIG.minChars);
	assert.equal(cfg.maxPerTurn, DEFAULT_HEADROOM_CONFIG.maxPerTurn);
});
