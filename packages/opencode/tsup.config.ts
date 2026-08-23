import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm"],
	target: "node20",
	sourcemap: false,
	clean: true,
	external: ["@opencode-ai/plugin"],
});
