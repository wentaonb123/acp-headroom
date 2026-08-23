# acp-headroom-core

Host-agnostic core for ACP+Headroom tool-output compression. Zero host dependencies — used by `acp-headroom-pi` (pi) and `acp-headroom-opencode` (OpenCode).

## API

```ts
import { HeadroomStage, resolveHeadroom, retrieveOriginal } from "acp-headroom-core";

const stage = new HeadroomStage(() => ({ minChars: 4000 }));

// Sent-view mode: project your tool messages, apply before the LLM call
const result = await stage.apply([
  { id: "m1", role: "tool", text: bigToolOutput, toolName: "read" },
]);
// result.replacements: Map<messageId, compressedText>

// Retrieve an original by CCR hash (disk backup first, then proxy)
const original = await retrieveOriginal("http://127.0.0.1:8787", hash);
```

Everything fails open: proxy unreachable ⇒ `result.available === false` and originals pass through.

## Exports

- **`HeadroomStage`** — cache, stats, hysteretic proxy health, `apply()` (sent-view) / `applyOne()` (execute-time)
- **`resolveHeadroom(settings)`** — env-aware config resolution (`HEADROOM_PROXY_URL` wins)
- **proxy client** — `compressToolOutput`, `retrieveOriginal`, `saveOriginals`, `proxyHealthy`, `startProxy`, `stopSpawnedProxies`
- **`isValidHash`, `originOf`, `invalidateHealth`**

MIT © wentaonb123
