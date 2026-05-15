---
date: 2026-05-15T15:25:58-0300
author: victormilk
commit: 45ce480
branch: main
repository: pilks-mono
topic: "pi-droid: Factory.AI Droid models as a Pi provider"
tags: [research, codebase, pi-droid, pi-vibeproxy, factory-ai, droid-exec, streamSimple, jsonrpc, subprocess]
status: complete
last_updated: 2026-05-15T15:25:58-0300
last_updated_by: victormilk
---

# Research: pi-droid — Factory.AI Droid models as a Pi provider

## Research Question
New monorepo package `packages/pi-droid/` mirroring `packages/pi-vibeproxy/`'s six-file split (`index.ts`, `config.ts`, `discovery.ts`, `providers.ts`, `commands.ts`, `types.ts`), with the architectural difference that `providers.ts` registers a Pi `ProviderConfig` with a custom `api` string and a `streamSimple` JS function. That function owns a long-lived `droid exec` child process, pumps JSON-RPC events into an `AssistantMessageEventStream`, and translates Droid tool events into Pi tool-call events.

## Summary
- **JSON-RPC layer**: use `@factory/droid-sdk` (TypeScript, MIT, Factory-AI/droid-sdk-typescript). The SDK provides `createSession()`, `session.stream(prompt)`, `session.interrupt()`, typed notifications (`DroidMessageType.AssistantTextDelta`, `ToolCallDelta`, `ToolResult`, `TokenUsageUpdate`, `WorkingStateChanged`, `Error`), and a callback-shaped `permissionHandler` for `droid.request_permission`. pi-droid does NOT need to spawn `droid exec` itself, frame JSON-RPC, or correlate request IDs — the SDK owns the transport.
- **Event translation**: `AssistantMessageEvent` is a discriminated union at `packages/pi-vibeproxy/node_modules/@earendil-works/pi-ai/dist/types.d.ts:187-241` with `start`, `text_start|delta|end`, `thinking_start|delta|end`, `toolcall_start|delta|end`, `done`, `error`. The canonical emitter pattern is `custom-provider-anthropic/index.ts:286-559`: mutate one shared `output: AssistantMessage`, push events as the upstream stream advances, finalize with `done.message = output` (which carries `Usage` and `stopReason`).
- **Subprocess lifecycle**: the SDK manages the `droid` child process under its `ProcessTransport`. `DroidSession.close()` is the teardown call. pi-droid wires `pi.on("session_shutdown", async () => session?.close())` and exposes `/droid-restart` to call `session.close()` + null the cached singleton.
- **Provider registration**: `pi.registerProvider("droid", { name, baseUrl: "droid-exec://local", apiKey: "FACTORY_API_KEY", api: "droid-exec", streamSimple, models })`. `baseUrl` and `apiKey` are still required when `models` is set (`model-registry.js:651-656`) even though `streamSimple` owns transport. `apiKey: "FACTORY_API_KEY"` is the env-var NAME — Pi's `resolveConfigValue` (`resolve-config-value.js:14-20`) reads `process.env[name]` and passes the resolved value as `options.apiKey` to `streamSimple`.
- **Discovery**: no `droid --list-models` flag exists. v1 ships a curated static list in `discovery.ts` mirroring `docs.factory.ai/models.md`. `/droid-refresh` rewrites the cache from this constant. Cache file at `~/.pi/agent/droid-cache.json` stays as a diagnostic + future runtime-probe slot.
- **Autonomy**: default `--auto medium`. Droid's `request_permission` callback auto-resolves to `ToolConfirmationOutcome.ProceedOnce` (FRD locked decision). Pi does NOT register a `pi.on("tool_call", …)` listener — Droid tool events surface only as `toolcall_*` content-stream events.
- **Cost**: Factory bundles costs into its credit multipliers, not per-token prices. Default `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }` for every model; expose `modelOverrides` in `~/.pi/agent/droid.json` for power users.

## Detailed Findings

### `AssistantMessageEvent` union (what `streamSimple` must emit)

Defined at `packages/pi-vibeproxy/node_modules/@earendil-works/pi-ai/dist/types.d.ts:187-241`. Eleven variants (verbatim line range from the installed file, 188-240):

| Variant | Required fields | Effect on `output.content[]` | Emitter discipline |
|---|---|---|---|
| `start` (188-190) | `partial: AssistantMessage` | none — `content` still `[]` | push once, continue |
| `text_start` (191-194) | `contentIndex`, `partial` | append `{type:"text", text:""}` | push, continue |
| `text_delta` (195-199) | `contentIndex`, `delta`, `partial` | concat onto `content[contentIndex].text` | push, continue |
| `text_end` (200-204) | `contentIndex`, `content: string`, `partial` | finalize text block | push, continue |
| `thinking_start` (205-208) | `contentIndex`, `partial` | append `{type:"thinking", thinking:"", thinkingSignature:""}` | push, continue |
| `thinking_delta` (209-213) | `contentIndex`, `delta`, `partial` | concat onto `thinking` | push, continue |
| `thinking_end` (214-218) | `contentIndex`, `content`, `partial` | finalize thinking block | push, continue |
| `toolcall_start` (219-222) | `contentIndex`, `partial` | append `{type:"toolCall", id, name, arguments:{}}` | push, continue |
| `toolcall_delta` (223-227) | `contentIndex`, `delta: string`, `partial` | accumulate `partialJson`, speculative `JSON.parse` → `arguments` | push, continue |
| `toolcall_end` (228-232) | `contentIndex`, `toolCall: ToolCall`, `partial` | finalize `arguments` from `partialJson`, scrub scratch | push, continue |
| `done` (233-236) | `reason: "stop"\|"length"\|"toolUse"`, `message: AssistantMessage` | none — `message` is finalized | push **and end** |
| `error` (237-240) | `reason: "aborted"\|"error"`, `error: AssistantMessage` | none | push **and end** |

`ToolCall` shape at `pi-ai/dist/types.d.ts:117-123`: `{ type: "toolCall"; id: string; name: string; arguments: Record<string, any>; thoughtSignature? }`.

`AssistantMessage` required fields at `pi-ai/dist/types.d.ts:144-157`: `role`, `content`, `api`, `provider`, `model`, `usage`, `stopReason`, `timestamp`.

