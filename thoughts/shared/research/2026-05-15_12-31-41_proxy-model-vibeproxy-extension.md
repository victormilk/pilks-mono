---
date: 2026-05-15T12:31:41-0300
author: victor
commit: no-commit
branch: no-branch
repository: pilks-mono
topic: "Proxy Model extension for VibeProxy (CLIProxyAPIPlus) in Pi Coding Agent"
tags: [research, codebase, pi-coding-agent, pi-package, custom-provider, vibeproxy, cliproxyapiplus, proxy-model, rewrite]
status: complete
last_updated: 2026-05-15T12:31:41-0300
last_updated_by: victor
---

# Research: Proxy Model extension for VibeProxy (CLIProxyAPIPlus) in Pi Coding Agent

## Research Question
From FRD `thoughts/shared/discover/2026-05-15_12-22-01_proxy-model-vibeproxy-extension.md`:
> New `packages/proxy-model/` extension and `packages/core/` shared package inside a pnpm + TypeScript monorepo; the extension registers with Pi Coding Agent's documented extension API as a model provider, reads a local config file for VibeProxy URL/credentials/protocol selection, and forwards streaming chat-completion and tool-call requests to VibeProxy in either OpenAI `/v1/chat/completions` or Anthropic `/v1/messages` shape per request.

Anchor questions the analysis phase needed to settle:
- What is "Pi Coding Agent" and what's its extension contract?
- Is "VibeProxy" a separate product, and does it have direct precedent in the local ecosystem?
- How should the extension expose both OpenAI and Anthropic surfaces given Pi's provider model?
- What does the v1 install/build path actually look like for a Pi-loaded TypeScript extension?

