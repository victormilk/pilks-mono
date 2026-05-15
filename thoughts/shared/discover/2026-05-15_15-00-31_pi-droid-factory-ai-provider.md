---
date: 2026-05-15T15:00:31-0300
author: victormilk
commit: 45ce480
branch: main
repository: pilks-mono
topic: "pi-droid: Factory.AI Droid models as a Pi provider"
tags: [intent, frd, pi-extension, pi-droid, factory-ai, droid-exec, jsonrpc, streamSimple]
status: complete
last_updated: 2026-05-15T15:00:31-0300
last_updated_by: victormilk
---

# FRD: pi-droid — Factory.AI Droid models as a Pi provider

## Summary
A new monorepo package `@victormilk/pi-droid` that exposes Factory.AI's Droid agent (via the `droid exec --input-format stream-jsonrpc` subprocess) as a Pi Coding Agent model provider. Mirrors the six-file shape of `packages/pi-vibeproxy/` but replaces HTTP transport with an in-process JS function (`streamSimple`) that owns the `droid` child process and translates Droid JSON-RPC events into Pi's `AssistantMessageEventStream`.

## Problem & Intent
The developer has a Factory.AI subscription and wants to use Factory's Droid models inside Pi rather than being limited to Pi's built-in providers. Today the only access path is the `droid` CLI / Factory App — there is no OpenAI- or Anthropic-compatible HTTP endpoint to point Pi at — so the integration has to wrap the CLI rather than wire a base URL.

## Goals
- Surface Factory Droid model IDs under a `droid/...` provider namespace so `/model droid/<id>` works inside Pi.
- Reuse the developer's existing `FACTORY_API_KEY` + locally-installed `droid` binary; no separate auth flow.
- Preserve Factory's agent semantics (Droid's own tools, prompt, autonomy gating) — Pi sees the work as it happens, not after-the-fact.
- Keep structural parity with `packages/pi-vibeproxy/` so the two packages share mental model and maintenance patterns.

## Non-Goals
- No reimplementation of Droid's tool/prompt/skills system inside Pi (the whole point is to delegate to Droid).
- No standalone HTTP server / OpenAI-compatible shim — the integration is in-process via `streamSimple`.
- No support for Factory's `/api/v0/sessions` public REST API (gated to selected orgs; out of scope).
- No "vanilla completions" mode that strips Droid's agent loop down to raw token streaming — agent-shaped is the contract.

## Functional Requirements
1. The extension SHALL register at least one Pi provider named `droid` with a custom `api` value (e.g. `"droid-exec"`) and a `streamSimple` handler that drives a `droid exec` subprocess.
2. The extension SHALL spawn a single long-lived `droid exec --input-format stream-jsonrpc --output-format stream-jsonrpc` subprocess at boot, multiplex multiple Pi turns through `droid.add_user_message`, and tear it down on Pi shutdown.
3. The extension SHALL discover available models by spawning `droid` once at first boot (e.g. `droid exec --list-tools --output-format json` or the closest available capability call) and cache the discovered model list to `~/.pi/agent/droid-cache.json`. The `/droid-refresh` command SHALL re-run discovery and re-register providers.
4. The extension SHALL forward Droid tool events (file edits, shell commands, browser actions, etc.) as Pi tool-calls in the `AssistantMessageEventStream` so Pi's UI shows the work in progress; Pi-side approvals SHALL auto-resolve since Droid applies its own autonomy gating.
5. The extension SHALL default the Droid autonomy level to `--auto medium`, with per-model override via `~/.pi/agent/droid.json`.
6. The extension SHALL load config from `~/.pi/agent/droid.json` with env-var overrides (`DROID_BINARY`, `FACTORY_API_KEY`) layered on top, mirroring `packages/pi-vibeproxy/src/config.ts`.
7. The extension SHALL register four slash commands: `/droid-status`, `/droid-models`, `/droid-refresh`, `/droid-restart`.
8. The extension SHALL validate that the `droid` binary is resolvable on PATH (or at the configured `droidBinary` path) at boot, and emit a `ctx.ui.notify` warning if not found.

