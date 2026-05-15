---
date: 2026-05-15T12:22:01-0300
author: victor
commit: no-commit
branch: no-branch
repository: pilks-mono
topic: "Proxy Model extension for VibeProxy in Pi Coding Agent"
tags: [intent, frd, proxy-model, vibeproxy, extension, monorepo]
status: complete
last_updated: 2026-05-15T12:22:01-0300
last_updated_by: victor
---

# FRD: Proxy Model extension for VibeProxy in Pi Coding Agent

## Summary
First extension in the `pilks-mono` Pi extensions monorepo. Registers VibeProxy as a selectable model provider inside Pi Coding Agent, so the developer can route model calls through their own VibeProxy instance instead of hitting upstream providers directly. Speaks both OpenAI Chat Completions and Anthropic Messages wire formats with streaming and tool-call support.

## Problem & Intent
"Me as the Pi Coding Agent user" — the developer wants Pi Coding Agent's model calls to flow through VibeProxy (for the developer's own provider keys, routing, observability, etc.) and there is no clean way to do that today. The extension exists to give a first-class, user-selectable path for that.

## Goals
- Ship a Pi Coding Agent extension that appears as a normal selectable model provider, with VibeProxy as the backing endpoint.
- Support both OpenAI `/v1/chat/completions` and Anthropic `/v1/messages` wire formats, selectable per request.
- Stream responses (SSE) end-to-end from VibeProxy back to Pi Coding Agent.
- Forward tool / function calling in both protocol shapes.
- Establish the monorepo scaffold (pnpm workspaces + TypeScript) and a shared `core` package alongside the extension, ready for additional extensions later.

## Non-Goals
- A generic pass-through HTTP proxy that only sets `base_url` — the extension is an actual model-provider adapter.
- A protocol translator that converts between OpenAI and Anthropic shapes — the wire format is selected per request, not translated.
- Automated unit / integration test suite for v1 — verification is by manual smoke test.
- Multiple extensions beyond Proxy Model in v1 — only one extension ships, but the `core` package is in place.
- Env-var-based configuration as the primary surface — configuration lives in a file inside the extension package.
- Resolving the exact Pi Coding Agent extension contract (entry point, manifest, registration hooks) inside this FRD — that's deferred to research.

## Functional Requirements
1. The monorepo SHALL be a pnpm workspace with at least two packages: `packages/proxy-model/` (the extension) and `packages/core/` (shared types, helpers, manifest schema), authored in TypeScript.
2. `packages/proxy-model/` SHALL register itself with Pi Coding Agent as a model provider via Pi's documented extension API, so the user can select it like any built-in model.
3. The extension SHALL read VibeProxy endpoint URL, credentials, and per-request protocol selection from a configuration file located inside the extension package.
4. The extension SHALL be able to issue requests against VibeProxy in OpenAI `/v1/chat/completions` shape.
5. The extension SHALL be able to issue requests against VibeProxy in Anthropic `/v1/messages` shape.
6. The protocol used for a given request SHALL be selectable (per request or per configured model entry — exact mechanism to be settled in design).
7. The extension SHALL stream responses via Server-Sent Events from VibeProxy through to Pi Coding Agent without buffering the full response.
8. The extension SHALL forward tool / function call requests and responses in both OpenAI (`tool_calls`) and Anthropic (`tool_use` / `tool_result`) shapes.
9. `packages/core/` SHALL expose the types and helpers that the Proxy Model extension consumes (manifest shape, provider-registration helpers, shared protocol types) so future extensions can reuse them.

## Non-Functional Requirements
- **Performance**: No explicit latency budget beyond "streaming must feel native" — tokens reach Pi Coding Agent as they arrive from VibeProxy.
- **Security**: Credentials live in the extension package's config file; the file should be git-ignored by default. No additional auth/threat-model work beyond that for v1.
- **UX / Accessibility**: VibeProxy appears as a normal selectable provider/model in Pi Coding Agent's existing UI — no new UX surface owned by the extension.
- **Reliability**: No specific retry/recovery semantics defined for v1; errors from VibeProxy surface to Pi Coding Agent as model-call errors.

## Constraints & Assumptions
- Toolchain: pnpm workspaces, TypeScript. Build tool (tsup / tsc / other) deferred to design.
- The Pi Coding Agent extension API is documented somewhere and supports registering a model provider with streaming + tool-call hooks. The exact contract is unknown to this FRD and is the central Open Question.
- VibeProxy exposes both OpenAI-compatible and Anthropic-compatible HTTP surfaces.
- The developer is the sole user of the v1 extension; no multi-tenant / shared-team requirements.
- Greenfield repository — only `.pi/` and `thoughts/` exist today (verified via probe).

## Acceptance Criteria
- [ ] `pnpm install` at the repo root succeeds with `packages/proxy-model/` and `packages/core/` both present in `pnpm-workspace.yaml`.
- [ ] `pnpm --filter proxy-model build` produces a distributable artifact for the extension.
- [ ] With a config file pointing at a running VibeProxy instance, launching Pi Coding Agent shows VibeProxy as a selectable model provider.
- [ ] A manual chat round-trip in Pi Coding Agent, with VibeProxy selected and OpenAI protocol configured, streams tokens visibly as they arrive.
- [ ] Same manual chat round-trip succeeds with Anthropic protocol configured.
- [ ] A manual tool-calling round-trip (model issues a tool call, Pi Coding Agent returns a tool result, model continues) completes successfully on at least one of the two protocols.
- [ ] README in `packages/proxy-model/` documents the config file location, fields, and the manual smoke-test steps above.