The canonical emit pattern from `custom-provider-anthropic/index.ts:286-559`:
1. Construct `output: AssistantMessage` with empty content + zeroed usage + `stopReason: "stop"` + `timestamp: Date.now()` (`index.ts:343-358`).
2. Push `{ type: "start", partial: output }` once after upstream stream opens (`index.ts:439`).
3. For each upstream event, mutate `output.content[]` in place and push the matching delta event. The `output` reference is shared with the consumer.
4. Push `{ type: "done", reason: output.stopReason, message: output }` then `stream.end()` (`index.ts:551`).
5. On abort/error: scrub scratch fields, set `stopReason`, set `errorMessage`, push `{ type: "error", reason, error: output }` then `stream.end()` (`index.ts:553-559`).

### Droid → Pi event mapping (via `@factory/droid-sdk`)

The SDK exposes `DroidMessageType` at `stream.ts:33-58` (from `Factory-AI/droid-sdk-typescript/src/stream.ts`). Mapping for `streamSimple`:

| Droid SDK event (`DroidMessageType.*`) | Action |
|---|---|
| Session start (entering `stream()`) | Push `{ type: "start", partial: output }` |
| `AssistantTextDelta` (`{ messageId, blockIndex, text }`) | First chunk per `blockIndex` → push `text_start` with `contentIndex = output.content.length`, append `{type:"text", text:""}` block, then push `text_delta` with `delta: text`; subsequent chunks → push `text_delta` only |
| `AssistantTextComplete` (`{ messageId, blockIndex }`) | Push `text_end` with assembled `block.text` |
| `ThinkingTextDelta` / `ThinkingTextComplete` | Same pattern, `thinking_*` events |
| `ToolCallDelta` (`{ toolUse: ToolUseBlock }`) | First call per `toolUse.id` → push `toolcall_start`, append `{type:"toolCall", id: toolUse.id, name: toolUse.name, arguments: toolUse.input}` block; subsequent (incremental input) → push `toolcall_delta`; `toolcall_end` is emitted when next event arrives or on turn complete with the fully assembled `ToolCall` |
| `ToolResult` (`{ toolUseId, content, isError }`) | **Drop** — Pi's `AssistantMessageEventStream` has no equivalent. Tool results are Droid-internal execution detail and surface to the user via the assistant text that follows. (Alternative: surface as informational text delta — defer until UX feedback.) |
| `ToolProgress` | Drop — purely diagnostic |
| `WorkingStateChanged` with `state !== Idle` | Drop — internal state machine for SDK's own turn-completion detection |
| `WorkingStateChanged` with `state === Idle` after non-idle | **Turn complete** — push `{ type: "done", reason: "stop", message: output }` then `stream.end()`. Detection precedent: SDK's `StreamStateTracker.processMessage` in `stream.ts:processMessage`. |
| `TokenUsageUpdate` (`{ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, thinkingTokens }`) | Update `output.usage.input/output/cacheRead/cacheWrite`, recompute `totalTokens = input + output + cacheRead + cacheWrite`, call `calculateCost(model, output.usage)` |
| `Error` (`{ message, errorType, timestamp }`) | Set `output.stopReason = "error"`, `output.errorMessage = message`, push `{ type: "error", reason: "error", error: output }`, `stream.end()` |
| `Result` (the final `DroidResultMessage` from SDK) | Already done above on Idle transition — ignore or use for final-state validation |

### `@factory/droid-sdk` API surface

Read from `Factory-AI/droid-sdk-typescript@main/src/{index.ts,session.ts,stream.ts,protocol.ts,schemas/enums.ts}`:

- **Top-level** (`index.ts`): `run`, `createSession`, `resumeSession`, `listSessions`, `createSdkMcpServer`, `tool`, `DroidClient`, `DroidMessageType`, `StreamStateTracker`, all event type exports.
- **`createSession(options)` returns `DroidSession`**:
  - `options.cwd` — working directory (defaults to `process.cwd()`)
  - `options.execPath` — `droid` binary path (default `"droid"`)
  - `options.execArgs` — extra CLI flags passed to `droid exec`
  - `options.modelId` — model selection (e.g. `"claude-sonnet-4-6"`)
  - `options.autonomyLevel` — `AutonomyLevel.Off|Low|Medium|High`
  - `options.interactionMode` — `DroidInteractionMode.Auto|Spec|AGI`
  - `options.reasoningEffort` — `ReasoningEffort.Off|Minimal|Low|Medium|High|ExtraHigh|Max|Dynamic`
  - `options.permissionHandler(params): ToolConfirmationOutcome | Promise<…>` — callback for `droid.request_permission`. Returning `ToolConfirmationOutcome.ProceedOnce` auto-approves.
  - `options.askUserHandler(params): { cancelled, answers } | Promise<…>` — callback for `droid.ask_user`
  - `options.abortSignal: AbortSignal` — kills the session if aborted
  - `options.env` — environment variables for the spawned `droid` process (defaults to `process.env`, so `FACTORY_API_KEY` flows through)
- **`session.stream(prompt, options)`**: async generator yielding `DroidStreamMessage` (or `DroidStreamEvent` with `includePartialMessages: true`). `options.abortSignal` cancels just this turn. Internally calls `droid.add_user_message` + `droid.interrupt_session` on abort (per `session.ts:stream` body).
- **`session.interrupt()`**: sends `droid.interrupt_session` JSON-RPC, no stream side-effect.
- **`session.close()`**: closes `DroidClient`, kills underlying transport (the `droid` subprocess).
- **`session.sessionId`**, **`session.initResult`** — for `/droid-status`.

### JSON-RPC envelope (background, not pi-droid's concern since SDK owns it)

From `Factory-AI/droid-sdk-typescript@main/src/protocol.ts:101-114`:
```
envelope = {
  jsonrpc: JSONRPC_VERSION,            // "2.0"
  factoryApiVersion: LEGACY_FACTORY_API_VERSION,
  factoryProtocolVersion: FACTORY_PROTOCOL_VERSION,
  type: JsonRpcMessageType.Request,    // "request" | "response" | "notification"
  id: uuidv4(),
  method,                              // e.g. "droid.add_user_message"
  params,
}
```

Server methods (`DroidServerMethod` at `schemas/enums.ts:11-37`): `INITIALIZE_SESSION`, `LOAD_SESSION`, `ADD_USER_MESSAGE`, `INTERRUPT_SESSION`, `KILL_WORKER_SESSION`, `UPDATE_SESSION_SETTINGS`, `LIST_TOOLS`, `FORK_SESSION`, `GET_CONTEXT_STATS`, etc.