## Non-Functional Requirements
- **Performance**: First-turn latency dominated by subprocess spawn + Droid session init (acceptable: ≤ 3s p95 on a warm machine). Subsequent turns reuse the long-lived subprocess — token-stream latency should match `droid exec` interactive.
- **Security**: No new secret handling — relies on Factory's `FACTORY_API_KEY` env var that the user already exports for `droid` CLI. Subprocess inherits the user's env. No outbound HTTP from the extension itself.
- **UX / Accessibility**: Streaming tokens visible in Pi UI as they arrive (no buffering full turn). Subprocess crashes surface as a Pi error message, not a silent hang; `/droid-restart` provides manual recovery.
- **Reliability**: Subprocess crash → auto-restart on next turn + log to `state.lastError`. Discovery-failure → fall back to a hard-coded curated model list and mark `usedFallback: true` (mirroring vibeproxy's pattern).

## Constraints & Assumptions
- Pi version ≥ 0.74.x, matching `packages/pi-vibeproxy/package.json` peer-dep ranges.
- `droid` CLI installed on PATH and authenticated (`FACTORY_API_KEY` exported or stored where `droid` expects).
- Pi's `streamSimple` hook is the supported extension point for non-HTTP transports — verified in `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:948-949`.
- `droid exec --input-format stream-jsonrpc` is the documented stable surface for custom integrations (`https://docs.factory.ai/cli/droid-exec/overview.md`).
- Pi extensions run as `.ts` via jiti — no build step (per `README.md`).
- Assumption: Droid JSON-RPC events for tool-calls map cleanly onto Pi's `AssistantMessageEventStream` event types (assistant text deltas, tool-call start/end, token-usage). To be verified during research/design.

## Acceptance Criteria
- [ ] `pnpm typecheck` passes from the monorepo root with the new `packages/pi-droid/` present.
- [ ] After `pi install ./packages/pi-droid`, running `pi --list-models` prints at least one `droid/<model-id>` entry.
- [ ] In a Pi session, running `/model droid/<discovered-id>` followed by a free-text prompt produces visible streaming tokens (not a single blocking response).
- [ ] A prompt that causes Droid to edit a file results in a tool-call rendered in Pi's UI (i.e., Droid's file-edit event surfaces as a Pi tool event, not as opaque text).
- [ ] `/droid-status` prints the subprocess PID and the value of `state.lastError` (or "ok" if none).
- [ ] `/droid-restart` kills the current subprocess and the very next `/model droid/...` prompt still streams successfully.

## Recommended Approach
New monorepo package `packages/pi-droid/` mirroring `packages/pi-vibeproxy/`'s six-file split (`index.ts`, `config.ts`, `discovery.ts`, `providers.ts`, `commands.ts`, `types.ts`). The single architectural difference is that `providers.ts` registers a Pi `ProviderConfig` with a custom `api` string and a `streamSimple` JS function — that function owns a long-lived `droid exec --input-format stream-jsonrpc` child process, pumps newline-delimited JSON-RPC events from the subprocess into an `AssistantMessageEventStream`, and translates Droid tool events into Pi tool-call events.

## Decisions

### Use a Factory subscription inside Pi
**Question**: What problem are you solving by exposing Factory.AI Droid models inside Pi, and who hits it today?
**Recommended**: n/a — `intent` question
**Chosen**: Use the developer's existing Factory.AI subscription as a model backend inside Pi.
**Rationale**: Developer framing — they already pay for Factory and want Pi to route to it.

### Factory access surface unconfirmed at intent time
**Question**: How do you access Factory.AI Droid models today — HTTP API or only CLI/app?
**Recommended**: n/a — `intent`-tier scoping question
**Chosen**: Not sure — haven't tested API access.
**Rationale**: Triggered the codebase probe to discover the surface (Step 3).

### Factory does NOT expose an OpenAI/Anthropic-compatible model endpoint
**Question**: Pre-resolved from web docs evidence — confirmed at the shape question.
**Recommended**: n/a (evidence-grounded)
**Chosen**: Confirmed. Factory's public REST API (`https://api.factory.ai/api/v0/`) covers sessions/computers only and is gated to selected orgs; the documented integration surface is `droid exec --input-format stream-jsonrpc --output-format stream-jsonrpc` (per `https://docs.factory.ai/cli/droid-exec/overview.md`).
**Rationale**: evidence: docs.factory.ai/llms.txt + docs.factory.ai/cli/droid-exec/overview.md + docs.factory.ai/api-reference/sessions/create-a-session.md.

### Wrap `droid exec` JSON-RPC as a Pi provider
**Question**: Given Factory exposes Droid as an agent (JSON-RPC over `droid exec` stdin/stdout), not as a model endpoint, which shape do you want?
**Recommended**: Wrap `droid exec` JSON-RPC as a Pi provider.
**Chosen**: Wrap `droid exec` JSON-RPC as a Pi provider.
**Rationale**: Best fit — keeps the integration in-process (no standalone HTTP shim) and consumes Factory's documented stable surface.

### Package shape mirrors pi-vibeproxy; transport is streamSimple, not HTTP
**Question**: Pre-resolved from codebase evidence — batch-confirmed.
**Recommended**: New package `packages/pi-droid/` with the same six-file split as `packages/pi-vibeproxy/src/`; transport is pi-ai's `streamSimple` JS-function hook with a custom `api` string; no localhost HTTP server; no `/v1/models` HTTP discovery; auth via existing `FACTORY_API_KEY` env + installed `droid` binary.
**Chosen**: Confirm all four.
**Rationale**: evidence: `packages/pi-vibeproxy/src/providers.ts:60-66` (registerProvider shape) + `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:948-949` (`streamSimple` hook) + `packages/pi-vibeproxy/node_modules/@earendil-works/pi-ai/dist/types.d.ts:4-5` (`Api` accepts open string).

