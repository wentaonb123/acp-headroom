import { promises as fs } from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { isValidHash } from "./client.js";

/** CCR backup directory (single source of truth; client.ts saves here). */
export function ccrDirectory(): string {
	// path.resolve pins a relative HEADROOM_CCR_DIR override to something
	// predictable instead of wherever the host happened to be started.
	return path.resolve(process.env.HEADROOM_CCR_DIR ?? path.join(homedir(), ".acp-headroom", "ccr"));
}

export interface SearchHit {
	hash: string;
	snippet: string;
	score: number;
}

// ponytail: linear scan + raw term-count ranking — fine at KB-MB scale;
// swap to an inverted index only if the backup dir ever grows past
// thousands of files or queries get latency complaints.
export async function searchOriginals(query: string, opts?: { limit?: number }): Promise<SearchHit[]> {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return [];
	const dir = ccrDirectory();
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch {
		return [];
	}
	const limit = opts?.limit ?? 5;
	const hits: SearchHit[] = [];
	for (const name of names) {
		if (!name.endsWith(".txt")) continue;
		const hash = name.slice(0, -4);
		if (!isValidHash(hash)) continue;
		let text: string;
		try {
			text = await fs.readFile(path.join(dir, name), "utf8");
		} catch {
			continue;
		}
		const lower = text.toLowerCase();
		let score = 0;
		for (const t of terms) score += lower.split(t).length - 1;
		if (score === 0) continue;
		const idx = lower.indexOf(terms[0]!);
		const start = Math.max(0, idx - 60);
		hits.push({ hash, score, snippet: text.slice(start, start + 160).replace(/\s+/g, " ").trim() });
	}
	hits.sort((a, b) => b.score - a.score);
	return hits.slice(0, limit);
}