Client methods (server→client, `DroidClientMethod` at `schemas/enums.ts:40-44`): `SESSION_NOTIFICATION`, `REQUEST_PERMISSION`, `ASK_USER`.

### `streamSimple` signature

Defined at `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:949` (verbatim):
```ts
streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
```

- `model: Model<Api>` — has `id`, `cost`, etc. for `calculateCost`.
- `context: Context` from `pi-ai/dist/types.d.ts:174-178` — has `systemPrompt?`, `messages`, `tools?`. **No `signal`, no `abort()`.** Pi-droid takes `context.messages[messages.length - 1].content` as the user prompt and concatenates `context.systemPrompt` into the first message.
- `options?: SimpleStreamOptions` extends `StreamOptions` (`pi-ai/dist/types.d.ts:24-28` + `87-91`): includes `signal?: AbortSignal`, `apiKey?: string`, `temperature?`, `maxTokens?`, `reasoning?: ThinkingLevel`, `thinkingBudgets?`.
- `options.apiKey` is the **resolved value** — Pi already called `resolve-config-value.js:14-20`: `process.env[config]` falling back to literal. So if the user has `FACTORY_API_KEY=fk-...` exported, `options.apiKey === "fk-..."`. The SDK reads `FACTORY_API_KEY` from `env`, so explicit forwarding is optional but tidy.
- Cancellation: pi-droid wires `options.signal?.addEventListener("abort", () => session.interrupt())` then translates SDK abort errors to `error.reason: "aborted"`. Matches `custom-provider-anthropic/index.ts:455-465` pattern.

### `ProviderConfig` shape

Defined at `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:939-970`:
```ts
export interface ProviderConfig {
    name?: string;
    baseUrl?: string;
    apiKey?: string;
    api?: Api;
    streamSimple?: (model, context, options?) => AssistantMessageEventStream;
    headers?: Record<string, string>;
    authHeader?: boolean;
    models?: ProviderModelConfig[];
    oauth?: { … };
}
```

All fields optional at the type level. **Runtime validation** at `model-registry.js:645-656` enforces:
- `streamSimple` present ⇒ `api` required
- `models` present ⇒ `baseUrl` required AND (`apiKey` OR `oauth`) required

For pi-droid: must pass `baseUrl` (use `"droid-exec://local"`), `apiKey: "FACTORY_API_KEY"` (env-var name), `api: "droid-exec"`, `streamSimple`, `models`. **Idempotence**: `pi.registerProvider("droid", …)` with new `models` array replaces all existing models for the `"droid"` provider (`types.d.ts:866,954` doc; `model-registry.js:684-685` impl). No `unregisterProvider` first.

### `Api` open string type

`packages/pi-vibeproxy/node_modules/@earendil-works/pi-ai/dist/types.d.ts:4-5` (verbatim):
```ts
export type KnownApi = "openai-completions" | "mistral-conversations" | "openai-responses" | "azure-openai-responses" | "openai-codex-responses" | "anthropic-messages" | "bedrock-converse-stream" | "google-generative-ai" | "google-vertex";
export type Api = KnownApi | (string & {});
```

`"droid-exec"` is a valid `Api` value (any string is accepted; `(string & {})` idiom preserves autocomplete on `KnownApi` literals).

### Usage + cost reporting

`Usage` shape at `pi-ai/dist/types.d.ts:124-141` (all five token fields + five cost fields are required, non-nullable):
```ts
interface Usage {
    input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}
```

`calculateCost` at `pi-ai/dist/models.d.ts:9` + `models.js:22-29`:
```ts
function calculateCost<TApi>(model: Model<TApi>, usage: Usage): Usage["cost"]
// mutates usage.cost in place: cost.input = (model.cost.input / 1_000_000) * usage.input
```

Droid `TokenUsageUpdate` → Pi `Usage` map:
- `inputTokens` → `usage.input`
- `outputTokens` → `usage.output`
- `cacheReadTokens` → `usage.cacheRead`
- `cacheCreationTokens` → `usage.cacheWrite`
- `thinkingTokens` → fold into `output` (no separate field)
- Compute `totalTokens = input + output + cacheRead + cacheWrite`
- Call `calculateCost(model, output.usage)` after each update

Since Factory's pricing is multiplier-based (not per-token dollar amounts), set `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }` on every `ProviderModelConfig` — `calculateCost` becomes a no-op writing zeros. User can override per-model via `~/.pi/agent/droid.json` `models.<id>.cost`.

### Subprocess lifecycle (SDK-owned)

`@factory/droid-sdk` uses `ProcessTransport` (re-exported from `transport.ts`). pi-droid does NOT spawn `droid` directly. The lifecycle reduces to managing one `DroidSession` instance:

```
let session: DroidSession | null = null;

async function getSession(model, apiKey, signal) {
  if (session && !session.closed) return session;
  session = await createSession({
    cwd: process.cwd(),
    execPath: state.cfg.droidBinary ?? "droid",
    execArgs: ["--auto", state.cfg.autoLevel ?? "medium"],
    modelId: model.id,
    autonomyLevel: AutonomyLevel.Medium,
    permissionHandler: () => ToolConfirmationOutcome.ProceedOnce,
    env: { ...process.env, FACTORY_API_KEY: apiKey ?? process.env.FACTORY_API_KEY ?? "" },
  });
  return session;
}
```

Crash detection: the SDK exposes errors via `Error` notification events on the stream. pi-droid's `streamSimple` catches stream errors, sets `state.lastError`, nulls `session` so the next call respawns.

Shutdown wiring (per `sandbox/index.ts:287` precedent):
```ts
pi.on("session_shutdown", async () => {
  if (session) await session.close().catch(() => {});
  session = null;
});
```

The SDK handles SIGTERM internally via `client.close()` → `transport.close()` → process kill. pi-droid does NOT need to implement SIGTERM→SIGKILL escalation manually.

**Note on long-lived session vs per-turn**: `DroidSession` already multiplexes multiple `session.stream(prompt)` calls on the same underlying `droid exec` process (per `session.ts` body — `addUserMessage` for each turn). pi-droid's "long-lived subprocess, multiplex turns" FRD decision is satisfied by holding the `DroidSession` singleton across `streamSimple` calls.