### Long-lived subprocess, multiplex turns
**Question**: How should we manage the `droid exec` subprocess lifecycle?
**Recommended**: Long-lived subprocess, multiplex turns via `droid.add_user_message` / `droid.session_notification`.
**Chosen**: Long-lived subprocess, multiplex turns.
**Rationale**: Lowest per-turn latency and preserves Droid's session memory; subprocess-lifecycle complexity is acceptable.

### Pass through Droid tool events as Pi tool-calls
**Question**: How should Droid's tool calls (file edits, shell commands, etc.) surface in Pi?
**Recommended**: Pass through Droid tool events as Pi tool-calls.
**Chosen**: Pass through Droid tool events as Pi tool-calls.
**Rationale**: Transparency — Pi UI shows Droid's work as it happens; double-gating (Pi + Droid autonomy) is accepted complexity.

### Default `--auto medium`, per-model override
**Question**: What `--auto` level should `pi-droid` pass to `droid exec` by default?
**Recommended**: `--auto medium`, configurable per-model.
**Chosen**: `--auto medium` default, per-model override.
**Rationale**: Matches Pi's typical "auto-approve common dev tasks" feel without giving away `git push` / sudo by default.

### Spawn droid once for discovery, cache to disk
**Question**: How should we declare which Droid models are available to Pi?
**Recommended**: Static list in config with one default-on entry.
**Chosen**: Spawn droid once for discovery, cache to `~/.pi/agent/droid-cache.json`; refresh via `/droid-refresh`.
**Rationale**: Avoids per-release staleness; one-time spawn cost is acceptable; falls back to a hard-coded curated list if discovery fails.

### Three vibeproxy-style commands + `/droid-restart`
**Question**: Which slash commands should the extension register?
**Recommended**: Mirror vibeproxy's three commands.
**Chosen**: `/droid-status`, `/droid-models`, `/droid-refresh`, plus `/droid-restart`.
**Rationale**: Subprocess wrapper benefits from an explicit kick-it lever the HTTP-proxy sibling doesn't need.

### Full v1 acceptance criteria
**Question**: Acceptance criteria for v1 — confirm or adjust?
**Recommended**: Six-criterion bundle (typecheck, list-models, streaming prompt, tool-passthrough visible, `/droid-status` reports state, `/droid-restart` recovers).
**Chosen**: Confirm all six.
**Rationale**: Each criterion is observable without reading code; together they verify the four functional requirements that carry user-visible risk.

## Open Questions
- Exact mapping from Droid JSON-RPC events (`droid.session_notification` subtypes — assistant text deltas, tool-call events, token-usage, errors, turn-complete) to Pi's `AssistantMessageEventStream` event types. To be answered in `research`.
- How `droid exec` model discovery actually works — is there a `--list-models` flag, do we infer from `--list-tools --output-format json`, or do we have to grep `https://docs.factory.ai/models.md`? Discovery shape may collapse to "static curated list" if no good runtime call exists.
- Whether `droid.request_permission` server-to-client requests should be auto-approved silently or surfaced as Pi prompts — current decision is auto-approve under Droid's own autonomy gating, but UX may push back.
- Whether Pi cancellation (Ctrl+C / `pi.on("turn_cancel", …)` or equivalent) needs to send `droid.interrupt_session` — not in v1 acceptance bar, but a likely v2 follow-up.

## Suggested Follow-ups
- Factory's public REST `/api/v0/sessions` API exists (`https://docs.factory.ai/api-reference/sessions/create-a-session.md`) and is a cleaner long-term surface than `droid exec` JSON-RPC, but is currently gated to "selected organizations" — revisit when generally available.
- A standalone OpenAI-compatible HTTP shim that wraps `droid exec` would be reusable beyond Pi (Continue.dev, Cline, etc.) — deferred as a separate project, not part of this FRD.
- Factory ships official SDKs (`@factory/droid-sdk` TypeScript, `droid-sdk` Python) — research should check whether using the TypeScript SDK is preferable to hand-rolling the JSON-RPC framing.

## References
- `packages/pi-vibeproxy/` — sibling package, structural precedent.
- `packages/pi-vibeproxy/src/providers.ts:60-66` — `pi.registerProvider` call shape to mirror.
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:948-949` — `streamSimple` hook signature.
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-ai/dist/types.d.ts:4-5` — open `Api` type.
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/examples/extensions/custom-provider-gitlab-duo/index.ts:268-282` — working `streamSimple` example to pattern-match against.
- `https://docs.factory.ai/cli/droid-exec/overview.md` — `droid exec` flags, JSON-RPC stream mode, custom-flow guidance.
- `https://docs.factory.ai/api-reference/sessions/create-a-session.md` — Factory public REST API (sessions gated to selected orgs).
- `https://docs.factory.ai/llms.txt` — full Factory docs index.
- `https://github.com/Factory-AI/droid-sdk-typescript` — official TS SDK (potential alternative to hand-rolled JSON-RPC).
