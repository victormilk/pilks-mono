# @victormilk/pi-vibeproxy

Pi Coding Agent extension that exposes a [CLIProxyAPIPlus](https://github.com/router-for-me/CLIProxyAPIPlus) instance ("VibeProxy") as two model providers inside Pi:

| Provider name      | Pi `api`              | CLIProxyAPIPlus path        |
|--------------------|-----------------------|-----------------------------|
| `vibeproxy`        | `anthropic-messages`  | `POST /v1/messages`         |
| `vibeproxy-openai` | `openai-completions`  | `POST /v1/chat/completions` |

Streaming and tool/function calling are forwarded by `@mariozechner/pi-ai`'s built-in adapters — this extension only configures the providers; it does not implement custom streaming.

## Install

From inside this monorepo:

```bash
pi install ./packages/pi-vibeproxy
```

Once published:

```bash
pi install npm:@victormilk/pi-vibeproxy
```

For one-off testing without installing:

```bash
pi -e ./packages/pi-vibeproxy/src/index.ts
```

## Configuration

Configuration lives at `~/.pi/agent/vibeproxy.json`. All fields are optional.

```json
{
  "baseUrl": "http://localhost:8317",
  "apiKey": "",
  "models": {
    "claude-sonnet-4-5": {
      "name": "Claude Sonnet 4.5 (VibeProxy)",
      "reasoning": true,
      "input": ["text", "image"],
      "contextWindow": 200000,
      "maxTokens": 16384,
      "cost": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75 }
    },
    "claude-opus-4-6": {
      "thinkingLevelMap": { "xhigh": "max" }
    },
    "claude-opus-4-7": {
      "thinkingLevelMap": { "xhigh": "xhigh" }
    }
  }
}
```

#### `thinkingLevelMap`

Pi's thinking-level menu only shows `xhigh` when the model declares it via `thinkingLevelMap`. The extension applies built-in defaults for known Anthropic adaptive-thinking ids:

| Model id pattern              | Default `thinkingLevelMap` |
|-------------------------------|----------------------------|
| `*opus-4-7*` / `*opus-4.7*`   | `{ "xhigh": "xhigh" }`     |
| `*opus-4-6*` / `*opus-4.6*`   | `{ "xhigh": "max" }`       |
| `*sonnet-4-6*` / `*sonnet-4.6*` | `{ "xhigh": "max" }`     |
| (everything else)             | (none — caps at `high`)    |

Declare `thinkingLevelMap` under a model entry to override these defaults or add a map for another model.

#### Context-window defaults

Opus 4.6 and Opus 4.7 also default to `contextWindow: 1_000_000` and `maxTokens: 128_000` (mirroring Pi's first-party catalog). All other Claude ids fall back to the family default `200_000 / 16_384`. Override via `contextWindow` / `maxTokens` under the model entry.

### Env-var overrides

- `VIBEPROXY_URL` — overrides `baseUrl`.
- `VIBEPROXY_API_KEY` — overrides `apiKey`.

### Capabilities & defaults

CLIProxyAPIPlus's `/v1/models` returns only `{ id, owned_by }`, so unspecified model capabilities use conservative defaults:

| Field           | Default     |
|-----------------|-------------|
| `reasoning`     | `false`     |
| `input`         | `["text"]`  |
| `contextWindow` | `128000`    |
| `maxTokens`     | `8192`      |
| `cost`          | all zeros   |

Declare per-model entries under `models` to unlock reasoning, image input, longer context windows, or accurate cost tracking.

## Commands

- `/vibeproxy-status` — ping `/v1/models` and report model count.
- `/vibeproxy-models` — list discovered models grouped by `owned_by`.
- `/vibeproxy-refresh` — re-fetch `/v1/models` and re-register providers.

## Smoke test (manual acceptance)

1. Start a CLIProxyAPIPlus instance (e.g. `http://localhost:8317`).
2. `pi install ./packages/pi-vibeproxy` (or `pi -e ./packages/pi-vibeproxy/src/index.ts`).
3. Run `pi --list-models` and confirm `vibeproxy/...` and `vibeproxy-openai/...` entries appear.
4. Launch Pi (`pi`), `/model vibeproxy-openai/<some-id>`, send a prompt — confirm tokens stream visibly.
5. `/model vibeproxy/<some-anthropic-id>`, send a prompt — confirm tokens stream visibly.
6. Issue a tool-call-bearing prompt on one of the two providers — confirm the tool call round-trips.

## License

MIT