### Cancellation plumbing

Two abort surfaces:
1. **Per-turn**: `options.signal` (the `SimpleStreamOptions.signal` from `pi-ai/dist/types.d.ts:24-28,87-91`). pi-droid passes this directly into `session.stream(prompt, { abortSignal: options.signal })`. The SDK's `stream()` body (per `session.ts:stream`) wires the signal to `client.interruptSession()`, which sends `droid.interrupt_session` JSON-RPC. Stream throws → pi-droid catches → pushes `{ type: "error", reason: "aborted", error: output }`.
2. **Session-wide**: pi-droid does NOT pass `abortSignal` to `createSession` — the session must outlive any single turn. `/droid-restart` is the manual session-kill lever.

### Discovery + cache

**No `droid --list-models` flag exists**. Verified against `https://docs.factory.ai/cli/droid-exec/overview.md`'s flag table (only `-m, --model <id>`, `--list-tools`, `--enabled-tools`, `--disabled-tools` — no model enumeration). `--list-tools` enumerates tools, not models.

**Curated list** in `discovery.ts` mirroring `https://docs.factory.ai/models.md` (fetched 2026-05-15):

| Family | Model ID | Display Name | Reasoning | Notes |
|---|---|---|---|---|
| Anthropic | `claude-opus-4-7` | Claude Opus 4.7 | Off/Low/Medium/High(default)/Max | flagship |
| Anthropic | `claude-opus-4-7-fast` | Claude Opus 4.7 Fast | same | 12× multiplier |
| Anthropic | `claude-opus-4-6` | Claude Opus 4.6 | same | |
| Anthropic | `claude-sonnet-4-6` | Claude Sonnet 4.6 | same | balanced default |
| Anthropic | `claude-opus-4-5-20251101` | Claude Opus 4.5 | Off(default)/Low/Medium/High | dated |
| Anthropic | `claude-sonnet-4-5-20250929` | Claude Sonnet 4.5 | same | dated |
| Anthropic | `claude-haiku-4-5-20251001` | Claude Haiku 4.5 | same | dated, cheap |
| OpenAI | `gpt-5.5` | GPT-5.5 | None/Low/Medium(default)/High/ExtraHigh | |
| OpenAI | `gpt-5.5-fast` | GPT-5.5 Fast | same | |
| OpenAI | `gpt-5.5-pro` | GPT-5.5 Pro | same | 12× |
| OpenAI | `gpt-5.4` | GPT-5.4 | same | |
| OpenAI | `gpt-5.4-fast` | GPT-5.4 Fast | same | |
| OpenAI | `gpt-5.4-mini` | GPT-5.4 Mini | None/Low/Medium/High(default)/ExtraHigh | |
| OpenAI | `gpt-5.3-codex` | GPT-5.3 Codex | None/Low/Medium(default)/High/ExtraHigh | |
| OpenAI | `gpt-5.3-codex-fast` | GPT-5.3 Codex Fast | same | |
| OpenAI | `gpt-5.2` | GPT-5.2 | Off/Low(default)/Medium/High/ExtraHigh | |
| OpenAI | `gpt-5.2-codex` | GPT-5.2 Codex | None/Low/Medium(default)/High/ExtraHigh | |
| Google | `gemini-3.1-pro-preview` | Gemini 3.1 Pro | Low/Medium/High(default) | |
| Google | `gemini-3-pro-preview` | Gemini 3 Pro | None/Low/Medium/High(default) | |
| Google | `gemini-3-flash-preview` | Gemini 3 Flash | Minimal/Low/Medium/High(default) | |
| Droid Core | `glm-5.1` | GLM 5.1 | Off/High(default) | |
| Droid Core | `kimi-k2.6` | Kimi K2.6 | same | |
| Droid Core | `kimi-k2.5` | Kimi K2.5 | same | |
| Droid Core | `minimax-m2.7` | MiniMax M2.7 | High(default) only | |

**Default**: pick one as the "registered default model" (e.g. `claude-sonnet-4-6` — flagship balanced). All models registered as `droid/<id>`.

**Cache shape** at `~/.pi/agent/droid-cache.json`:
```json
{
  "version": 1,
  "lastRefresh": 1747405200000,
  "models": [...],
  "source": "curated"
}
```

`/droid-refresh` rewrites cache from the curated constant (no probe). The cache exists for diagnostics (`/droid-status` prints `cache.lastRefresh`) and as a forward-compat slot if Factory ever ships a runtime probe.

### Slash commands

Four commands mirroring vibeproxy's `commands.ts:18-77` pattern + `/droid-restart`:

- **`/droid-status`**: read-only. Print `session?.sessionId ?? "no active session"`, `state.lastError ?? "ok"`, `state.cfg.loadedFrom ?? "defaults"`, `state.cachePath`, `state.lastModels.length`. No spawn, no notify-error path.
- **`/droid-models`**: read-only. Print `state.lastModels` grouped by family (`anthropic`/`openai`/`google`/`droid-core`). UI: `ctx.ui.notify("N models — see console", "info")` + `printGrouped` to stdout.
- **`/droid-refresh`**: rewrite cache from curated constant, re-register provider via `pi.registerProvider("droid", { …, models })`. Per `types.d.ts:870-873`: "safe to call from command handlers without requiring a /reload". Update `state.lastModels`, clear `state.lastError`, notify.
- **`/droid-restart`**: `await ctx.waitForIdle()` (per `types.d.ts:241-243`), then `await session?.close()`, null the singleton, notify "next turn will respawn the droid subprocess." `waitForIdle` is critical — killing mid-stream tears down stdin/stdout for the in-flight `streamSimple`.

### `RuntimeState` shape

Pi-droid extends vibeproxy's three-field `RuntimeState` (`commands.ts:13-17`) with four fields:
```ts
interface RuntimeState {
  cfg: ResolvedConfig;
  lastModels: ReadonlyArray<DroidModel>;
  lastError?: string;
  session: DroidSession | null;          // SDK session singleton
  lastSpawnAt?: number;                  // for /droid-status
  cachePath: string;
}
```

### Config layering