## Recommended Approach
New `packages/proxy-model/` extension and `packages/core/` shared package inside a pnpm + TypeScript monorepo; the extension registers with Pi Coding Agent's documented extension API as a model provider, reads a local config file for VibeProxy URL/credentials/protocol selection, and forwards streaming chat-completion and tool-call requests to VibeProxy in either OpenAI `/v1/chat/completions` or Anthropic `/v1/messages` shape per request.

## Decisions

### Primary user and motivation
**Question**: What problem does this Proxy Model extension solve, and who's the primary user hitting it today?
**Recommended**: n/a — `intent` question
**Chosen**: "Me as the Pi Coding Agent user" — wants to route Pi Coding Agent's model calls through VibeProxy (own provider keys, custom routing, caching, observability) with no clean way to do that today.
**Rationale**: Developer's own framing; sets a single-user v1 scope.

### Integration shape
**Question**: What does "Proxy Model extension" concretely mean — what's the integration shape?
**Recommended**: A model provider adapter — registers VibeProxy as a selectable model/provider in Pi Coding Agent.
**Chosen**: A model provider adapter.
**Rationale**: Native UX inside Pi Coding Agent; user picks VibeProxy like any built-in model rather than reconfiguring an underlying HTTP client.

### VibeProxy wire protocol
**Question**: What protocol does VibeProxy speak on the wire — i.e., what API shape does the adapter need to call?
**Recommended**: OpenAI-compatible `/v1/chat/completions`.
**Chosen**: Both OpenAI `/v1/chat/completions` and Anthropic `/v1/messages`, selectable per request.
**Rationale**: VibeProxy exposes both surfaces; per-request selection keeps the adapter usable with whichever models the developer routes through VibeProxy.

### Pi extension contract target
**Question**: How does Pi Coding Agent load extensions — what's the contract this monorepo's first extension must satisfy?
**Recommended**: Pi Coding Agent's documented extension API.
**Chosen**: Pi Coding Agent's documented extension API.
**Rationale**: Targets the real, supported integration surface rather than an ad-hoc shim.

### Source of the Pi extension contract
**Question**: Where's the Pi Coding Agent extension API documented? Share now or defer the exact contract to research?
**Recommended**: Paste / point at the docs now.
**Chosen**: Defer — leave contract as Open Question.
**Rationale**: Exact entry-point / manifest / hook spec is not in this repo and will be resolved in research; the FRD locks the intent (target the documented API), not the spec.

### Monorepo toolchain
**Question**: What's the monorepo toolchain for this first extension?
**Recommended**: pnpm workspaces + TypeScript.
**Chosen**: pnpm workspaces + TypeScript.
**Rationale**: Fits the likely JS/TS ecosystem around Pi Coding Agent and the JS-native model-provider clients (OpenAI / Anthropic SDKs and SSE handling).

### Configuration surface
**Question**: How does the user configure the VibeProxy endpoint and credentials?
**Recommended**: Env vars (`VIBEPROXY_URL`, `VIBEPROXY_API_KEY`).
**Chosen**: Config file in the extension package.
**Rationale**: Developer prefers a single, declarative file inside the extension for endpoint, credentials, and protocol selection over scattered environment variables.

### Streaming
**Question**: Does the adapter need to stream responses, or is request/response buffered fine?
**Recommended**: Streaming required (SSE).
**Chosen**: Streaming required (SSE).
**Rationale**: Coding-agent UX expects token-by-token streaming; buffering would introduce visible latency on long generations.

### Tool / function calling
**Question**: Does the adapter need to support tool / function calling, or just plain chat completions?
**Recommended**: Tool / function calling required.
**Chosen**: Tool / function calling required.
**Rationale**: Pi Coding Agent is a coding agent — useful flows depend on tool calls in both OpenAI (`tool_calls`) and Anthropic (`tool_use`) shapes.

### Acceptance / verification bar for v1
**Question**: What's the acceptance bar for v1 — how do you want to verify the adapter works?
**Recommended**: Manual smoke test against a real VibeProxy.
**Chosen**: Manual smoke test against a real VibeProxy.
**Rationale**: Proof-of-life is the v1 goal; automated test infra is deferred until the extension contract stabilizes.

### Monorepo layout for v1
**Question**: Monorepo layout for v1: just this extension, or also a shared `core`/`common` package now?
**Recommended**: Single extension only — no shared packages yet.
**Chosen**: Extension + shared `core` package.
**Rationale**: Developer wants the shared layer in place from day one to make adding subsequent extensions cheap, even at the cost of some early YAGNI risk.

## Open Questions
- Exact Pi Coding Agent extension contract — entry point, manifest format, registration hooks for a model provider, streaming + tool-call interfaces. Deferred to `research`; the FRD only locks "target Pi's documented extension API."
- Build tool inside the pnpm + TypeScript stack (tsup vs tsc vs other) — not pinned in this FRD.
- Exact mechanism for per-request protocol selection (config-level model entries vs request-time switch) — resolved during design once the Pi contract is known.

## Suggested Follow-ups
- None surfaced — probe confirmed greenfield with no pre-existing extension or proxy code to fold in.

## References
- Free-text input: "This repository is a mono repository for pi extensions, the first extension should be a Proxy Model for use VibeProxy with Pi Coding Agent."
- Repository probe: greenfield — only `.pi/` (agent definitions) and `thoughts/` present; no `package.json`, workspace config, or prior extension code.
