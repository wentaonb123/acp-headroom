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
- **System prompt injection** (`experimental.chat.system.transform`): teaches the model to call `headroom_retrieve` for markers.
- **Tools**: `headroom_retrieve(hash)` pulls back exact originals; `headroom_status()` reports savings.
- **Fail-open**: proxy down ⇒ everything passes through uncompressed.

## Config

```bash
HEADROOM_PROXY_URL=http://127.0.0.1:8787   # proxy base URL
HEADROOM_MIN_CHARS=4000                    # min result size
HEADROOM_AUTOSTART=0                       # disable auto-spawn
```

MIT © wentaonb123