Mirror `packages/pi-vibeproxy/src/config.ts:1-128`:
- Path: `~/.pi/agent/droid.json` (config) + `~/.pi/agent/droid-cache.json` (cache).
- Precedence: defaults < file < env vars.
- Env vars: `DROID_BINARY` (overrides `droidBinary`), `FACTORY_API_KEY` (passed through to SDK; same name as Droid CLI).
- File schema: `{ baseUrl? (unused, accept for forward-compat), droidBinary?, autoLevel?: "low"|"medium"|"high", defaultModel?, models?: Record<id, ModelOverride> }`.
- `coerceConfigFile` + `normalizeModelOverrides` patterns (`config.ts:52-116`) — never throw, drop malformed values, `console.warn` on parse failure.
- Export `CONFIG_PATH_FOR_DIAGNOSTICS = CONFIG_PATH;` (`config.ts:123` precedent) for error-surface clarity.

### Tool-call passthrough & `request_permission` auto-resolve

- **Pi has no `ctx.ui.approve` surface** — exhaustive grep across `pi-coding-agent/dist/core/extensions/types.d.ts` returns zero matches for `approve|permission_request`. Confirmed.
- **`pi.on("tool_call", …)` exists** (`types.d.ts:809`) but only fires for tools in Pi's tool registry — Droid tools never enter Pi's registry, so pi-droid does NOT register this listener.
- **`droid.request_permission` auto-resolve**: passed to SDK as `permissionHandler: () => ToolConfirmationOutcome.ProceedOnce`. The SDK's `protocol.ts:_handlePermissionRequest` calls the handler and sends the response over JSON-RPC. Default (no handler) is `ToolConfirmationOutcome.Cancel` — pi-droid MUST register `ProceedOnce` or every tool will be denied.
- **`droid.ask_user` auto-resolve**: SDK default with no `askUserHandler` is `{ cancelled: true, answers: [] }`. For v1, pi-droid leaves this unset (Droid's auto-approve via `--auto medium` handles most cases; interactive prompts cancel cleanly).

## Code References
- `packages/pi-vibeproxy/src/index.ts:20-71` — extension factory shape; lifecycle (loadConfig → discovery → registerFamilies → registerCommands → on(session_start))
- `packages/pi-vibeproxy/src/config.ts:1-128` — env→file→defaults config layering; `coerceConfigFile`/`normalizeModelOverrides`; `CONFIG_PATH_FOR_DIAGNOSTICS` export at line 123
- `packages/pi-vibeproxy/src/discovery.ts:1-77` — `DiscoveryResult { models, usedFallback, error?, httpStatus? }`; `FALLBACK_MODELS` at lines 23-26; HTTP-specific code (pi-droid replaces with curated constant)
- `packages/pi-vibeproxy/src/providers.ts:1-95` — `pi.registerProvider(name, ProviderConfig)` call shape at lines 60-66; `PLACEHOLDER_API_KEY = "no-key"` workaround at line 8
- `packages/pi-vibeproxy/src/commands.ts:13-77` — `RuntimeState` interface, three `pi.registerCommand` invocations, `notify()` UI-vs-headless helper at lines 79-87
- `packages/pi-vibeproxy/src/types.ts:1-117` — `ModelOverride`, `ConfigFile`, `ResolvedConfig`, `UpstreamModel`, `Family`, `FamilySpec`, `ResolvedModel`
- `packages/pi-vibeproxy/package.json:1-60` — `pi.extensions: ["./src/index.ts"]`, `peerDependencies`, `devDependencies` versions
- `packages/pi-vibeproxy/tsconfig.json:1-7` — `extends: "../../tsconfig.base.json"`, `types: ["node"]`
- `tsconfig.base.json:1-15` — `noEmit`, `allowImportingTsExtensions`, `noUncheckedIndexedAccess`, `strict`, `moduleResolution: "Bundler"`
- `pnpm-workspace.yaml:1-2` — `packages/*` glob (pi-droid auto-picked up)
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-ai/dist/types.d.ts:4-5` — `Api = KnownApi | (string & {})`
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-ai/dist/types.d.ts:24-28` — `StreamOptions.signal: AbortSignal`
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-ai/dist/types.d.ts:87-91` — `SimpleStreamOptions extends StreamOptions`
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-ai/dist/types.d.ts:117-123` — `ToolCall` shape
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-ai/dist/types.d.ts:124-141` — `Usage` shape (all fields required)
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-ai/dist/types.d.ts:144-157` — `AssistantMessage` shape
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-ai/dist/types.d.ts:174-178` — `Context` (no signal/abort)
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-ai/dist/types.d.ts:187-241` — `AssistantMessageEvent` union (11 variants)
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-ai/dist/models.d.ts:9` — `calculateCost` signature
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-ai/dist/utils/event-stream.d.ts:1-22` — `createAssistantMessageEventStream`
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:207-237` — `ExtensionContext` (with `signal`, `abort()`)
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:241-243` — `ExtensionCommandContext.waitForIdle()`
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:416-421` — `SessionShutdownEvent`
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:586-628` — `ToolCallEvent` (which pi-droid does NOT listen to)
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:714-717` — `ToolCallEventResult`
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:766-779` — `RegisteredCommand`
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:780-840` — `ExtensionAPI.on(…)` event registrations
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:866-873` — `registerProvider` doc: "models replaces all existing models" + idempotence
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:939-970` — `ProviderConfig` interface
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:971-1001` — `ProviderModelConfig` interface
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:949` — `streamSimple` signature
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.js:645-656` — runtime validation: `streamSimple` requires `api`; `models` requires `baseUrl` + (`apiKey`|`oauth`)
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.js:684-685` — `registerProvider` replaces models for the named provider
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/dist/core/resolve-config-value.js:14-20` — `apiKey` env-var resolution
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/examples/extensions/custom-provider-anthropic/index.ts:286-559` — canonical streamSimple emitter (Anthropic), event-by-event translation
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/examples/extensions/custom-provider-anthropic/index.ts:343-358` — `output: AssistantMessage` initialization
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/examples/extensions/custom-provider-anthropic/index.ts:439` — `start` event push site
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/examples/extensions/custom-provider-anthropic/index.ts:445-453` — Anthropic→Pi usage mapping + `calculateCost`
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/examples/extensions/custom-provider-anthropic/index.ts:455-465` — abort handling
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/examples/extensions/custom-provider-anthropic/index.ts:467-531` — tool-call assembly with `partialJson`
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/examples/extensions/custom-provider-anthropic/index.ts:551-559` — `done` and `error` emit sites
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/examples/extensions/custom-provider-gitlab-duo/index.ts:230-282` — minimal streamSimple example
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/examples/extensions/sandbox/index.ts:287-294` — `pi.on("session_shutdown", async () => …)` teardown pattern
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts:362-376` — SIGTERM→SIGKILL precedent (SDK already does this internally for pi-droid)

### Factory.AI Droid SDK references (external)

- `https://github.com/Factory-AI/droid-sdk-typescript/blob/main/src/index.ts` — package exports
- `https://github.com/Factory-AI/droid-sdk-typescript/blob/main/src/session.ts` — `createSession`, `resumeSession`, `DroidSession.stream`/`interrupt`/`close`
- `https://github.com/Factory-AI/droid-sdk-typescript/blob/main/src/stream.ts` — `DroidMessageType` (24 variants), `convertNotificationToStreamMessage`, `StreamStateTracker`
- `https://github.com/Factory-AI/droid-sdk-typescript/blob/main/src/protocol.ts` — JSON-RPC engine, `permissionHandler`, `askUserHandler` wiring
- `https://github.com/Factory-AI/droid-sdk-typescript/blob/main/src/schemas/enums.ts` — `DroidServerMethod`, `DroidClientMethod`, `SessionNotificationType`, `ToolConfirmationOutcome`, `AutonomyLevel`, `DroidInteractionMode`, `ReasoningEffort`, `DroidWorkingState`, `ModelProvider`
- `https://docs.factory.ai/cli/droid-exec/overview.md` — `droid exec` flags, `stream-jsonrpc` mode, autonomy levels
- `https://docs.factory.ai/models.md` — model list source for curated constant
- `https://docs.factory.ai/reference/cli-reference.md` — full CLI flag reference

## Integration Points

### Inbound References (consumers of pi-droid)
- Pi's model selection UI (`/model droid/<id>` slash command) — calls `pi.getProvider("droid")` → invokes `streamSimple(model, context, options)` for each turn
- Pi's command palette — invokes `/droid-status`, `/droid-models`, `/droid-refresh`, `/droid-restart` handlers registered via `pi.registerCommand`

### Outbound Dependencies
- `@earendil-works/pi-coding-agent@^0.74.0` — peer dep — `ExtensionAPI`, `ProviderConfig`, `ExtensionContext`, `ExtensionCommandContext`
- `@earendil-works/pi-ai@^0.74.0` — peer dep — `Api`, `Model`, `Usage`, `AssistantMessage`, `AssistantMessageEvent`, `createAssistantMessageEventStream`, `calculateCost`
- `@factory/droid-sdk` (latest) — **runtime dep** (vibeproxy has none — this is the parity break) — `createSession`, `DroidSession`, `DroidMessageType`, `ToolConfirmationOutcome`, `AutonomyLevel`, `ReasoningEffort`
- `node:fs`, `node:os`, `node:path` — config + cache file I/O
- `droid` binary on PATH (or at `cfg.droidBinary`) — verified at boot via `which droid` or `accessSync(cfg.droidBinary)`; warn via `ctx.ui.notify("warning")` if missing

### Infrastructure Wiring
- `pnpm-workspace.yaml:1-2` — `packages/*` glob auto-picks up `packages/pi-droid/`
- `packages/pi-droid/package.json` `pi.extensions: ["./src/index.ts"]` — Pi extension entry point
- `packages/pi-droid/src/index.ts` `export default async function (pi: ExtensionAPI)` — factory, registers providers + commands + `session_shutdown` listener
- `~/.pi/agent/droid.json` — user config (env `DROID_BINARY`, `FACTORY_API_KEY` layered on top)
- `~/.pi/agent/droid-cache.json` — discovery cache
- Root `README.md` Packages table — append one row (only mandatory monorepo touch; precedent: `05c697c`)

## Architecture Insights

1. **SDK ownership boundary**: `@factory/droid-sdk` owns subprocess lifecycle, JSON-RPC framing, abort wiring, and turn-completion detection. pi-droid's job reduces to (a) creating one `DroidSession` per Pi-extension instance, (b) translating `DroidMessageType.*` notifications → `AssistantMessageEvent.*` events, (c) registering the provider with Pi, (d) exposing four diagnostic commands. The complexity that would otherwise live in `droid-proc.ts` (subprocess singleton, crash detection, JSON-RPC dispatcher, request-id correlation) is delegated.

2. **Event translation is the load-bearing code path.** The `streamSimple` body is ~80-120 LOC that walks the `DroidSession.stream()` generator and emits Pi events. Five state pieces per turn: `output: AssistantMessage`, `output.content[]`, per-`blockIndex` text accumulators (Map<number, string>), per-`toolUse.id` tool-call accumulators (Map<string, {block, partialJson}>), and `output.usage`. Turn termination is detected via `WorkingStateChanged` → `Idle` (matches SDK's `StreamStateTracker`).

3. **Provider registration shape is rigid.** `pi.registerProvider("droid", { name, baseUrl, apiKey, api, streamSimple, models })` must include `baseUrl` (non-empty string, validator at `model-registry.js:651-656` does not waive it for streamSimple providers) and `apiKey` (env-var name `"FACTORY_API_KEY"`, resolved by Pi via `resolve-config-value.js:14-20`). The `baseUrl` is unused at runtime — `streamSimple` owns transport — but must satisfy validation. Pi-droid uses `baseUrl: "droid-exec://local"` as a self-documenting sentinel.

4. **Discovery is a documentation-mirror, not a runtime probe.** Factory provides no programmatic model-list endpoint. The "discovery" pattern from vibeproxy (HTTP GET /v1/models) does not transfer. v1 ships a curated `MODELS` constant; `/droid-refresh` rewrites the cache file from this constant. The cache file remains valuable for `/droid-status` diagnostics and as a forward-compat slot if Factory ever ships `droid models list --json`.

5. **Pi has no permission/approval surface** — `ctx.ui.approve` does not exist. The `tool_call` extension event is for Pi's own tool registry only. Droid tools surface exclusively as `toolcall_*` events on the assistant content stream. The "double-gating bypass" is: SDK `permissionHandler: () => ToolConfirmationOutcome.ProceedOnce` (auto-approves at JSON-RPC boundary) + no `pi.on("tool_call", …)` (no Pi-level second gate). Droid's own `--auto medium` is the only autonomy gate.

6. **Cost reporting is structurally satisfied, semantically empty.** Factory bundles pricing into credit multipliers, not per-token dollar amounts. `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }` per model satisfies `Usage` type requirements; `calculateCost` writes zeros; Pi's footer shows `$0.00` per turn. Power users override via `modelOverrides`. Not a bug — a known scope decision.

7. **Subprocess parity is a non-issue.** The FRD's Wave-1 worry about long-lived child process management evaporates: SDK's `ProcessTransport` handles it. pi-droid is closer in structural complexity to vibeproxy than to a from-scratch subprocess wrapper.

## Precedents & Lessons

6 commits analyzed (vibeproxy initial commit + supporting docs/license). One sibling extension; no exact subprocess-wrapping precedent in the codebase or `@earendil-works/` examples.

### Precedent: pi-vibeproxy initial extension
**Commit(s)**: `9916000` — "feat(pi-vibeproxy): initial extension" (2026-05-15)
**Blast radius**: 9 files, all under `packages/pi-vibeproxy/` (+882 lines)
  - `src/` — six-file split: `index/config/discovery/providers/commands/types.ts`
  - `package.json`, `tsconfig.json`, `README.md`
**Zero top-level files touched** — `pnpm-workspace.yaml`, `tsconfig.base.json`, root `package.json` were all bootstrapped in prior commit `8f7c390`. pi-droid will slot in identically.

**Follow-up fixes (folded into the initial commit before landing, documented in `thoughts/shared/plans/2026-05-15_13-51-28_pi-vibeproxy-extension.md:1126-1175`)**:

Wave 1 (SDK rename + type drift, 2026-05-15T14:02:35):
- `@mariozechner/*` → `@earendil-works/*` rename (peer-deps + import types)
- `ProviderConfig.name` typecheck failure → bump to ^0.74.0
- `ui.notify` literal narrowing — there is NO `"success"` variant, only `"info"|"warning"|"error"`
- Toolchain bumps: `typescript ^5.7.3`, `@types/node ^24.3.0`, `pnpm@11.1.2`

Wave 2 (UX gaps from "thin discovery", 2026-05-15T14:29:28):
- Reasoning toggle never enabled — every model registered with `reasoning: false`
- Image input missing
- Thinking-level dropdown capped at `high` — Pi's TUI gates `xhigh` on `model.thinkingLevelMap.xhigh` defined (`@earendil-works/pi-ai/dist/models.js:35-40`)
- Context window stuck at 128K
- Resolution: `familyDefaults()` + `defaultThinkingLevelMap()` + `defaultLimits()`; per-model id-pattern defaults allowed for **family routing only**, not capability inference

### Composite Lessons (ranked for pi-droid)

1. **Plan family/model defaults up front.** Discovery returning thin metadata forces a choice between "every model is text-only / no reasoning / 128K" or "narrowly-scoped first-party-mirror defaults." pi-droid's curated list MUST encode reasoning levels (per `docs.factory.ai/models.md`), context windows (per upstream vendor docs), and `thinkingLevelMap` from day 0. Wave-2 was a 30-LOC fix in vibeproxy; missing the same in pi-droid means UX gaps on smoke test (commit `9916000` follow-ups).

2. **`ui.notify` literal narrowing**: only `"info" | "warning" | "error"` — never `"success"`. Encode in TypeScript from day 0 (precedent: Wave-1 typecheck failure).

3. **`ctx.hasUI` gating is mandatory** for `session_start` (early-return when headless, `index.ts:51`) and command handlers (vibeproxy's `notify()` helper at `commands.ts:79-87` switches between `ui.notify` and `console.{log,error}`).

4. **`PLACEHOLDER_API_KEY = "no-key"` workaround precedent.** Pi rejects empty `apiKey` when `models` set. pi-droid does NOT need this (uses `"FACTORY_API_KEY"` env-var name) but should follow the comment-the-workaround discipline at `providers.ts:4-8`.

5. **Discovery must never brick Pi — always register *something*.** vibeproxy `DiscoveryResult { models, usedFallback, error?, httpStatus? }` always returns *some* model list. pi-droid's curated constant has the same property (cannot fail). On `droid` binary missing → still register providers, but `ctx.ui.notify("warning", "droid binary not found at <path>; configure DROID_BINARY")`.

6. **`CONFIG_PATH_FOR_DIAGNOSTICS` export pattern.** Every user-facing error in vibeproxy points back to `~/.pi/agent/vibeproxy.json`. Mirror as `~/.pi/agent/droid.json` (`config.ts:123` precedent).

7. **Async factory > `session_start` for registration.** Discovery + `registerProvider` go in the factory body; UI-facing notify goes in `session_start` (`index.ts:46-67` precedent). The factory completes before `pi --list-models` runs.

8. **`pi.unregisterProvider` is the cleanup for `/refresh`.** vibeproxy's `safeUnregister` (`providers.ts:79-85`) handles "not previously registered." pi-droid is one provider, not partitioned — `/droid-refresh` simply calls `pi.registerProvider("droid", { …, models: newModels })` (idempotent per `types.d.ts:866-873`).

9. **SDK version drift is real.** Originally planned against `@mariozechner/pi-coding-agent@0.67.68`; actual install `@earendil-works/pi-coding-agent@0.74.0`. pi-droid pins same `^0.74.0` devDeps; peer-deps stay `"*"`.

10. **Monorepo blast radius is essentially nil.** Only required top-level edit: append one row to root `README.md`'s Packages table (precedent: `05c697c`). `pnpm-workspace.yaml`, `tsconfig.base.json` already accept the new package.

11. **The "no code from MVP" rule is a feature.** vibeproxy forbade porting from `pi-proxy-models@0.0.4`. The discipline forced cleaner module seams (six-way split) that pi-droid should inherit verbatim — even where the SDK-backed transport diverges from HTTP, the file boundaries hold.

12. **`tsconfig.base.json:1-15`'s `noUncheckedIndexedAccess: true` constraint.** Array/record indexing yields `T | undefined`. Plan for it: `cache.models[0]` is `DroidModel | undefined`. Use `.filter`/`for..of` instead of `[]` access where possible.

## Historical Context (from thoughts/)
- `thoughts/shared/discover/2026-05-15_15-00-31_pi-droid-factory-ai-provider.md` — FRD this research is chained from
- `thoughts/shared/discover/2026-05-15_12-22-01_proxy-model-vibeproxy-extension.md` — vibeproxy FRD (first cut named "proxy-model"; FR-3 put config in-package, later overridden)
- `thoughts/shared/research/2026-05-15_12-31-41_proxy-model-vibeproxy-extension.md` — vibeproxy research; settles `~/.pi/agent/vibeproxy.json` location + "no SSE in extension" lesson
- `thoughts/shared/designs/2026-05-15_13-23-34_pi-vibeproxy-extension.md` — vibeproxy design; pins six-file split, env→file→defaults config, `"no-key"` workaround
- `thoughts/shared/plans/2026-05-15_13-51-28_pi-vibeproxy-extension.md` — vibeproxy plan; contains two follow-up sections (Wave 1 + Wave 2 fixes)

## Developer Context

**Q (discover: Use a Factory subscription inside Pi): What problem are you solving by exposing Factory.AI Droid models inside Pi, and who hits it today?**
A: Use the developer's existing Factory.AI subscription as a model backend inside Pi.

**Q (discover: Factory access surface unconfirmed at intent time): How do you access Factory.AI Droid models today — HTTP API or only CLI/app?**
A: Not sure — haven't tested API access. (Triggered the codebase probe to discover the surface.)

**Q (discover: Factory does NOT expose an OpenAI/Anthropic-compatible model endpoint):**
A: Confirmed. Factory's public REST API (`https://api.factory.ai/api/v0/`) covers sessions/computers only and is gated to selected orgs; the documented integration surface is `droid exec --input-format stream-jsonrpc --output-format stream-jsonrpc`.

**Q (discover: Wrap droid exec JSON-RPC as a Pi provider): Given Factory exposes Droid as an agent, not as a model endpoint, which shape do you want?**
A: Wrap `droid exec` JSON-RPC as a Pi provider.

**Q (discover: Package shape mirrors pi-vibeproxy; transport is streamSimple, not HTTP):**
A: Confirm all four: new package `packages/pi-droid/` with the same six-file split; transport is pi-ai's `streamSimple` JS-function hook with a custom `api` string; no localhost HTTP server; no `/v1/models` HTTP discovery; auth via existing `FACTORY_API_KEY` env + installed `droid` binary.

**Q (discover: Long-lived subprocess, multiplex turns): How should we manage the droid exec subprocess lifecycle?**
A: Long-lived subprocess, multiplex turns via `droid.add_user_message` / `droid.session_notification`.

**Q (discover: Pass through Droid tool events as Pi tool-calls): How should Droid's tool calls surface in Pi?**
A: Pass through Droid tool events as Pi tool-calls.

**Q (discover: Default --auto medium, per-model override): What --auto level should pi-droid pass to droid exec by default?**
A: `--auto medium` default, per-model override.

**Q (discover: Spawn droid once for discovery, cache to disk): How should we declare which Droid models are available to Pi?**
A: Spawn droid once for discovery, cache to `~/.pi/agent/droid-cache.json`; refresh via `/droid-refresh`. **NOTE: superseded by research finding below — no runtime probe exists; v1 uses curated constant + cache file.**

**Q (discover: Three vibeproxy-style commands + /droid-restart): Which slash commands should the extension register?**
A: `/droid-status`, `/droid-models`, `/droid-refresh`, plus `/droid-restart`.

**Q (discover: Full v1 acceptance criteria):**
A: Confirm all six acceptance criteria (typecheck, list-models, streaming prompt, tool-passthrough visible, `/droid-status` reports state, `/droid-restart` recovers).

---

**Q (research: `Factory-AI/droid-sdk-typescript/src/{session,protocol,stream}.ts` — SDK exists and covers every layer): Use the official `@factory/droid-sdk` (Node 18+, MIT) to handle JSON-RPC framing, session lifecycle, abort wiring, and notification typing — or hand-roll JSON-RPC against `droid exec --input-format stream-jsonrpc`?**
A: Use `@factory/droid-sdk` (Recommended). Adds one `dependencies` block to package.json (vibeproxy has none — minor parity break) but cuts ~400 LOC and reuses Factory's tested framing.

**Q (research: `docs.factory.ai/cli/droid-exec/overview.md` flag table excludes `--list-models` — no runtime probe exists): How should pi-droid source its model list?**
A: Curated static list mirroring `docs.factory.ai/models.md`, no runtime probe. Cache file at `~/.pi/agent/droid-cache.json` exists for diagnostics + future forward-compat. `/droid-refresh` rewrites cache from the curated constant.

## Related Research
- `thoughts/shared/research/2026-05-15_12-31-41_proxy-model-vibeproxy-extension.md` — vibeproxy research (Pi extension contract mapping, `~/.pi/agent/<name>.json` location decision)

## Open Questions

Carried forward from FRD:
- **Pi cancellation propagation to `droid.interrupt_session`.** SDK `session.stream({ abortSignal })` handles this internally (per `session.ts:stream`), but verify behavior on Ctrl+C during a long Droid turn — does the stream cleanly throw and pi-droid push `{type: "error", reason: "aborted"}`, or does it hang waiting for the subprocess?
- **Whether `droid.ask_user` server-to-client requests should be auto-approved silently** or surfaced as Pi prompts. Current decision (carried from FRD): SDK default of `{cancelled: true}` — interactive questions cancel. Revisit if UX demands it.

New from research:
- **Tool-result events from Droid.** Decision in mapping table is "drop" — but Droid emits `ToolResult` notifications that contain the actual tool execution output. Dropping them means the assistant text following the tool call is the only user-visible trace. Verify in v1 smoke test whether this is acceptable or whether we need to surface them as informational text deltas / a synthetic content block.
- **Reasoning-level mapping for non-standard Factory variants.** Models like `gpt-5.2` advertise `Off/Low(default)/Medium/High/ExtraHigh` while `minimax-m2.7` only supports `High(default)`. pi-droid's `thinkingLevelMap` must encode these per-model; verify against Pi UI behavior when a model declares fewer levels than Pi's UI offers.
- **`droid` binary version compatibility.** SDK `Factory-AI/droid-sdk-typescript@main` was last updated… (check release dates). If user's local `droid` binary predates the SDK's expected JSON-RPC schema, what's the failure mode? Add a `/droid-status` field for `droid --version` output for diagnostics.
