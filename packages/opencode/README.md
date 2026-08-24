# acp-headroom-opencode

Headroom tool-output compression for [OpenCode](https://opencode.ai) — same sent-view architecture as `acp-headroom-pi`.

## Install

```bash
npm i -g acp-headroom-opencode
```

```jsonc
// ~/.config/opencode/opencode.json
{ "plugin": ["acp-headroom-opencode"] }
```

Requires a local [Headroom](https://www.npmjs.com/package/headroom-ai) proxy (auto-spawned when reachable tooling exists):

```bash
uv tool run --from "headroom-ai[proxy]" headroom proxy --port 8787
```

## What it does

- **Sent-view compression** (`experimental.chat.messages.transform`): completed tool results older than the last user message and ≥ 4000 chars are compressed before the LLM call; your current-turn working set is never touched.
- **System prompt injection** (`experimental.chat.system.transform`): teaches the model the marker formats and the retrieval tools.
- **Compaction self-heal** (`experimental.session.compacting`): session summaries are instructed to preserve retrieval hashes, so nothing becomes unrecoverable after compaction.
- **Tools**: `headroom_retrieve(hash)` pulls back exact originals; `headroom_search(query)` full-text search across all saved originals; `headroom_compress(text)` compress on demand; `headroom_status()` reports savings with real provider-reported token usage.
- **Fail-open**: proxy down ⇒ everything passes through uncompressed.

## Slash command (optional)

Copy `commands/headroom-status.md` to `~/.config/opencode/command/` to get a `/headroom-status` command.

## Config

```bash
HEADROOM_PROXY_URL=http://127.0.0.1:8787   # proxy base URL
HEADROOM_MIN_CHARS=4000                    # min result size
HEADROOM_AUTOSTART=0                       # disable auto-spawn
```

Folded-range state persists per session at
`~/.local/share/opencode/storage/plugin/acp-headroom/<sessionID>.json`
(XDG-aware; `HEADROOM_RANGES_DIR` overrides), so context stays compressed
across restarts.

## Cost model — read this before using acp_compress heavily

Range compression rewrites history, which invalidates the provider's prompt
cache for that call — **each fold event bills the full tail once**. The economics:

- ✅ **Low-frequency, large batches** (the intended use): one invalidation,
  then every later call saves ~60% input at warm cache — pays back in a few turns.
- ❌ **Repeated small folds**: multiple full-price calls for near-zero savings.

Rules of thumb: fold only fully-consumed stretches, batch ranges in one call,
and leave the recent working set alone. The GC safety net evicts old summaries
automatically at 95% of the window, so summary overhead never compounds.

MIT © wentaonb123