## Summary
Pi Coding Agent (`@mariozechner/pi-coding-agent`, alias `@earendil-works/pi-coding-agent`) has a fully documented extension API — `pi.registerProvider(name, ProviderConfig)` with built-in `api: "openai-completions" | "anthropic-messages"` streaming (handles SSE + tool calls via `@mariozechner/pi-ai`), loaded via jiti so no build step is required. **VibeProxy = CLIProxyAPIPlus** (https://github.com/router-for-me/CLIProxyAPIPlus); the developer already ships a working MVP, `pi-proxy-models` v0.0.4, that registers CLIProxyAPIPlus models against Pi by partitioning models into per-family providers.

**`pilks-mono` is a deliberate full-rewrite-from-zero of that MVP into a pnpm monorepo.** Per developer instruction: NO code from `pi-proxy-models` is to be copied or ported. The MVP is consulted for *what to build* — Pi's contract, CLIProxyAPIPlus's HTTP surface, known integration quirks (e.g., the `"no-key"` placeholder, async-factory model discovery, partition-by-family) — but every file in `pilks-mono/packages/proxy-model/` is to be written fresh. The integration shape is settled: register two (or three, if Gemini is in scope) providers — one per upstream `api` — backed by a single CLIProxyAPIPlus baseUrl with different path suffixes; rely entirely on pi-ai's built-in streaming/tool-call implementations; load config from `~/.pi/agent/vibeproxy.json` (matching the Pi ecosystem convention, overriding FRD FR-3 which placed config inside the package).

## Detailed Findings

### Pi Coding Agent extension contract
- Loaded via jiti from `~/.pi/agent/extensions/`, `.pi/extensions/`, or a pi-package's `pi.extensions` manifest (`@mariozechner/pi-coding-agent/docs/extensions.md:1-32`).
- Entry point: `export default function (pi: ExtensionAPI) { … }`, may be `async`. Async factories are awaited before `--list-models` runs (`docs/custom-provider.md:69`).
- Auto-discovery placements support `/reload` for hot-reload (`docs/extensions.md:7`).

### Provider registration API
- `pi.registerProvider(name, ProviderConfig)` — `name`, `baseUrl`, `apiKey` (env var name OR literal value), `api`, `models[]`, optional `headers`, `authHeader`, `oauth`, `streamSimple` (`docs/custom-provider.md:38-69, 130-160`).
- Built-in `api` values: `"openai-completions"`, `"anthropic-messages"`, `"openai-responses"`, `"google-generative-ai"`, plus Mistral/Bedrock/Vertex/Azure variants (`docs/custom-provider.md:213-230`).
- When `models` is supplied, it **replaces** all existing models for that provider name (`docs/custom-provider.md:151`).
- `pi.unregisterProvider(name)` restores built-in behavior if it was overridden (`docs/custom-provider.md:185`).
- One provider = one `baseUrl` + one `api`. Multiple protocols → multiple provider registrations (this is the load-bearing constraint for VibeProxy — confirmed by precedent in `pi-proxy-models/index.ts:54-80`).

### Streaming and tool calls are NOT extension concerns
- Built-in `api` strings route to streaming implementations inside `@mariozechner/pi-ai` (anthropic.ts, openai-completions.ts) that already handle SSE framing, `tool_calls` / `tool_use` / `tool_result` semantics, and partial-JSON tool-argument deltas.
- Custom `streamSimple` is only needed for non-standard wire formats (e.g., GitLab Duo's auth flow in `examples/extensions/custom-provider-gitlab-duo/index.ts:225-280`). VibeProxy speaks vanilla OpenAI + Anthropic shapes, so no `streamSimple` is required.
- Pi's tool-call event stream is `AssistantMessageEventStream` with `text_*` / `thinking_*` / `toolcall_*` events (`docs/custom-provider.md:285-320`).

### VibeProxy = CLIProxyAPIPlus
- Repo: https://github.com/router-for-me/CLIProxyAPIPlus (referenced in `pi-proxy-models/index.ts:4`).
- Surface (per the existing MVP):
  - `GET /v1/models` → `{ data: [{ id, owned_by, object?, created? }] }` (`pi-proxy-models/index.ts:153-168`).
  - `POST /v1/messages` → Anthropic Messages (baseUrl suffix `""`, `pi-proxy-models/index.ts:55-60`).
  - `POST /v1/chat/completions` → OpenAI Completions (baseUrl suffix `/v1`, `pi-proxy-models/index.ts:61-67`).
  - `POST /v1beta/...` → Google Generative AI (baseUrl suffix `/v1beta`, `pi-proxy-models/index.ts:68-74`).
- Auth: optional `Authorization: Bearer <key>`; CLIProxyAPIPlus accepts unauthenticated requests when its own `api-keys:` list is empty. The MVP uses a placeholder `"no-key"` when none is configured to satisfy Pi's non-empty-`apiKey` validation when `models` is set (`pi-proxy-models/index.ts:83, 245`).
- Identifies models via request body `model` field; the family-classification logic at `pi-proxy-models/index.ts:178-185` partitions by `owned_by` / `id` substring.

### MVP precedent (pi-proxy-models v0.0.4) — REFERENCE-ONLY, no code reuse
> **DO NOT COPY OR PORT CODE FROM THIS PACKAGE.** Per explicit developer instruction, the rewrite is from scratch. Citations here describe *what the MVP did* so design can decide *whether to do the same thing differently*. The `pi-proxy-models/index.ts:NN` references below are read-only research evidence, NOT files to be inherited from.

- Shape observed: single-file extension (`pi-proxy-models/index.ts:1-345`) + `package.json` with `pi: { extensions: ["./index.ts"] }` + `tsconfig.json` with `noEmit: true`, `allowImportingTsExtensions: true`. No build step. **v2 decision pending** in design — same shape per module, multi-file structure, etc.
- Config observed: env vars (`CLIPROXY_URL`, `CLIPROXY_API_KEY`) layered over `~/.pi/agent/cliproxy.json` (`pi-proxy-models/index.ts:96-129`). **v2 decision pending** — the developer has already chosen `~/.pi/agent/vibeproxy.json` as the location, but layering / schema / env-var fallback policy is a design call.
- Startup observed: async extension factory fetches `/v1/models`, falls back to a hardcoded list on failure, registers up to 3 providers (`cliproxy` / `cliproxy-openai` / `cliproxy-gemini`), and exposes `/cliproxy-status`, `/cliproxy-models`, `/cliproxy-refresh` commands (`pi-proxy-models/index.ts:310-345`). **The async-factory + discovery + fallback PATTERN is load-bearing** (Pi needs models before `--list-models` runs); the v2 implementation of that pattern is fresh code.
- Capability inference observed: hand-coded substring matching on model id (`pi-proxy-models/index.ts:191-237`). **Explicitly flagged for redesign** — substring heuristics is the MVP's main pain point. v2 should consider config-driven defaults rather than recreating the `if (l.includes(...))` ladder.
- Per-model overrides observed: `contextOverrides` / `maxTokensOverrides` maps + comma-string env var (`pi-proxy-models/index.ts:96-145`). **Useful feature, fresh implementation in v2.**
- Hardcoded fallback list observed at `pi-proxy-models/index.ts:265-273`. **v2 decision pending** — keep, drop, or move to config?
- Quirk: a placeholder `"no-key"` apiKey is needed when CLIProxyAPIPlus is unauthenticated, because Pi validates `apiKey` non-empty when `models` is set (`pi-proxy-models/index.ts:82-84, 245`). **This Pi-side validation quirk is real and load-bearing — v2 must reproduce the workaround behavior, but the code expressing it is fresh.**

### Pi-package distribution shape
- `package.json` declares `"pi": { "extensions": [...], "skills": [...], "prompts": [...], "themes": [...] }` and `"keywords": ["pi-package"]` (`docs/packages.md:101-117`).
- Peer-dependency conventions: `@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`, `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `typebox` listed with `"*"` range, NOT bundled (`docs/packages.md:148-150`).
- Install paths: `pi install npm:<pkg>` / `pi install git:<repo>` / `pi install <local-path>` / `pi -e <path>` for one-off (`docs/packages.md:18-49`).
- Pi runs `npm install` after clone, so `dependencies` are installed automatically (`docs/packages.md:148`).
- No bundler/build step required for ts entry points — jiti handles `.ts` directly. `pi-proxy-models/tsconfig.json` is `noEmit: true`.

### `pilks-mono` repo state
- Greenfield. Only `.pi/agents/*.md` (skill agent definitions provided by `@juicesharp/rpiv-pi`) and empty `thoughts/shared/{discover,research,designs,plans,handoffs,reviews}/` exist.
- No prior `package.json`, no workspace config, no source.
- `@juicesharp/rpiv-pi` is installed via mise/node globals at `/Users/victor/.local/share/mise/installs/node/24.15.0/lib/node_modules/@juicesharp/rpiv-pi/` — it provides the skill-driven workflow this repo is using, NOT the extension target. The extension target is `@mariozechner/pi-coding-agent` (alias `@earendil-works/pi-coding-agent`).

## Code References

### Pi platform docs & API (the contract v2 implements against)
- `@mariozechner/pi-coding-agent/docs/extensions.md:1-110` — extension API overview, quick-start, lifecycle events.
- `@mariozechner/pi-coding-agent/docs/custom-provider.md:33-69` — `ProviderConfig` shape, async factory pattern, `--list-models` semantics.
- `@mariozechner/pi-coding-agent/docs/custom-provider.md:130-230` — built-in `api` types, `compat` flags, `authHeader`.
- `@mariozechner/pi-coding-agent/docs/custom-provider.md:235-330` — OAuth + `streamSimple` reference (NOT needed for VibeProxy).
- `@mariozechner/pi-coding-agent/docs/packages.md:101-160` — pi-package manifest, peer-deps, install sources.
- `@mariozechner/pi-coding-agent/examples/extensions/custom-provider-gitlab-duo/index.ts:1-330` — reference for `streamSimple` shape (not needed for VibeProxy).
- `@mariozechner/pi-coding-agent/examples/extensions/custom-provider-anthropic/` — reference for a minimal provider extension layout.

### MVP (`pi-proxy-models`) — REFERENCE-ONLY behavior map, no code reuse
> Cited only to document the behavior v2 must (or must not) reproduce. None of these files are to be copied.
- `pi-proxy-models/index.ts:1-50` — header docstring + types describing the partition-by-family pattern (behavior reference).
- `pi-proxy-models/index.ts:50-80` — `FAMILIES` const, per-family `(providerName, api, baseSuffix)` table (the *shape* v2's registration table needs to express, written from scratch).
- `pi-proxy-models/index.ts:96-145` — MVP config loader (what fields existed). v2 will define its own schema.
- `pi-proxy-models/index.ts:153-168` — MVP `fetchModels` (documents `/v1/models` response shape: `{ data: [{ id, owned_by, ... }] }`).
- `pi-proxy-models/index.ts:178-260` — MVP classification + inference (the area explicitly NOT to be carried over).
- `pi-proxy-models/index.ts:240-263` — MVP `registerFamilies` (documents the stale-registration cleanup pattern with `unregisterProvider`).
- `pi-proxy-models/index.ts:275-310` — MVP command surface (`/cliproxy-status` etc.); v2 will name its own commands.
- `pi-proxy-models/index.ts:312-345` — MVP async entry point (documents the factory-as-discovery pattern).
- `pi-proxy-models/package.json:1-32` — pi-package manifest shape (reference for v2's package.json schema, NOT to be copied).

## Integration Points

### Inbound References
- `pi.registerProvider("vibeproxy", ProviderConfig)` — registers the Anthropic-surface provider with Pi's provider registry. Consumed by Pi's model picker, `/login`, `pi --list-models`. (`docs/custom-provider.md:38`)
- `pi.registerProvider("vibeproxy-openai", ProviderConfig)` — registers the OpenAI-surface provider. Same consumer set.
- `pi.registerCommand(name, handler)` — for `/vibeproxy-status`, `/vibeproxy-models`, `/vibeproxy-refresh` (mirroring MVP commands). (`docs/extensions.md:80-95`)
- `pi.on("session_start", ...)` — startup-notify hook for showing model count to the user. (`docs/extensions.md:60-65`, MVP at `pi-proxy-models/index.ts:333-345`)

### Outbound Dependencies
- `fetch("$VIBEPROXY/v1/models", { headers: { Authorization?: "Bearer …" } })` — CLIProxyAPIPlus model discovery.
- Streaming endpoints are called by pi-ai (not by this extension) — `POST /v1/messages` (anthropic-messages) and `POST /v1/chat/completions` (openai-completions). The extension only configures `baseUrl` / `apiKey` / `headers`; pi-ai owns the request lifecycle.
- Filesystem read: `~/.pi/agent/vibeproxy.json` for endpoint + credentials + per-model overrides.

### Infrastructure Wiring
- `packages/proxy-model/package.json` — `"pi": { "extensions": ["./index.ts"] }`, `"keywords": ["pi-package"]`, peer-dep on `@mariozechner/pi-coding-agent` (and likely `@mariozechner/pi-ai` for types).
- Root `pnpm-workspace.yaml` — declares `packages/*`.
- Root `package.json` — workspace root, devDeps (typescript), shared scripts.
- No build output wired to anywhere; Pi consumes the `.ts` file directly.

## Architecture Insights
- **Pi's provider abstraction is per-(baseUrl, api) tuple**, not per-request protocol. Any "protocol selection" in the extension must collapse to "which provider name + model entry the user picks." This inverts FRD FR-6's "selectable per request" framing — selection happens at model-pick time, not at request time.
- **No SSE code in the extension.** Built-in `api: "openai-completions"` and `api: "anthropic-messages"` strings activate pi-ai's streaming implementations, which already handle tool-call streaming faithfully. Custom `streamSimple` would be needed only for non-vanilla wire formats — not VibeProxy's case.
- **No build step needed.** Jiti loads `.ts` directly. `pi-proxy-models/tsconfig.json` runs `noEmit: true` and uses `allowImportingTsExtensions: true`. The FRD's `pnpm --filter proxy-model build` acceptance criterion should be replaced with `pnpm --filter proxy-model typecheck` (or removed).
- **Async factory > `session_start`** for model registration. Per `docs/custom-provider.md:69`, the factory is awaited before `--list-models` runs, so dynamic model discovery belongs in the factory body, with a fallback list for when the proxy is unreachable.
- **Config-file location convention**: `~/.pi/agent/<extension>.json`. In-package config files get clobbered by `pi update`; the MVP correctly uses `~/.pi/agent/cliproxy.json`. The FRD's FR-3 ("config file located inside the extension package") needs to be revised in design — the developer confirmed `~/.pi/agent/vibeproxy.json` in the checkpoint.
- **Empty-apiKey workaround**: Pi's `ProviderConfig` validation rejects empty `apiKey` when `models` is set; the MVP sends `"no-key"` placeholder when CLIProxyAPIPlus is unauthenticated. This is a known Pi quirk — design must keep it.
- **MVP fragility surface** (primary v2 rewrite target): the substring-based capability/limit inference at `pi-proxy-models/index.ts:191-237` is a brittle pile of `if (l.includes(...))` rules. A clean v2 should either (a) drive limits exclusively from the config file with sane defaults, (b) accept upstream `/v1/models` extensions if CLIProxyAPIPlus learns to expose them, or (c) keep the heuristic but isolate it behind a tested boundary. Design will pick.

## Precedents & Lessons
git history unavailable (greenfield repo, `no-commit`). The relevant "precedent" is **the developer's own published MVP `pi-proxy-models@0.0.4`**, which is exactly the feature being rewritten.

### Precedent: pi-proxy-models v0.0.4 — initial CLIProxyAPIPlus integration
**Commit(s)**: unavailable (separate npm package, installed at `/Users/victor/.local/share/mise/installs/node/24.15.0/lib/node_modules/pi-proxy-models/`).
**Blast radius**: single-file extension (`index.ts`, ~345 lines), 1 package.json, 1 tsconfig.json. Total: 3 files.

**Lessons distilled from MVP**:
- Partition-by-family across multiple `registerProvider` calls is the correct shape for CLIProxyAPIPlus.
- Async factory + `/v1/models` fetch + hardcoded fallback model list is the right startup pattern.
- Env vars + `~/.pi/agent/<name>.json` config-file pair survives `pi update` cleanly.
- Capability/limit inference by id-substring is the MVP's main pain point — anything mentioned in `inferLimits` / `inferReasoning` / `inferImageInput` is implicitly v2-rewrite-scope.
- The `"no-key"` placeholder workaround is mandatory for unauthenticated CLIProxyAPIPlus + Pi's validation; carry it forward.
- Per-model `contextOverrides` / `maxTokensOverrides` are a useful escape hatch — keep.
- Commands (`/<prefix>-status`, `/<prefix>-models`, `/<prefix>-refresh`) are a useful UX surface — keep.

**Takeaway**: The MVP got the integration architecture right; the rewrite's value is in moving heuristics out of inline `if` ladders, modularizing the family/limit/capability layers, and establishing the pnpm-monorepo home so additional Pi extensions can ship under the same repo.

### Composite Lessons
- Keep async-factory + `/v1/models` discovery + fallback-list pattern — it's load-bearing for `pi --list-models` UX.
- Keep per-family provider partitioning — Pi's `ProviderConfig` shape mandates it.
- Replace the id-substring capability/limit inference with config-driven defaults + per-model overrides; do not silently keep the MVP's inference rules.
- Keep config at `~/.pi/agent/vibeproxy.json` (override FRD FR-3).
- Drop the literal "build step" from acceptance; jiti loads `.ts` directly.

## Historical Context (from thoughts/)
- `thoughts/shared/discover/2026-05-15_12-22-01_proxy-model-vibeproxy-extension.md` — source FRD; intent, decisions, open questions. Several decisions (FR-3 config location, FR-9 core package, build-step acceptance criteria) are revised by checkpoint answers in this research.

## Developer Context

**Q (discover: Primary user and motivation): What problem does this Proxy Model extension solve, and who's the primary user hitting it today?**
A: "Me as the Pi Coding Agent user" — developer wants to route Pi Coding Agent's model calls through VibeProxy (own provider keys, custom routing, caching, observability) with no clean way to do that today.

**Q (discover: Integration shape): What does "Proxy Model extension" concretely mean — what's the integration shape?**
A: A model provider adapter — registers VibeProxy as a selectable model/provider in Pi Coding Agent.

**Q (discover: VibeProxy wire protocol): What protocol does VibeProxy speak on the wire?**
A: Both OpenAI `/v1/chat/completions` and Anthropic `/v1/messages`, selectable per request.

**Q (discover: Pi extension contract target): How does Pi Coding Agent load extensions?**
A: Pi Coding Agent's documented extension API.

**Q (discover: Source of the Pi extension contract): Where's the Pi extension API documented?**
A: Defer — leave contract as Open Question. (Resolved in this research: `@mariozechner/pi-coding-agent/docs/{extensions,custom-provider,packages}.md`.)

**Q (discover: Monorepo toolchain): What's the monorepo toolchain?**
A: pnpm workspaces + TypeScript.

**Q (discover: Configuration surface): How does the user configure VibeProxy?**
A: Config file in the extension package. (Revised by checkpoint Q2 in this research: `~/.pi/agent/vibeproxy.json`.)

**Q (discover: Streaming): Does the adapter need to stream responses?**
A: Streaming required (SSE). (Resolved: handled by pi-ai's built-in `api` strings — no SSE code in the extension.)

**Q (discover: Tool/function calling): Tool calls required?**
A: Tool/function calling required. (Resolved: handled by pi-ai's built-in `api` strings — no tool-call code in the extension.)

**Q (discover: Acceptance bar): How verify v1?**
A: Manual smoke test against a real VibeProxy.

**Q (discover: Monorepo layout): Just this extension, or also a shared `core`/`common` package now?**
A: Extension + shared `core` package. (Revised by checkpoint Q3 in this research: pnpm monorepo + `packages/proxy-model/` only, defer `packages/core/` until a second extension exists. FR-9 dropped.)

**Q (`@mariozechner/pi-coding-agent/docs/custom-provider.md:33-69`, MVP at `pi-proxy-models/index.ts:54-80`): Provider shape for both OpenAI and Anthropic surfaces?**
A: Two providers, partition by surface — `vibeproxy` (anthropic-messages) + `vibeproxy-openai` (openai-completions). Matches MVP precedent; zero custom streaming code (pi-ai owns SSE + tool calls). User picks protocol implicitly by picking a model.

**Q (`pi-proxy-models/index.ts:96` + `@mariozechner/pi-coding-agent/docs/packages.md:148`): Config file location?**
A: `~/.pi/agent/vibeproxy.json`. Matches MVP precedent (`~/.pi/agent/cliproxy.json`); survives `pi update`; outside repo for credential hygiene. Overrides FRD FR-3.

**Q (`pi-proxy-models/tsconfig.json:1-15` vs FRD acceptance `pnpm --filter proxy-model build`): Build step?**
A: pnpm monorepo, no `packages/core/` package yet, no build step. Pi loads `.ts` directly via jiti. Replace `build` acceptance with `typecheck`. Defer `packages/core/` until a second extension consumer materializes.

**Q (research checkpoint Q4-Q5): Is VibeProxy a separate product?**
A: No — VibeProxy = CLIProxyAPIPlus (https://github.com/router-for-me/CLIProxyAPIPlus). The developer's existing `pi-proxy-models@0.0.4` package is a working MVP of exactly this integration. `pilks-mono` is the developer's deliberate full rewrite of that MVP into a pnpm monorepo.

**Q (developer follow-up after research checkpoint): Should the v2 implementation port code from `pi-proxy-models`?**
A: **No — total rewrite from zero.** The MVP is reference-only for behavior (Pi contract, CLIProxyAPIPlus surface, known quirks like the `"no-key"` placeholder and async-factory discovery pattern). No source file in `pilks-mono/packages/proxy-model/` may be a copy, transformation, or line-by-line port of `pi-proxy-models/index.ts`. Design and implement skills must write fresh code that satisfies the same integration contract, with freedom (and the explicit instruction) to restructure away from the MVP's single-file + substring-heuristic shape.

## Related Research
None — this is the first research artifact for `pilks-mono`.

## Open Questions
- **Build tool inside the pnpm + TypeScript stack (tsup vs tsc vs other)** — FRD-deferred. The MVP uses `noEmit: true` + jiti runtime loading, so no build tool may be strictly needed. If publishing to npm and bundling deps is desired, design will pick (likely `tsup` for ESM output, or omit entirely and ship `.ts` like the MVP does).
- **Capability/limit inference v2 strategy** — does the rewrite (a) keep the id-substring heuristic isolated behind a tested module, (b) drive everything from `~/.pi/agent/vibeproxy.json` with sane defaults and no heuristics, or (c) extend CLIProxyAPIPlus to expose richer `/v1/models` metadata first? Open for design.
- **Gemini family inclusion** — MVP includes `google-generative-ai` as a third provider; FRD only names OpenAI + Anthropic. Should v2 include Gemini? (Implied yes if "feature-parity rewrite," explicit no if "strictly OpenAI + Anthropic.")
- **Package name(s)** — `proxy-model`, `vibeproxy`, `pi-proxy-models-v2`, scoped (`@victormilk/...`)? Decides npm publish path.
- **Pi-package distribution for v1** — `pi install <local-path>` against `packages/proxy-model/` during development; final publication target (npm package vs git repo) deferred.
