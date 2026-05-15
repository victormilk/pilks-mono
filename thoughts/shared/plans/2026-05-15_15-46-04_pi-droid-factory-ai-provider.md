---
date: 2026-05-15T15:46:04-0300
author: victormilk
commit: 45ce480
branch: main
repository: pilks-mono
topic: "pi-droid: Factory.AI Droid models as a Pi provider"
tags: [plan, pi-droid, pi-extension, factory-ai, droid-sdk, streamSimple, jsonrpc, subprocess]
status: ready
parent: thoughts/shared/research/2026-05-15_15-25-58_pi-droid-factory-ai-provider.md
phase_count: 6
unresolved_phase_count: 0
last_updated: 2026-05-15T15:46:04-0300
last_updated_by: victormilk
---

# pi-droid — Factory.AI Droid models as a Pi provider — Implementation Plan

## Overview

Build a new monorepo package `packages/pi-droid/` that registers Factory.AI Droid models as a Pi Coding Agent provider. The package mirrors `packages/pi-vibeproxy/`'s six-file split but swaps HTTP transport for a long-lived `droid exec` subprocess managed via `@factory/droid-sdk@^0.2.0`. A custom `streamSimple` JS function (custom `api: "droid-exec"`) owns one cached `DroidSession` per Pi-extension instance and translates Droid stream events into Pi's `AssistantMessageEvent` union.

## Requirements

- New monorepo package `packages/pi-droid/` mirroring `packages/pi-vibeproxy/`'s six-file split (`index.ts`, `config.ts`, `discovery.ts`, `providers.ts`, `commands.ts`, `types.ts`)
- Register one Pi provider `"droid"` with a custom `streamSimple` function (no HTTP server, no localhost proxy)
- Long-lived `droid` subprocess, multiplex turns via SDK session
- Pass through Droid tool events as Pi `toolcall_*` content events
- Default `--auto medium`; SDK `permissionHandler` returns `ToolConfirmationOutcome.ProceedOnce`
- Curated model list mirroring `docs.factory.ai/models.md`; no runtime probe
- Four slash commands: `/droid-status`, `/droid-models`, `/droid-refresh`, `/droid-restart`
- Acceptance: typecheck clean; `pi --list-models` shows ~24 `droid/<id>` rows; streaming prompt round-trips through Droid; `/droid-status` reports session state; `/droid-restart` recovers a hung session

## Current State Analysis

The monorepo already contains one Pi extension (`packages/pi-vibeproxy/`) that registers two HTTP-backed providers via `pi.registerProvider`. It provides the file-split template, the env→file→defaults config layering, the `ui.notify` literal-narrowing discipline, and the `PLACEHOLDER_API_KEY` validation-workaround pattern.

What's missing: any subprocess-wrapping precedent. The closest analog inside Pi's bundled examples is `subagent/index.ts` (spawns a sub-Pi via `node`), but `@factory/droid-sdk` removes the need to manage stdin/stdout framing manually — it owns the `ProcessTransport`, the JSON-RPC envelope, the abort wiring, and turn-completion detection (`StreamStateTracker`).

### Key Discoveries

- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-ai/dist/types.d.ts:187-241` — `AssistantMessageEvent` is an 11-variant discriminated union; `start` opens, exactly one `done` or `error` closes, `stream.end()` follows
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:949` — `streamSimple?: (model, context, options?) => AssistantMessageEventStream`
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.js:645-656` — `streamSimple` ⇒ `api` required; `models` ⇒ `baseUrl` required AND (`apiKey` OR `oauth`) required (`baseUrl: "droid-exec://local"` is the self-documenting sentinel)
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/dist/core/resolve-config-value.js:14-20` — when `apiKey` is the string name of an env var, Pi resolves it via `process.env[name]` and passes the resolved value as `options.apiKey` to `streamSimple`
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/examples/extensions/custom-provider-anthropic/index.ts:281-501` — canonical emitter shape; tag each upstream block with a transient `index` field, mutate `output.content[]` in place, push `partial: output` on every event
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/examples/extensions/sandbox/index.ts:287-294` — `pi.on("session_shutdown", async () => {…})` teardown pattern
- `Factory-AI/droid-sdk-typescript@main/src/session.ts` (`stream` body) — SDK wires `MessageOptions.abortSignal` to `client.interruptSession()`; `bridge.messages()` returns when SDK yields terminal `Result` message — natural `for await` exit, no separate `Idle`-watcher needed in user code
- `Factory-AI/droid-sdk-typescript@main/src/stream.ts:32-58` — `DroidMessageType` values are snake_case strings (`'assistant_text_delta'`, `'tool_call_delta'`, …); the SDK's TypeScript identifiers (`AssistantTextDelta`, `ToolCallDelta`) are PascalCase
- `Factory-AI/droid-sdk-typescript@main/src/stream.ts:84-90` — `ToolCallDelta = { type: 'tool_call_delta'; toolUse: ToolUseBlock }` — **the entire updated `toolUse` block ships in each event**, not an incremental JSON fragment (deviation from Anthropic's `input_json_delta`)
- `Factory-AI/droid-sdk-typescript@main/src/schemas/enums.ts:65-86` — `ToolConfirmationOutcome.ProceedOnce = 'proceed_once'`; default with no handler registered = `Cancel`
- `Factory-AI/droid-sdk-typescript@main/package.json` — `@factory/droid-sdk@0.2.0`, **Apache-2.0** (research draft said MIT — corrected here), `engines.node: >=18.0.0`
- `packages/pi-vibeproxy/src/{index,config,discovery,providers,commands,types}.ts` — the exact file-split template pi-droid mirrors

## Desired End State

A developer with `FACTORY_API_KEY` exported and `droid` on PATH installs the extension and uses Droid models inside Pi:

```bash
# One-off testing (no install)
pi -e ./packages/pi-droid/src/index.ts --list-models | grep "^droid/"
# droid/claude-sonnet-4-6           Claude Sonnet 4.6
# droid/claude-opus-4-7             Claude Opus 4.7
# droid/gpt-5.5                     GPT-5.5
# ... (24 models)

# Or installed
pi install ./packages/pi-droid
pi /model droid/claude-sonnet-4-6
# > Refactor this function ...
# (streams assistant text + tool calls via long-lived `droid exec` subprocess)

pi /droid-status
# droid: session 7c3a... | autonomy=medium | last error: none | config: ~/.pi/agent/droid.json (default)

pi /droid-restart
# droid: session closed. Next turn will respawn the droid subprocess.
```

`~/.pi/agent/droid.json` example (all fields optional):

```json
{
  "droidBinary": "/usr/local/bin/droid",
  "autoLevel": "medium",
  "defaultModel": "claude-sonnet-4-6",
  "models": {
    "claude-opus-4-7": {
      "cost": { "input": 15, "output": 75, "cacheRead": 1.5, "cacheWrite": 18.75 }
    }
  }
}
```

## What We're NOT Doing

- No HTTP server / localhost proxy / `/v1/models` endpoint (`streamSimple` owns transport directly)
- No hand-rolled JSON-RPC framing — `@factory/droid-sdk` owns the transport and `ProcessTransport` subprocess
- No runtime model probe (`droid --list-models` does not exist; v1 is a curated constant)
- No `~/.pi/agent/droid-cache.json` file — with a curated in-memory constant, there's nothing to cache
- No `askUserHandler` registration (SDK default of `{ cancelled: true }` is acceptable for v1)
- No image / file inputs to `session.stream(prompt, …)` — `context.systemPrompt` is also ignored (Droid owns its own system prompt)
- No MCP server registration via the SDK's `mcpServers` option
- No cost multipliers for Factory's credit model — every model ships with `cost: {0,0,0,0}`, user can override
- No Gemini-family second provider (pi-droid is one provider; Gemini models register under `"droid"` like every other family)
- No second-gate `pi.on("tool_call", …)` listener — Droid tool events surface only as `toolcall_*` content events
- No `pi.unregisterProvider` cleanup in `/droid-refresh` — `pi.registerProvider("droid", { …, models })` is idempotent (replaces models for the named provider per `types.d.ts:866-873`)

## Decisions

### SDK choice (`@factory/droid-sdk` vs hand-rolled JSON-RPC)

**Ambiguity**: spawn `droid exec --input-format stream-jsonrpc` directly and frame JSON-RPC by hand, or take a runtime dependency on Factory's official SDK?

**Explored**:
- **A. `@factory/droid-sdk@^0.2.0`** — official, Apache-2.0, Node ≥ 18, ~25 typed event variants, `ProcessTransport` owns subprocess + framing, `wireAbortSignal` translates `AbortSignal` → `droid.interrupt_session`, `MessageBridge` returns terminal `Result` so `for await` ends naturally. Adds three transitive deps (`@modelcontextprotocol/sdk`, `uuid`, `zod`). Breaks vibeproxy's "no `dependencies`" parity. Source: `Factory-AI/droid-sdk-typescript@main/src/{session,stream,helpers}.ts`.
- **B. Hand-rolled JSON-RPC** — zero deps, full control. ~400 LOC of framing + request-id correlation + crash detection + abort handling. Re-invents what the SDK already tests. Source: research's reference to `https://docs.factory.ai/cli/droid-exec/overview.md`.

**Decision**: **A**. The SDK is purpose-built, MIT-equivalent permissive (Apache-2.0), and cuts the surface area pi-droid owns by an order of magnitude. The parity break with vibeproxy is acknowledged in package.json and README.

### Provider count + `api` string

**Decision**: one provider `"droid"`, `api: "droid-exec"`, `baseUrl: "droid-exec://local"` (sentinel), `apiKey: "FACTORY_API_KEY"` (env-var name). Evidence: `@earendil-works/pi-ai/dist/types.d.ts:4-5` accepts any string as `Api`; `@earendil-works/pi-coding-agent/dist/core/model-registry.js:645-656` requires non-empty `baseUrl` + `apiKey` even when `streamSimple` is set.

Unlike vibeproxy (which fans out one CLIProxyAPIPlus instance into two Pi providers because the upstream surface differs per family), Droid models are all reached via the same `streamSimple` body — there's no protocol-level reason to partition by family.

### Discovery shape (curated vs runtime probe)

**Decision**: curated in-memory `MODELS` constant in `discovery.ts` mirroring `docs.factory.ai/models.md`. No runtime probe (`droid --list-models` does not exist per `docs.factory.ai/cli/droid-exec/overview.md` flag table). No `~/.pi/agent/droid-cache.json` file.

### Session lifecycle (lazy vs eager spawn)

**Ambiguity**: spawn the `droid` subprocess eagerly during the extension factory (like vibeproxy's discovery probe at `packages/pi-vibeproxy/src/index.ts:21-22`), or lazily on the first `streamSimple` invocation?

**Decision**: **lazy**. First `streamSimple` invocation calls `getOrCreateSession()`; result is cached in module-level `let session: DroidSession | null` (also exposed via `RuntimeState.session` for `/droid-restart`). Pi startup pays no subprocess cost when no droid model is used; a missing `droid` binary surfaces at first use, not at load.

### Autonomy + permission handling

**Decision**: `AutonomyLevel.Medium` default; `permissionHandler: () => ToolConfirmationOutcome.ProceedOnce`; no `askUserHandler`. Evidence: `Factory-AI/droid-sdk-typescript@main/src/schemas/enums.ts:65-86` enum values; default (no handler) is `Cancel`, so registering `ProceedOnce` is mandatory. Per-model autonomy override via `cfg.autoLevel` (string `"low"|"medium"|"high"`).

### `context.systemPrompt` handling

**Decision**: **ignore**. Droid sessions don't accept a system prompt — Droid owns its own internally. Prepending Pi's system prompt risks duplicating instructions Droid already follows. Surface decision in `## Developer Context`.

### `ToolCallDelta` snapshot translation

**Ambiguity**: Droid's `ToolCallDelta` ships the **entire updated `toolUse` block** each event (per `stream.ts:84-90`), not an incremental JSON fragment like Anthropic's `input_json_delta`. Pi's `toolcall_delta` event expects a `delta: string`. How to bridge?

**Decision**: snapshot-as-delta. On first sighting of `toolUse.id`: push `toolcall_start`, append `{type:"toolCall", id, name, arguments: toolUse.input}` to `output.content`, push `toolcall_delta` with `delta: JSON.stringify(toolUse.input)`. On subsequent `ToolCallDelta` for the same id: replace `arguments` with the latest `toolUse.input`, push another `toolcall_delta` with the latest snapshot. On `DroidToolCallMessage` (final `CREATE_MESSAGE` with the tool_use block): push `toolcall_end` with the finalized `ToolCall`. Pi's consumer rebuilds args from `partial.content` on each event — a snapshot semantics works; the `delta` field is informational.

### Cost reporting

**Decision**: `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }` per model. Factory bundles pricing into credit multipliers, not per-token dollar amounts. `calculateCost` writes zeros into `usage.cost`. Pi's footer shows `$0.00` per turn. Users override via `~/.pi/agent/droid.json` `models.<id>.cost`.

### File split

**Decision**: mirror vibeproxy's six-file split exactly. `streamSimple` + session singleton live inline in `providers.ts`, not in a separate `stream.ts`. Honors the FRD's "same six-file split" requirement.

## Phase 1: Package scaffold + types

### Overview

Foundation slice: ship `package.json` declaring `@factory/droid-sdk` runtime dep + `@earendil-works/*` peer deps, `tsconfig.json` extending the monorepo base, and `src/types.ts` exporting every shared type the remaining slices import (config schema, runtime state, model overrides). No runtime code yet. Foundation phase — no parallelism (Phases 2-6 all depend on it).

### Changes Required:

#### 1. packages/pi-droid/package.json

**File**: `packages/pi-droid/package.json`
**Changes**: NEW — package manifest. Declares `pi.extensions: ["./src/index.ts"]`, peer-deps on the two `@earendil-works/*` packages, **runtime** dep on `@factory/droid-sdk@^0.2.0` (the parity break vs vibeproxy), dev-deps pinning concrete versions for typecheck.

```json
{
  "name": "@victormilk/pi-droid",
  "version": "0.1.0",
  "description": "Pi Coding Agent extension that registers Factory.AI Droid models as a custom-streamSimple provider backed by a long-lived `droid exec` subprocess.",
  "license": "MIT",
  "author": "Victor Leite Costa",
  "homepage": "https://github.com/victormilk/pilks-mono/tree/main/packages/pi-droid#readme",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/victormilk/pilks-mono.git",
    "directory": "packages/pi-droid"
  },
  "type": "module",
  "keywords": [
    "pi-package",
    "pi",
    "pi-coding-agent",
    "pi-extension",
    "pi-provider",
    "pi-model-provider",
    "pi-custom-provider",
    "factory",
    "factory-ai",
    "droid",
    "droid-cli",
    "droid-exec",
    "claude",
    "gpt",
    "gemini",
    "streaming",
    "tool-calling",
    "function-calling",
    "jsonrpc"
  ],
  "pi": {
    "extensions": [
      "./src/index.ts"
    ]
  },
  "files": [
    "src/",
    "README.md",
    "LICENSE",
    "package.json",
    "tsconfig.json"
  ],
  "engines": {
    "node": ">=20.0.0"
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@factory/droid-sdk": "^0.2.0"
  },
  "peerDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*"
  },
  "devDependencies": {
    "@earendil-works/pi-ai": "^0.74.0",
    "@earendil-works/pi-coding-agent": "^0.74.0",
    "@types/node": "^24.3.0",
    "typescript": "^5.7.3"
  }
}
```

#### 2. packages/pi-droid/tsconfig.json

**File**: `packages/pi-droid/tsconfig.json`
**Changes**: NEW — extends monorepo base, enables `types: ["node"]`. Identical shape to `packages/pi-vibeproxy/tsconfig.json`.

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

#### 3. packages/pi-droid/src/types.ts

**File**: `packages/pi-droid/src/types.ts`
**Changes**: NEW — shared type surface for the package. Mirrors `packages/pi-vibeproxy/src/types.ts` shape but:
- swaps `baseUrl/apiKey` in `ConfigFile` for `droidBinary/autoLevel/defaultModel`
- adds `DroidModel` (curated entry shape) replacing vibeproxy's `UpstreamModel`
- drops `Family`/`FamilySpec`/`ProviderApi` (one provider, no family fan-out)
- adds `AutoLevel` literal union for the `--auto` CLI flag

```ts
/**
 * Shared types for @victormilk/pi-droid.
 *
 * No runtime validator (typebox/zod) on purpose: Pi extensions load into a
 * trusted local process and the config file lives in the user's home dir.
 * Defensive narrowing happens at parse time in `config.ts`.
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevelMap } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Public config schema (~/.pi/agent/droid.json)
// ---------------------------------------------------------------------------

/**
 * Per-model override block. All fields optional; unspecified fields fall back
 * to the curated defaults in `discovery.ts`.
 */
export interface ModelOverride {
	name?: string;
	reasoning?: boolean;
	/**
	 * Maps Pi thinking levels to provider-specific `ReasoningEffort` values.
	 * `null` marks a level unsupported. To expose Factory's `"max"` effort on
	 * Anthropic adaptive-thinking models, set `{ "xhigh": "max" }`.
	 */
	thinkingLevelMap?: ThinkingLevelMap;
	input?: ReadonlyArray<"text" | "image">;
	contextWindow?: number;
	maxTokens?: number;
	cost?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
}

/** `--auto` flag values accepted by `droid exec` (see `docs.factory.ai/cli/droid-exec/overview.md`). */
export type AutoLevel = "low" | "medium" | "high";

/**
 * Shape of `~/.pi/agent/droid.json` as authored by the user.
 * All fields optional; env vars and defaults fill the rest.
 */
export interface ConfigFile {
	/** Path to the `droid` binary. Default: `"droid"` (PATH lookup). */
	droidBinary?: string;
	/** Default `--auto` level passed to the spawned droid subprocess. Default: `"medium"`. */
	autoLevel?: AutoLevel;
	/** Curated model id to feature as the default for `pi /model`. Default: `"claude-sonnet-4-6"`. */
	defaultModel?: string;
	/** Per-model overrides keyed by curated model id (e.g. `"claude-sonnet-4-6"`). */
	models?: Record<string, ModelOverride>;
}

/**
 * Fully-resolved runtime config after env overrides + defaults are applied.
 * Every field is concrete (no undefined branches the caller has to handle).
 */
export interface ResolvedConfig {
	droidBinary: string;
	autoLevel: AutoLevel;
	defaultModel: string;
	modelOverrides: Record<string, ModelOverride>;
	/** Path the config file was loaded from, or `undefined` if it didn't exist. */
	loadedFrom?: string;
}

// ---------------------------------------------------------------------------
// Curated catalog shape (the input to `resolveAll`)
// ---------------------------------------------------------------------------

/** Family bucket for grouped display in `/droid-models`. */
export type DroidFamily = "anthropic" | "openai" | "google" | "droid-core";

/**
 * One curated entry from the `MODELS` constant. Mirrors what a hypothetical
 * `droid --list-models` would surface, plus the Pi capability fields that
 * Factory's docs imply but no programmatic endpoint exposes.
 */
export interface DroidModel {
	readonly id: string;
	readonly name: string;
	readonly family: DroidFamily;
	readonly reasoning: boolean;
	readonly thinkingLevelMap?: ThinkingLevelMap;
	/** Curated supported inputs (default: `["text"]`). Anthropic + Google entries declare `["text", "image"]`. */
	readonly input?: ReadonlyArray<"text" | "image">;
	readonly contextWindow: number;
	readonly maxTokens: number;
}

/**
 * A curated model with per-user overrides applied — ready to pass straight into
 * `ProviderModelConfig` for `pi.registerProvider`.
 */
export interface ResolvedModel {
	readonly source: DroidModel;
	readonly family: DroidFamily;
	readonly piModel: ProviderModelConfig;
}
```

### Success Criteria:

#### Automated Verification:
- [x] Package installs cleanly: `pnpm install` from repo root
- [x] `@factory/droid-sdk` resolves: `pnpm --filter @victormilk/pi-droid exec -- node -e "require('@factory/droid-sdk')"`
- [x] Types file parses: `pnpm --filter @victormilk/pi-droid typecheck` (will only see types.ts at this phase)
- [ ] Every exported type has at least one downstream consumer: `grep -rn 'from "./types' packages/pi-droid/src/` returns 5 hits (config, discovery, providers, commands, index)

#### Manual Verification:
- [x] `packages/pi-droid/package.json` lists `@factory/droid-sdk@^0.2.0` under `dependencies` (the parity break vs vibeproxy)
- [x] `pi.extensions` entry points at `./src/index.ts`
- [x] `peerDependencies` are `*`, `devDependencies` are pinned (matches vibeproxy discipline)

## Phase 2: Config layer

### Overview

Load `~/.pi/agent/droid.json` with env→file→defaults precedence (env vars: `DROID_BINARY`, `DROID_AUTO_LEVEL`). Never throws; malformed values log `console.warn` and fall back to defaults. Depends on Phase 1; can run in parallel with Phase 3.

### Changes Required:

#### 1. packages/pi-droid/src/config.ts

**File**: `packages/pi-droid/src/config.ts`
**Changes**: NEW — config loader mirroring `packages/pi-vibeproxy/src/config.ts` shape (env→file→defaults, `coerceConfigFile`/`normalizeModelOverrides`, `CONFIG_PATH_FOR_DIAGNOSTICS` export). Adapted field set: `droidBinary/autoLevel/defaultModel/models` (no `baseUrl/apiKey` — Factory uses `FACTORY_API_KEY` directly via SDK `env`).

```ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AutoLevel, ConfigFile, ModelOverride, ResolvedConfig } from "./types.ts";

const DEFAULT_DROID_BINARY = "droid";
const DEFAULT_AUTO_LEVEL: AutoLevel = "medium";
const DEFAULT_MODEL = "claude-sonnet-4-6";
const CONFIG_PATH = join(homedir(), ".pi", "agent", "droid.json");

/**
 * Load and resolve runtime config.
 *
 * Layering (later wins):
 *   defaults  <  ~/.pi/agent/droid.json  <  env vars (DROID_BINARY, DROID_AUTO_LEVEL)
 *
 * `FACTORY_API_KEY` is NOT read here — it's the value Pi resolves from the
 * `apiKey: "FACTORY_API_KEY"` envvar-name registered in `providers.ts`, and
 * the SDK reads it again from `process.env` when it spawns the subprocess.
 *
 * Returns a fully-resolved config; the file is optional, missing fields are
 * filled with safe defaults, malformed values are warned-about and ignored.
 */
export function loadConfig(): ResolvedConfig {
	const fromFile = readConfigFile(CONFIG_PATH);

	const envBinary = process.env.DROID_BINARY?.trim();
	const envAutoLevel = coerceAutoLevel(process.env.DROID_AUTO_LEVEL?.trim());

	return {
		droidBinary: envBinary || fromFile.parsed.droidBinary?.trim() || DEFAULT_DROID_BINARY,
		autoLevel: envAutoLevel ?? coerceAutoLevel(fromFile.parsed.autoLevel) ?? DEFAULT_AUTO_LEVEL,
		defaultModel: fromFile.parsed.defaultModel?.trim() || DEFAULT_MODEL,
		modelOverrides: normalizeModelOverrides(fromFile.parsed.models),
		loadedFrom: fromFile.exists ? CONFIG_PATH : undefined,
	};
}

function readConfigFile(path: string): { exists: boolean; parsed: ConfigFile } {
	if (!existsSync(path)) {
		return { exists: false, parsed: {} };
	}
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		return { exists: true, parsed: coerceConfigFile(parsed, path) };
	} catch (err) {
		console.warn(`[pi-droid] Failed to read ${path}: ${(err as Error).message}. Using defaults.`);
		return { exists: true, parsed: {} };
	}
}

/**
 * Coerce an unknown JSON value into a `ConfigFile`. Unknown / malformed fields
 * are dropped with a warning; we never throw — the extension must still load.
 */
function coerceConfigFile(value: unknown, path: string): ConfigFile {
	if (!isPlainObject(value)) {
		console.warn(`[pi-droid] ${path} is not a JSON object. Ignoring contents.`);
		return {};
	}
	const out: ConfigFile = {};
	if (typeof value.droidBinary === "string") out.droidBinary = value.droidBinary;
	const auto = coerceAutoLevel(value.autoLevel);
	if (auto) out.autoLevel = auto;
	if (typeof value.defaultModel === "string") out.defaultModel = value.defaultModel;
	if (isPlainObject(value.models)) {
		out.models = value.models as Record<string, ModelOverride>;
	}
	return out;
}

function coerceAutoLevel(value: unknown): AutoLevel | undefined {
	if (value === "low" || value === "medium" || value === "high") return value;
	return undefined;
}

function normalizeModelOverrides(
	raw: Record<string, ModelOverride> | undefined,
): Record<string, ModelOverride> {
	if (!raw) return {};
	const out: Record<string, ModelOverride> = {};
	for (const [id, override] of Object.entries(raw)) {
		if (!isPlainObject(override)) continue;
		const normalized: ModelOverride = {};
		const o = override as Record<string, unknown>;
		if (typeof o.name === "string") normalized.name = o.name;
		if (typeof o.reasoning === "boolean") normalized.reasoning = o.reasoning;
		if (Array.isArray(o.input)) {
			const inputs = o.input.filter((v): v is "text" | "image" => v === "text" || v === "image");
			if (inputs.length > 0) normalized.input = inputs;
		}
		if (typeof o.contextWindow === "number" && Number.isFinite(o.contextWindow) && o.contextWindow > 0) {
			normalized.contextWindow = o.contextWindow;
		}
		if (typeof o.maxTokens === "number" && Number.isFinite(o.maxTokens) && o.maxTokens > 0) {
			normalized.maxTokens = o.maxTokens;
		}
		if (isPlainObject(o.thinkingLevelMap)) {
			const map: Record<string, string | null> = {};
			for (const [level, value] of Object.entries(o.thinkingLevelMap)) {
				if (value === null || typeof value === "string") map[level] = value;
			}
			if (Object.keys(map).length > 0) {
				normalized.thinkingLevelMap = map as ModelOverride["thinkingLevelMap"];
			}
		}
		if (isPlainObject(o.cost)) {
			const c = o.cost as Record<string, unknown>;
			if (
				typeof c.input === "number" &&
				typeof c.output === "number" &&
				typeof c.cacheRead === "number" &&
				typeof c.cacheWrite === "number"
			) {
				normalized.cost = {
					input: c.input,
					output: c.output,
					cacheRead: c.cacheRead,
					cacheWrite: c.cacheWrite,
				};
			}
		}
		out[id] = normalized;
	}
	return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const CONFIG_PATH_FOR_DIAGNOSTICS = CONFIG_PATH;
```

### Success Criteria:

#### Automated Verification:
- [x] Typecheck passes for config.ts: `pnpm --filter @victormilk/pi-droid typecheck`
- [x] env-var precedence pattern present in code: `grep -n 'process.env.DROID_BINARY' packages/pi-droid/src/config.ts` returns 1 hit
- [x] `coerceAutoLevel` narrows only `low|medium|high`: `grep -nE '"low" \|\| value === "medium" \|\| value === "high"' packages/pi-droid/src/config.ts` returns 1 hit

#### Manual Verification:
- [ ] Drop a malformed `~/.pi/agent/droid.json` (e.g. `{`) — launching `pi -e ./packages/pi-droid/src/index.ts --list-models` logs a `[pi-droid] Failed to read` warning, returns defaults, does not throw
- [ ] `DROID_AUTO_LEVEL=high pi -e ./packages/pi-droid/src/index.ts --list-models` — `/droid-status` (or `session_start` notify) shows `autonomy=high`
- [ ] `DROID_AUTO_LEVEL=ridiculous pi -e ./packages/pi-droid/src/index.ts --list-models` — falls back to `medium` silently

## Phase 3: Curated discovery

### Overview

Ship a curated `MODELS` constant mirroring `docs.factory.ai/models.md` and an `resolveAll(cfg)` function that produces `ProviderModelConfig[]` ready for `pi.registerProvider`. No network probe, no cache file. Depends on Phases 1-2.

### Changes Required:

#### 1. packages/pi-droid/src/discovery.ts

**File**: `packages/pi-droid/src/discovery.ts`
**Changes**: NEW — exports `MODELS` (curated catalog), `resolveAll(cfg)` (applies overrides), and `groupByFamily(models)` (used by `/droid-models`).

```ts
import type {
	DroidFamily,
	DroidModel,
	ModelOverride,
	ResolvedConfig,
	ResolvedModel,
} from "./types.ts";

/**
 * Zero-cost placeholder for every model. Factory bundles pricing into credit
 * multipliers, not per-token dollar amounts, so we report $0 by default. Users
 * who care about cost-tracking can override via `~/.pi/agent/droid.json`.
 */
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

/**
 * Curated model catalog mirroring `docs.factory.ai/models.md` (fetched 2026-05-15).
 *
 * No `droid --list-models` flag exists (see `docs.factory.ai/cli/droid-exec/overview.md`).
 * `/droid-refresh` re-reads this constant; the curated list is the single source
 * of truth. To add a model, append a row here and re-load the extension.
 *
 * Capability fields (`reasoning`, `thinkingLevelMap`, `contextWindow`, `maxTokens`)
 * are seeded from upstream vendor docs; users can override per-model via the
 * config file.
 */
/** Per-family default `input` capabilities — Anthropic + Google natively support image input. */
const IMAGE_CAPABLE: ReadonlyArray<"text" | "image"> = ["text", "image"];

export const MODELS: ReadonlyArray<DroidModel> = [
	// ---- Anthropic ----
	{
		id: "claude-opus-4-7",
		name: "Claude Opus 4.7",
		family: "anthropic",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh" },
		input: IMAGE_CAPABLE,
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
	{
		id: "claude-opus-4-7-fast",
		name: "Claude Opus 4.7 Fast",
		family: "anthropic",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh" },
		input: IMAGE_CAPABLE,
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
	{
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6",
		family: "anthropic",
		reasoning: true,
		thinkingLevelMap: { xhigh: "max" },
		input: IMAGE_CAPABLE,
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		family: "anthropic",
		reasoning: true,
		thinkingLevelMap: { xhigh: "max" },
		input: IMAGE_CAPABLE,
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
	{
		id: "claude-opus-4-5-20251101",
		name: "Claude Opus 4.5",
		family: "anthropic",
		reasoning: true,
		input: IMAGE_CAPABLE,
		contextWindow: 200_000,
		maxTokens: 16_384,
	},
	{
		id: "claude-sonnet-4-5-20250929",
		name: "Claude Sonnet 4.5",
		family: "anthropic",
		reasoning: true,
		input: IMAGE_CAPABLE,
		contextWindow: 200_000,
		maxTokens: 16_384,
	},
	{
		id: "claude-haiku-4-5-20251001",
		name: "Claude Haiku 4.5",
		family: "anthropic",
		reasoning: true,
		input: IMAGE_CAPABLE,
		contextWindow: 200_000,
		maxTokens: 16_384,
	},
	// ---- OpenAI ----
	{ id: "gpt-5.5", name: "GPT-5.5", family: "openai", reasoning: true, contextWindow: 400_000, maxTokens: 100_000 },
	{ id: "gpt-5.5-fast", name: "GPT-5.5 Fast", family: "openai", reasoning: true, contextWindow: 400_000, maxTokens: 100_000 },
	{ id: "gpt-5.5-pro", name: "GPT-5.5 Pro", family: "openai", reasoning: true, contextWindow: 400_000, maxTokens: 100_000 },
	{ id: "gpt-5.4", name: "GPT-5.4", family: "openai", reasoning: true, contextWindow: 400_000, maxTokens: 100_000 },
	{ id: "gpt-5.4-fast", name: "GPT-5.4 Fast", family: "openai", reasoning: true, contextWindow: 400_000, maxTokens: 100_000 },
	{ id: "gpt-5.4-mini", name: "GPT-5.4 Mini", family: "openai", reasoning: true, contextWindow: 400_000, maxTokens: 100_000 },
	{ id: "gpt-5.3-codex", name: "GPT-5.3 Codex", family: "openai", reasoning: true, contextWindow: 400_000, maxTokens: 100_000 },
	{ id: "gpt-5.3-codex-fast", name: "GPT-5.3 Codex Fast", family: "openai", reasoning: true, contextWindow: 400_000, maxTokens: 100_000 },
	{ id: "gpt-5.2", name: "GPT-5.2", family: "openai", reasoning: true, contextWindow: 400_000, maxTokens: 100_000 },
	{ id: "gpt-5.2-codex", name: "GPT-5.2 Codex", family: "openai", reasoning: true, contextWindow: 400_000, maxTokens: 100_000 },
	// ---- Google ----
	{ id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro", family: "google", reasoning: true, input: IMAGE_CAPABLE, contextWindow: 1_000_000, maxTokens: 64_000 },
	{ id: "gemini-3-pro-preview", name: "Gemini 3 Pro", family: "google", reasoning: true, input: IMAGE_CAPABLE, contextWindow: 1_000_000, maxTokens: 64_000 },
	{ id: "gemini-3-flash-preview", name: "Gemini 3 Flash", family: "google", reasoning: true, input: IMAGE_CAPABLE, contextWindow: 1_000_000, maxTokens: 64_000 },
	// ---- Droid Core ----
	{ id: "glm-5.1", name: "GLM 5.1", family: "droid-core", reasoning: true, contextWindow: 128_000, maxTokens: 16_384 },
	{ id: "kimi-k2.6", name: "Kimi K2.6", family: "droid-core", reasoning: true, contextWindow: 128_000, maxTokens: 16_384 },
	{ id: "kimi-k2.5", name: "Kimi K2.5", family: "droid-core", reasoning: true, contextWindow: 128_000, maxTokens: 16_384 },
	{ id: "minimax-m2.7", name: "MiniMax M2.7", family: "droid-core", reasoning: true, contextWindow: 128_000, maxTokens: 16_384 },
];

/**
 * Apply per-model config overrides on top of the curated entry. The result is
 * a `ProviderModelConfig`-shaped object ready for `pi.registerProvider`.
 */
export function resolveModel(model: DroidModel, override: ModelOverride | undefined): ResolvedModel {
	const o: ModelOverride = override ?? {};
	const piModel: ResolvedModel["piModel"] = {
		id: model.id,
		name: o.name ?? model.name,
		reasoning: o.reasoning ?? model.reasoning,
		input: (o.input ?? model.input ?? ["text"]).slice() as Array<"text" | "image">,
		cost: o.cost ?? { ...ZERO_COST },
		contextWindow: o.contextWindow ?? model.contextWindow,
		maxTokens: o.maxTokens ?? model.maxTokens,
	};
	const thinkingLevelMap = o.thinkingLevelMap ?? model.thinkingLevelMap;
	if (thinkingLevelMap) {
		piModel.thinkingLevelMap = thinkingLevelMap;
	}
	return { source: model, family: model.family, piModel };
}

export function resolveAll(cfg: ResolvedConfig): ReadonlyArray<ResolvedModel> {
	return MODELS.map((m) => resolveModel(m, cfg.modelOverrides[m.id]));
}

/** Group resolved models by family, returning families in display order. */
export function groupByFamily(
	resolved: ReadonlyArray<ResolvedModel>,
): ReadonlyArray<{ family: DroidFamily; models: ReadonlyArray<ResolvedModel> }> {
	const order: DroidFamily[] = ["anthropic", "openai", "google", "droid-core"];
	return order
		.map((family) => ({ family, models: resolved.filter((m) => m.family === family) }))
		.filter((bucket) => bucket.models.length > 0);
}
```

### Success Criteria:

#### Automated Verification:
- [x] Typecheck passes: `pnpm --filter @victormilk/pi-droid typecheck`
- [x] MODELS const present with expected family coverage: `grep -cE 'family: "(anthropic|openai|google|droid-core)"' packages/pi-droid/src/discovery.ts` returns 24
- [x] Image-capable seeding for Anthropic + Google families: `grep -c 'input: IMAGE_CAPABLE' packages/pi-droid/src/discovery.ts` returns 10 (7 Anthropic + 3 Google)
- [x] groupByFamily returns family-ordered buckets: `grep -nE 'order: DroidFamily\[\] = \["anthropic", "openai", "google", "droid-core"\]' packages/pi-droid/src/discovery.ts` returns 1 hit

#### Manual Verification:
- [ ] `pi -e ./packages/pi-droid/src/index.ts --list-models | grep '^droid/' | wc -l` returns 24
- [ ] Spot-check the catalog against `https://docs.factory.ai/models.md` — model ids match
- [ ] Set `models: { "claude-opus-4-7": { "name": "My Custom Opus" } }` in `~/.pi/agent/droid.json`, run `pi /droid-refresh`, then `pi /droid-models` — the override applies

## Phase 4: Provider registration + streamSimple

### Overview

The load-bearing slice. Registers one Pi provider `"droid"` with `api: "droid-exec"` and the `streamSimple` body. Holds the lazy `DroidSession` singleton plus the `pi.on("session_shutdown")` teardown. The streamSimple function translates `DroidStreamEvent` items into Pi's `AssistantMessageEvent` union. Depends on Phases 1-3.

### Changes Required:

#### 1. packages/pi-droid/src/providers.ts

**File**: `packages/pi-droid/src/providers.ts`
**Changes**: NEW — `registerProvider(pi, cfg, resolved)` mounts the provider; `streamSimple` body owns event translation; `getOrCreateSession()` is the lazy spawn; `closeSession()` is the manual teardown lever for `/droid-restart` and `session_shutdown`. Pattern mirrors `custom-provider-anthropic/index.ts:281-501` (event translation) and `sandbox/index.ts:287-294` (shutdown hook).

```ts
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import {
	calculateCost,
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type ToolCall,
} from "@earendil-works/pi-ai";
import {
	AutonomyLevel,
	createSession,
	DroidMessageType,
	DroidWorkingState,
	ToolConfirmationOutcome,
	type DroidSession,
	type DroidStreamEvent,
} from "@factory/droid-sdk";
import type { ResolvedConfig, ResolvedModel } from "./types.ts";

const PROVIDER_NAME = "droid";
const PROVIDER_DISPLAY_NAME = "Factory Droid";
const PROVIDER_API = "droid-exec";
/** Self-documenting sentinel — `streamSimple` owns transport, but Pi requires a non-empty baseUrl when models are set. */
const PROVIDER_BASE_URL = "droid-exec://local";
/** Env-var NAME (not value). Pi resolves it via `resolve-config-value.js:14-20` and passes the value as `options.apiKey`. */
const PROVIDER_API_KEY_ENV = "FACTORY_API_KEY";

/**
 * Module-level singleton — one `DroidSession` per Pi-extension instance. The SDK
 * multiplexes multiple turns onto the same underlying `droid exec` subprocess.
 *
 * Lifecycle:
 *   - first `streamSimple()` call lazily spawns the session
 *   - `pi.on("session_shutdown")` closes it
 *   - `/droid-restart` calls `closeSession()` so the next turn respawns
 *   - any uncaught stream error nulls the singleton so the next turn respawns
 */
let session: DroidSession | null = null;
let lastSpawnAt: number | undefined;
let lastError: string | undefined;

/** Exposed for `commands.ts` (`/droid-status`, `/droid-restart`). */
export function getSessionSnapshot(): {
	sessionId: string | null;
	lastSpawnAt: number | undefined;
	lastError: string | undefined;
} {
	return { sessionId: session?.sessionId ?? null, lastSpawnAt, lastError };
}

/** Clear cached error — used by `/droid-refresh` and `/droid-restart`. */
export function clearLastError(): void {
	lastError = undefined;
}

/** Idempotent teardown — safe to call when no session exists. */
export async function closeSession(): Promise<void> {
	const s = session;
	session = null;
	lastSpawnAt = undefined;
	if (s) {
		try {
			await s.close();
		} catch {
			/* swallow — shutdown must not throw */
		}
	}
}

/**
 * Register the `"droid"` provider. `models` carries every curated entry with
 * overrides applied; the same `streamSimple` body serves every model id.
 *
 * Idempotent — re-calling with a new model list replaces the existing models
 * for this provider (see `@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:866-873`).
 */
export function registerProvider(
	pi: ExtensionAPI,
	cfg: ResolvedConfig,
	resolved: ReadonlyArray<ResolvedModel>,
): { totalModels: number } {
	const config: ProviderConfig = {
		name: PROVIDER_DISPLAY_NAME,
		baseUrl: PROVIDER_BASE_URL,
		apiKey: PROVIDER_API_KEY_ENV,
		api: PROVIDER_API,
		streamSimple: (model, context, options) => streamDroid(model, context, options, cfg),
		models: resolved.map((m) => m.piModel),
	};
	pi.registerProvider(PROVIDER_NAME, config);
	return { totalModels: resolved.length };
}

/** Wire subprocess teardown to Pi's session-shutdown event. */
export function wireSessionShutdown(pi: ExtensionAPI): void {
	pi.on("session_shutdown", async () => {
		await closeSession();
	});
}

// ---------------------------------------------------------------------------
// `streamSimple` body — translates `DroidStreamEvent` → `AssistantMessageEvent`
// ---------------------------------------------------------------------------

function streamDroid(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	cfg: ResolvedConfig,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		// Tag each open block with its upstream key — message-id+block-index for text/thinking,
		// toolUse.id for tool-calls — so we can find the active block by upstream identity.
		type BlockKey = string;
		const blockKeyAt = new Map<number, BlockKey>(); // contentIndex → BlockKey
		const indexOf = new Map<BlockKey, number>(); // BlockKey → contentIndex

		// Cooperative abort: when Pi cancels, just flip a flag. The SDK's
		// `wireAbortSignal` (helpers.ts:wireAbortSignal) already translates
		// `options.signal` aborts into `client.interruptSession()` calls when
		// passed via `session.stream({ abortSignal })`. Calling `interrupt()`
		// manually here would double-interrupt.
		let aborted = false;
		const onAbort = () => {
			aborted = true;
		};
		options?.signal?.addEventListener("abort", onAbort, { once: true });

		let droidSession: DroidSession | null = null;
		try {
			droidSession = await getOrCreateSession(cfg, options?.apiKey);
			stream.push({ type: "start", partial: output });

			// Build the user prompt from context. Drop `context.systemPrompt` —
			// Droid owns its own system prompt; layering Pi's risks duplication.
			const userPrompt = extractUserPrompt(context);

			for await (const event of droidSession.stream(userPrompt, {
				abortSignal: options?.signal,
				includePartialMessages: true,
			})) {
				translate(event, output, stream, blockKeyAt, indexOf, model);
			}

			if (aborted || options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			stream.push({
				type: "done",
				reason: output.stopReason === "length" || output.stopReason === "toolUse"
					? output.stopReason
					: "stop",
				message: output,
			});
			stream.end();
		} catch (error) {
			// Hoist a typed local for the discriminated-union `reason` field — TS doesn't
			// narrow property reads from prior assignments under strict mode.
			const errorReason: "aborted" | "error" =
				aborted || options?.signal?.aborted ? "aborted" : "error";
			output.stopReason = errorReason;
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);

			// Null the singleton on hard errors so the next turn respawns.
			// Aborts are recoverable; everything else is suspect.
			if (errorReason === "error") {
				lastError = output.errorMessage;
				void closeSession();
			}

			stream.push({ type: "error", reason: errorReason, error: output });
			stream.end();
		} finally {
			options?.signal?.removeEventListener("abort", onAbort);
		}
	})();

	return stream;
}

function extractUserPrompt(context: Context): string {
	// Pi's coding-agent stitches the conversation in `context.messages` already;
	// Droid wants the latest user turn as a single string. Pull the last user
	// message (the one Pi just appended) and string-ify its content.
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const msg = context.messages[i];
		if (!msg || msg.role !== "user") continue;
		if (typeof msg.content === "string") return msg.content;
		return msg.content
			.filter((c): c is { type: "text"; text: string; textSignature?: string } => c.type === "text")
			.map((c) => c.text)
			.join("");
	}
	return "";
}

// ---------------------------------------------------------------------------
// Per-event translation
// ---------------------------------------------------------------------------

function translate(
	event: DroidStreamEvent,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	blockKeyAt: Map<number, string>,
	indexOf: Map<string, number>,
	model: Model<Api>,
): void {
	switch (event.type) {
		case DroidMessageType.AssistantTextDelta: {
			const key = `text:${event.messageId}:${event.blockIndex}`;
			let idx = indexOf.get(key);
			if (idx === undefined) {
				idx = output.content.length;
				output.content.push({ type: "text", text: "" });
				blockKeyAt.set(idx, key);
				indexOf.set(key, idx);
				stream.push({ type: "text_start", contentIndex: idx, partial: output });
			}
			const block = output.content[idx];
			if (block?.type !== "text") return;
			block.text += event.text;
			stream.push({ type: "text_delta", contentIndex: idx, delta: event.text, partial: output });
			return;
		}

		case DroidMessageType.AssistantTextComplete: {
			const key = `text:${event.messageId}:${event.blockIndex}`;
			const idx = indexOf.get(key);
			if (idx === undefined) return;
			const block = output.content[idx];
			if (block?.type !== "text") return;
			stream.push({ type: "text_end", contentIndex: idx, content: block.text, partial: output });
			indexOf.delete(key);
			return;
		}

		case DroidMessageType.ThinkingTextDelta: {
			const key = `think:${event.messageId}:${event.blockIndex}`;
			let idx = indexOf.get(key);
			if (idx === undefined) {
				idx = output.content.length;
				output.content.push({ type: "thinking", thinking: "", thinkingSignature: "" });
				blockKeyAt.set(idx, key);
				indexOf.set(key, idx);
				stream.push({ type: "thinking_start", contentIndex: idx, partial: output });
			}
			const block = output.content[idx];
			if (block?.type !== "thinking") return;
			block.thinking += event.text;
			stream.push({ type: "thinking_delta", contentIndex: idx, delta: event.text, partial: output });
			return;
		}

		case DroidMessageType.ThinkingTextComplete: {
			const key = `think:${event.messageId}:${event.blockIndex}`;
			const idx = indexOf.get(key);
			if (idx === undefined) return;
			const block = output.content[idx];
			if (block?.type !== "thinking") return;
			stream.push({ type: "thinking_end", contentIndex: idx, content: block.thinking, partial: output });
			indexOf.delete(key);
			return;
		}

		case DroidMessageType.ToolCallDelta: {
			// Droid ships the entire updated `toolUse` block per event — snapshot, not fragment.
			// First sighting: push toolcall_start, set arguments. Subsequent: replace arguments.
			// `delta` carries the snapshot JSON for consumers that prefer string-based wire format.
			const key = `tool:${event.toolUse.id}`;
			let idx = indexOf.get(key);
			const args = (event.toolUse.input ?? {}) as Record<string, unknown>;
			if (idx === undefined) {
				idx = output.content.length;
				const call: ToolCall = {
					type: "toolCall",
					id: event.toolUse.id,
					name: event.toolUse.name,
					arguments: args,
				};
				output.content.push(call);
				blockKeyAt.set(idx, key);
				indexOf.set(key, idx);
				stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
			} else {
				const block = output.content[idx];
				if (block?.type === "toolCall") block.arguments = args;
			}
			stream.push({
				type: "toolcall_delta",
				contentIndex: idx,
				delta: safeStringify(args),
				partial: output,
			});
			return;
		}

		case DroidMessageType.ToolCall: {
			// Final CREATE_MESSAGE-derived tool_use block — close out the toolcall.
			const key = `tool:${event.toolUse.id}`;
			const idx = indexOf.get(key);
			if (idx === undefined) return;
			const block = output.content[idx];
			if (block?.type !== "toolCall") return;
			block.arguments = (event.toolUse.input ?? {}) as Record<string, unknown>;
			stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: block, partial: output });
			output.stopReason = "toolUse";
			indexOf.delete(key);
			return;
		}

		case DroidMessageType.TokenUsageUpdate: {
			output.usage.input = event.inputTokens ?? 0;
			output.usage.output = (event.outputTokens ?? 0) + (event.thinkingTokens ?? 0);
			output.usage.cacheRead = event.cacheReadTokens ?? 0;
			output.usage.cacheWrite = event.cacheCreationTokens ?? 0;
			output.usage.totalTokens =
				output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
			calculateCost(model, output.usage);
			return;
		}

		case DroidMessageType.WorkingStateChanged: {
			// Terminal idle is reported by the SDK as `Result` (end of `bridge.messages()`),
			// so we don't need to emit `done` here — but we do snapshot the working-state
			// transition for `output.stopReason`. Most turns end on `stop`; if the assistant
			// stopped to call a tool, ToolCall has already set `toolUse`.
			if (event.state === DroidWorkingState.Idle && output.stopReason === "stop") {
				// no-op: handled by the natural for-await exit on `Result`
			}
			return;
		}

		case DroidMessageType.Error: {
			throw new Error(`droid: ${event.errorType}: ${event.message}`);
		}

		case DroidMessageType.Result: {
			// Final SDK message — the for-await loop will exit naturally after this.
			// If Droid reported errors, surface them.
			if (event.subtype !== "success" && event.errors?.length) {
				throw new Error(`droid: ${event.errors.join("; ")}`);
			}
			return;
		}

		// Drop the remaining variants: ToolResult (Pi has no equivalent), ToolProgress
		// (diagnostic), Assistant/User (CREATE_MESSAGE rollups we've already streamed),
		// mission/MCP/permission/settings/etc. — they're not part of the assistant
		// content stream Pi consumes.
		default:
			return;
	}
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return "";
	}
}

// ---------------------------------------------------------------------------
// Lazy session lifecycle
// ---------------------------------------------------------------------------

async function getOrCreateSession(cfg: ResolvedConfig, apiKey: string | undefined): Promise<DroidSession> {
	if (session) return session;
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (apiKey) {
		// Pi resolved `apiKey: "FACTORY_API_KEY"` to the real value via
		// `@earendil-works/pi-coding-agent/dist/core/resolve-config-value.js:14-20`.
		// Re-export it for the spawned droid (the SDK reads `env.FACTORY_API_KEY`).
		env.FACTORY_API_KEY = apiKey;
	}
	const created = await createSession({
		cwd: process.cwd(),
		execPath: cfg.droidBinary,
		// `autonomyLevel` is the SDK's typed channel; don't also pass `--auto`
		// via `execArgs` (the SDK's `buildInitParams` translates this into the
		// session-init params for us).
		autonomyLevel: autonomyFromAutoLevel(cfg.autoLevel),
		permissionHandler: () => ToolConfirmationOutcome.ProceedOnce,
		env,
	});
	session = created;
	lastSpawnAt = Date.now();
	lastError = undefined;
	return created;
}

function autonomyFromAutoLevel(level: ResolvedConfig["autoLevel"]): AutonomyLevel {
	switch (level) {
		case "low":
			return AutonomyLevel.Low;
		case "high":
			return AutonomyLevel.High;
		default:
			return AutonomyLevel.Medium;
	}
}
```

### Success Criteria:

#### Automated Verification:
- [x] Typecheck passes (covers SDK shape compatibility): `pnpm --filter @victormilk/pi-droid typecheck`
- [ ] Provider validation passes (`baseUrl` + `apiKey` required when `models` set): load extension headless, check no warning from `model-registry.js:645-656`. `pi -e ./packages/pi-droid/src/index.ts --list-models 2>&1 | grep -i 'invalid provider\|missing'` returns empty
- [x] `streamSimple` emits exactly one `start` and one terminal `done` or `error`: `grep -nE 'type: "(start|done|error)"' packages/pi-droid/src/providers.ts | wc -l` returns at least 3 (one start, one done, one error)
- [x] `pi.on("session_shutdown")` registered once: `grep -n 'session_shutdown' packages/pi-droid/src/providers.ts | wc -l` returns 1
- [x] No transient field mutation on blocks (per F2 fix): `grep -nE 'delete .*content\[' packages/pi-droid/src/providers.ts` returns empty

#### Manual Verification:
- [ ] `pi --list-models | grep '^droid/' | wc -l` reports 24
- [ ] `pi /model droid/claude-sonnet-4-6` selects the model; a streaming prompt completes a turn end-to-end
- [ ] Tool-using turn: Pi UI shows `toolcall_start` / `toolcall_delta` / `toolcall_end` (e.g. via `/provider-payload` or the running indicator)
- [ ] Ctrl+C during a streaming turn surfaces as `aborted` reason, not `error`; next turn succeeds without manual restart
- [ ] Kill the `droid` subprocess manually (`pkill droid`); next turn auto-respawns the session

## Phase 5: Slash commands

### Overview

Register `/droid-status`, `/droid-models`, `/droid-refresh`, `/droid-restart`. Status reads in-memory state; models prints grouped catalog; refresh re-resolves overrides and re-registers the provider; restart closes the singleton via `closeSession()`. Depends on Phases 1-4.

### Changes Required:

#### 1. packages/pi-droid/src/commands.ts

**File**: `packages/pi-droid/src/commands.ts`
**Changes**: NEW — four `pi.registerCommand` invocations. Pattern mirrors `packages/pi-vibeproxy/src/commands.ts:13-115` (notify helper, UI-vs-headless branching, `printGrouped` to stdout).

```ts
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { groupByFamily, resolveAll } from "./discovery.ts";
import { clearLastError, closeSession, getSessionSnapshot, registerProvider } from "./providers.ts";
import type { ResolvedConfig, ResolvedModel } from "./types.ts";

/**
 * Mutable runtime state shared with the entry point. Held in a single object
 * so commands can mutate it (e.g. refresh updates `lastModels`) without
 * reaching back into module-level let-bindings.
 *
 * `lastError` is NOT stored here — it lives in `providers.ts` so the streaming
 * code path (which has no access to this object) can write to it. `/droid-status`
 * reads it via `getSessionSnapshot().lastError`.
 */
export interface RuntimeState {
	/** Mutated by `/droid-refresh` so config edits apply without a full reload. */
	cfg: ResolvedConfig;
	lastModels: ReadonlyArray<ResolvedModel>;
}

export function registerCommands(pi: ExtensionAPI, state: RuntimeState): void {
	pi.registerCommand("droid-status", {
		description: "Report pi-droid session + config state.",
		handler: async (_args, ctx) => {
			const snap = getSessionSnapshot();
			const sessionLine = snap.sessionId
				? `session ${snap.sessionId.slice(0, 8)} (spawned ${formatAge(snap.lastSpawnAt)})`
				: "no active session";
			const configLine = state.cfg.loadedFrom ?? "defaults (no config file)";
			const errorLine = snap.lastError ?? "ok";
			const lines = [
				`droid: ${sessionLine}`,
				`  autonomy=${state.cfg.autoLevel} | binary=${state.cfg.droidBinary}`,
				`  models=${state.lastModels.length} | last error: ${errorLine}`,
				`  config: ${configLine}`,
			];
			if (ctx.hasUI) {
				ctx.ui.notify(lines[0] ?? "droid", "info");
			}
			for (const line of lines) console.log(`[pi-droid] ${line}`);
		},
	});

	pi.registerCommand("droid-models", {
		description: "List curated Droid models grouped by family.",
		handler: async (_args, ctx) => {
			const grouped = groupByFamily(state.lastModels);
			if (ctx.hasUI) {
				ctx.ui.notify(`${state.lastModels.length} models — see console for full list.`, "info");
			}
			for (const bucket of grouped) {
				console.log(`[pi-droid] ${bucket.family}:`);
				for (const m of bucket.models) {
					console.log(`[pi-droid]   ${m.piModel.id}  —  ${m.piModel.name}`);
				}
			}
		},
	});

	pi.registerCommand("droid-refresh", {
		description: "Re-read ~/.pi/agent/droid.json and re-register the provider.",
		handler: async (_args, ctx) => {
			// Re-read the config file so edits to ~/.pi/agent/droid.json take effect
			// without restarting Pi. `state.cfg` is mutated so /droid-status reflects
			// the new values on its next invocation.
			state.cfg = loadConfig();
			const resolved = resolveAll(state.cfg);
			const stats = registerProvider(pi, state.cfg, resolved);
			state.lastModels = resolved;
			clearLastError();
			notify(
				ctx,
				`pi-droid: re-registered ${stats.totalModels} models (config: ${state.cfg.loadedFrom ?? "defaults"}).`,
				"info",
			);
		},
	});

	pi.registerCommand("droid-restart", {
		description: "Close the droid subprocess. The next turn will respawn it.",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			await closeSession();
			clearLastError();
			notify(
				ctx,
				"pi-droid: session closed. Next turn will respawn the droid subprocess.",
				"info",
			);
		},
	});
}

function notify(
	ctx: ExtensionContext | ExtensionCommandContext,
	msg: string,
	kind: "info" | "warning" | "error",
): void {
	// `ExtensionCommandContext extends ExtensionContext` (types.d.ts:241), so
	// `hasUI` / `ui.notify` are accessible on both branches without casting.
	if (ctx.hasUI) {
		ctx.ui.notify(msg, kind);
	} else if (kind === "error") {
		console.error(`[pi-droid] ${msg}`);
	} else {
		console.log(`[pi-droid] ${msg}`);
	}
}

function formatAge(timestamp: number | undefined): string {
	if (!timestamp) return "—";
	const seconds = Math.floor((Date.now() - timestamp) / 1000);
	if (seconds < 60) return `${seconds}s ago`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
	return `${Math.floor(seconds / 3600)}h ago`;
}
```

### Success Criteria:

#### Automated Verification:
- [x] Typecheck passes: `pnpm --filter @victormilk/pi-droid typecheck`
- [x] Four commands registered: `grep -nE 'pi.registerCommand\("droid-(status|models|refresh|restart)"' packages/pi-droid/src/commands.ts | wc -l` returns 4
- [x] notify() literal narrowing intact: `grep -nE 'notify\([^)]*"success"' packages/pi-droid/src/commands.ts` returns empty

#### Manual Verification:
- [ ] `/droid-status` prints session id (or `no active session`) + autonomy + model count + config path
- [ ] `/droid-models` lists ~24 models grouped by family on stdout
- [ ] `/droid-refresh` after editing `~/.pi/agent/droid.json` re-applies overrides without restart
- [ ] `/droid-restart` closes the subprocess; subsequent prompt spawns a fresh session and completes successfully

## Phase 6: Entry point + READMEs

### Overview

Wire everything: factory loads config, resolves the curated catalog, registers the provider, registers commands, hooks `session_shutdown`. Ship the package README and append one row to the root README's Packages table. Terminal phase — depends on Phases 1-5.

### Changes Required:

#### 1. packages/pi-droid/src/index.ts

**File**: `packages/pi-droid/src/index.ts`
**Changes**: NEW — extension factory. Mirrors `packages/pi-vibeproxy/src/index.ts:20-71` lifecycle (load config → discovery → registerProvider → registerCommands → `session_start` notify) minus the HTTP probe.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_PATH_FOR_DIAGNOSTICS, loadConfig } from "./config.ts";
import { resolveAll } from "./discovery.ts";
import { registerProvider, wireSessionShutdown } from "./providers.ts";
import { registerCommands, type RuntimeState } from "./commands.ts";

/**
 * @victormilk/pi-droid entry point.
 *
 * Loaded as `export default async function (pi: ExtensionAPI)` so the factory
 * finishes before `pi --list-models` runs (per pi docs `custom-provider.md`).
 *
 * Lifecycle:
 *   1. Load resolved config (env > file > defaults).
 *   2. Resolve curated catalog (no probe — see discovery.ts).
 *   3. Register the `"droid"` provider (one provider, one `streamSimple`).
 *   4. Wire `pi.on("session_shutdown")` so the droid subprocess closes on exit.
 *   5. Register `/droid-*` commands.
 *   6. On session_start: surface model count + binary state via TUI.
 *
 * The `droid` subprocess is NOT spawned here — `streamSimple` lazily creates
 * the SDK session on the first turn so Pi startup pays no subprocess cost
 * when no droid model is selected, and a missing `droid` binary surfaces at
 * first use rather than breaking extension load.
 */
export default async function piDroid(pi: ExtensionAPI): Promise<void> {
	const cfg = loadConfig();
	const resolved = resolveAll(cfg);

	const state: RuntimeState = {
		cfg,
		lastModels: resolved,
	};

	const stats = registerProvider(pi, cfg, resolved);
	wireSessionShutdown(pi);
	registerCommands(pi, state);

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		const configHint = cfg.loadedFrom ? "" : ` (no config file at ${CONFIG_PATH_FOR_DIAGNOSTICS})`;
		ctx.ui.notify(
			`pi-droid: ${stats.totalModels} models available, autonomy=${cfg.autoLevel}${configHint}.`,
			"info",
		);
	});
}
```

#### 2. packages/pi-droid/README.md

**File**: `packages/pi-droid/README.md`
**Changes**: NEW — install + usage doc. Mirrors `packages/pi-vibeproxy/README.md` shape (which doesn't exist verbatim in the read but per `package.json` `files` is shipped).

```markdown
# @victormilk/pi-droid

Pi Coding Agent extension that registers Factory.AI Droid models as a model provider, backed by a long-lived `droid exec` subprocess managed via [`@factory/droid-sdk`](https://github.com/Factory-AI/droid-sdk-typescript).

## Requirements

- Pi Coding Agent ≥ 0.74
- Node ≥ 20 (pi-droid) / ≥ 18 (droid-sdk)
- `droid` CLI on PATH (or `droidBinary` configured)
- `FACTORY_API_KEY` exported in the environment

## Install

From this monorepo (local checkout):

```bash
pi install ./packages/pi-droid
```

Or one-off without installing:

```bash
pi -e ./packages/pi-droid/src/index.ts
```

## Models

The curated catalog mirrors [`docs.factory.ai/models.md`](https://docs.factory.ai/models.md) — Anthropic, OpenAI, Google, and Droid Core families (~24 entries). Browse with:

```bash
pi --list-models | grep "^droid/"
pi /droid-models
```

## Configuration

Optional `~/.pi/agent/droid.json`:

```json
{
  "droidBinary": "/usr/local/bin/droid",
  "autoLevel": "medium",
  "defaultModel": "claude-sonnet-4-6",
  "models": {
    "claude-opus-4-7": {
      "cost": { "input": 15, "output": 75, "cacheRead": 1.5, "cacheWrite": 18.75 }
    }
  }
}
```

Env vars override the file: `DROID_BINARY`, `DROID_AUTO_LEVEL`.

## Commands

- `/droid-status` — report session + config state
- `/droid-models` — list curated models grouped by family
- `/droid-refresh` — re-register the provider after editing the config file
- `/droid-restart` — close the subprocess; next turn respawns

## Architecture

Single Pi provider `"droid"` with a custom `streamSimple` body. The SDK owns:

- The `droid exec` subprocess via `ProcessTransport`
- JSON-RPC framing + request-id correlation
- Abort → `droid.interrupt_session` wiring
- Turn completion detection via `StreamStateTracker`

pi-droid owns: event translation (`DroidStreamEvent` → `AssistantMessageEvent`), the curated model catalog, the four `/droid-*` commands, and one cached `DroidSession` singleton.

Tool calls are permission-auto-resolved via `permissionHandler: () => ToolConfirmationOutcome.ProceedOnce` — combined with `--auto medium`, this disables interactive confirmation. Set `autoLevel: "low"` if you want Droid's own confirmation gates back.

## License

MIT
```

#### 3. README.md

**File**: `README.md`
**Changes**: MODIFY — append a single row to the existing Packages table. The original `pi-vibeproxy` row stays unchanged; only the `pi-droid` row is new. No other top-level edits (pnpm-workspace auto-globs `packages/*`).

```markdown
| [`@victormilk/pi-droid`](./packages/pi-droid) | Pi extension that registers Factory.AI Droid models, backed by a long-lived `droid exec` subprocess via `@factory/droid-sdk`. |
```

Insert this row immediately after the existing `pi-vibeproxy` row (`README.md` line ~7). Do NOT replace or re-author the surrounding table header / `pi-vibeproxy` row.

### Success Criteria:

#### Automated Verification:
- [x] Workspace install picks up the new package: `pnpm install` succeeds; `pnpm ls --filter @victormilk/pi-droid` shows the package
- [x] All-package typecheck passes: `pnpm -r typecheck`
- [ ] Extension entry loads headless: `pi -e ./packages/pi-droid/src/index.ts --list-models 2>&1 | grep '^droid/' | wc -l` returns 24
- [ ] No cache file written: `pi -e ./packages/pi-droid/src/index.ts --list-models > /dev/null && test ! -f ~/.pi/agent/droid-cache.json` exits 0
- [x] Root README updated: `grep -c '@victormilk/pi-droid' README.md` returns at least 1
- [x] Package README present: `test -f packages/pi-droid/README.md`
- [x] `package.json` declares Node engine floor: `node -e "const p=require('./packages/pi-droid/package.json'); if(!p.engines || !p.engines.node) process.exit(1)"`

#### Manual Verification:
- [ ] `pi /model droid/claude-sonnet-4-6` then a streaming prompt round-trips through Droid; tool calls visible in the UI
- [ ] `/droid-status` reports `session …` (after first turn), autonomy, model count, config path
- [ ] `/droid-restart` closes the subprocess; the next turn respawns it and completes
- [ ] Session shutdown (exit Pi cleanly) closes the `droid` subprocess (verify with `pgrep droid` immediately after Pi exit — returns nothing)
- [ ] Acceptance criteria from `## Requirements`: typecheck clean; `pi --list-models` shows 24 droid/ rows; streaming round-trips; tool passthrough visible; `/droid-status` reports state; `/droid-restart` recovers

## Ordering Constraints

- Phase 1 (scaffold + types) is the foundation — Phases 2-6 all import from `types.ts`
- Phase 2 (config) depends on Phase 1; can be developed in parallel with Phase 3 (discovery) once Phase 1 lands
- Phase 3 (discovery) depends on Phases 1-2 (uses `ResolvedConfig` for overrides)
- Phase 4 (providers + streamSimple) depends on Phases 1-3 — the load-bearing slice
- Phase 5 (commands) depends on Phases 1-4 — closes over the session singleton in `providers.ts`
- Phase 6 (entry + README) depends on Phases 1-5 — wires everything

## Verification Notes

- **Typecheck must pass**: `pnpm --filter @victormilk/pi-droid typecheck` (script in `package.json`). The monorepo `tsconfig.base.json` enforces `strict`, `noUncheckedIndexedAccess`, `noEmit`. Array/record access yields `T | undefined` — use `for..of` and explicit existence checks (mirrors vibeproxy's Wave-1 lesson).
- **`ui.notify` literal narrowing**: only `"info" | "warning" | "error"` (no `"success"`). Verify with `grep -n 'ui.notify' packages/pi-droid/src/*.ts` — every literal must be one of the three.
- **Idempotent registration**: `pi.registerProvider("droid", { models })` replaces existing models per `@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:866-873`. No `pi.unregisterProvider("droid")` needed in `/droid-refresh`.
- **SDK abort propagation**: SDK `session.stream({ abortSignal })` wires the signal to `client.interruptSession()` per `Factory-AI/droid-sdk-typescript@main/src/session.ts` `stream` body. Verify on Ctrl+C: pi-droid pushes `{type: "error", reason: "aborted"}` and `stream.end()` runs.
- **No `cache.json`**: `/droid-refresh` writes nothing to disk. Verify with `grep -r 'cache' packages/pi-droid/src/` — should return zero hits beyond comments.
- **DroidMessageType values are snake_case strings**: matches against `event.type === "assistant_text_delta"` work; matches against `DroidMessageType.AssistantTextDelta` (which equals `"assistant_text_delta"`) work; PascalCase string literals do NOT match. Verify the switch covers `AssistantTextDelta | AssistantTextComplete | ThinkingTextDelta | ThinkingTextComplete | ToolCallDelta | ToolCall | TokenUsageUpdate | WorkingStateChanged | Error | Result`.
- **`DroidMessageType.ToolCall` exists** — it's the `'tool_call'` variant from `CREATE_MESSAGE` rollups (distinct from `ToolCallDelta`). The switch handles both.
- **`session: null` after hard error**: any non-abort error in `streamSimple` nulls the singleton so the next turn respawns. Verify by killing `droid` mid-stream and confirming the next turn succeeds.
- **`session_shutdown` always fires**: even on Ctrl+C, even on uncaught exceptions. Verify `closeSession()` is idempotent and swallows errors.

## Performance Considerations

- **Cold-start cost** lives on the first `streamSimple` call (lazy spawn). Cost: one `droid exec` process fork + JSON-RPC handshake. Subsequent turns reuse the same session — no per-turn fork.
- **Stream buffering**: SDK's `MessageBridge` enqueues events with a single waiter `Promise`; pi-droid's switch is non-blocking. No back-pressure required.
- **`partial: output` per event** ships the running `AssistantMessage` reference, not a copy. Consumers must not mutate it.

## Migration Notes

Not applicable — new package, no existing data, no schema changes.

## Pattern References

- `packages/pi-vibeproxy/src/index.ts:20-71` — extension factory lifecycle (load config → resolve → registerProvider → register commands → session_start notify)
- `packages/pi-vibeproxy/src/config.ts:1-128` — env→file→defaults pattern + `coerceConfigFile` discipline + `CONFIG_PATH_FOR_DIAGNOSTICS` export
- `packages/pi-vibeproxy/src/commands.ts:79-115` — `notify()` UI-vs-headless helper
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/examples/extensions/custom-provider-anthropic/index.ts:281-501` — canonical `streamSimple` emitter; `output` initialization, `start` push, per-block lifecycle, abort handling, `done`/`error` close
- `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/examples/extensions/sandbox/index.ts:287-294` — `pi.on("session_shutdown")` teardown shape
- `Factory-AI/droid-sdk-typescript@main/src/session.ts` (`DroidSession.stream`) — abort wiring and `bridge.messages()` terminal `Result` exit
- `Factory-AI/droid-sdk-typescript@main/src/stream.ts:32-58` — `DroidMessageType` enum (snake_case string values, PascalCase identifiers)

## Developer Context

### Inherited from research

**Q (discover): Use a Factory subscription inside Pi.**
A: Use the developer's existing Factory.AI subscription as a model backend inside Pi.

**Q (discover): Wrap droid exec JSON-RPC as a Pi provider.**
A: New package `packages/pi-droid/` mirroring vibeproxy's six-file split; transport is `streamSimple`, not HTTP.

**Q (research): Use `@factory/droid-sdk` rather than hand-rolling JSON-RPC.**
A: SDK adopted. Adds one `dependencies` block to package.json (vibeproxy has none — minor parity break) but cuts ~400 LOC.

**Q (research): No `droid --list-models` flag exists.**
A: Curated static list in `discovery.ts` mirroring `docs.factory.ai/models.md`. No runtime probe.

### Resolved at this step

**Q (blueprint): Droid's `ToolCallDelta` ships the entire updated `toolUse` block per event, not a JSON fragment. How should `streamSimple` translate?**
A: Snapshot-as-delta. First sighting: `toolcall_start` + initial `arguments` from `toolUse.input` + `toolcall_delta` with `JSON.stringify(toolUse.input)`. Subsequent: replace `arguments`, push another `toolcall_delta`. Final `DroidToolCallMessage`: `toolcall_end`.

**Q (blueprint): When should pi-droid spawn the droid subprocess?**
A: Lazy — on first `streamSimple` invocation. Pi startup pays no subprocess cost when no droid model is selected.

**Q (blueprint): What to do with `context.systemPrompt`?**
A: Ignore. Droid owns its own system prompt internally; layering Pi's risks duplicating instructions Droid already follows.

**Q (blueprint): Keep the `~/.pi/agent/droid-cache.json` file?**
A: No. With a curated in-memory `MODELS` constant and no runtime probe, the cache file has no data to persist. `/droid-refresh` re-reads the constant; `/droid-status` reports `cfg.loadedFrom` + `state.lastModels.length`.

**Q (blueprint): Should `streamSimple` live in its own file?**
A: No. Inline in `providers.ts` to honor the FRD's "mirror vibeproxy's six-file split" requirement. providers.ts grows to ~250 LOC.

### Open from research (carried forward, not blockers)

- Pi cancellation propagation on long Droid turns — SDK wires `abortSignal → interruptSession`, but verify Ctrl+C cleanly resolves to `{type: "error", reason: "aborted"}` rather than hanging.
- `droid.ask_user` server-to-client requests are auto-cancelled by SDK default (no `askUserHandler`). Revisit if UX demands prompting.
- `ToolResult` events are dropped — assistant text following the tool call is the only user-visible trace. Verify acceptable in smoke test.
- `droid` binary version compatibility — if user's local binary predates SDK's expected JSON-RPC schema, surface in `/droid-status` (could shell out to `droid --version` in v2).

## Plan History

- Phase 1: Package scaffold + types — approved as generated
- Phase 2: Config layer — approved as generated
- Phase 3: Curated discovery — approved as generated
- Phase 4: Provider registration + streamSimple — approved as generated (one revision: typed `errorReason` local for strict-mode `AssistantMessageEvent` typecheck; dead cleanup loop + redundant envvar guard removed)
- Phase 5: Slash commands — approved as generated (one revision: dropped dead CONFIG_PATH_FOR_DIAGNOSTICS re-export)
- Phase 6: Entry point + READMEs — approved as generated
- Plan Review (Step 10): 18 findings triaged at Step 11 — 11 applied, 7 dismissed, 0 deferred. status flipped to `ready`.

## Plan Review (Step 10)

_Independent post-finalization review by artifact-reviewer subagent. Findings triaged at Step 11._

| # | plan-loc | codebase-loc | severity | dimension | finding | recommendation | resolution |
| --- | -------- | ------------ | -------- | --------- | ------- | -------------- | ---------- |
| 1 | Phase 4 `providers.ts` `streamDroid`/`translate` model arg | `pi-coding-agent/dist/core/extensions/types.d.ts:949` | HIGH | type-safety | Pi invokes `streamSimple` with `Model<Api>` (wide union); `Model<TApi>` invariant in `TApi`. `Model<typeof PROVIDER_API>` won't accept `Model<Api>` under strict typecheck. | Type both helpers as `Model<Api>`. | applied: imported `Api` from `@earendil-works/pi-ai`; both helpers typed `Model<Api>` |
| 2 | Phase 5 `/droid-refresh` + Phase 6 package README | `packages/pi-droid/src/commands.ts` + `packages/pi-droid/README.md` | HIGH | actionability | Handler only re-runs `resolveAll(state.cfg)` + `registerProvider`. `state.cfg` is captured once in `index.ts`; editing `~/.pi/agent/droid.json` and running `/droid-refresh` won't pick up the change despite README claim. | Re-invoke `loadConfig()` inside the handler and update `state.cfg` before `resolveAll`. | applied: handler now calls `state.cfg = loadConfig()` before `resolveAll`; RuntimeState.cfg is mutable; description updated |
| 3 | Phases 2/4/5 `defaultModel` plumbing | `config.ts`, `types.ts` `ResolvedConfig.defaultModel` | MED | codebase-fit | `defaultModel` is loaded/normalized but no downstream code reads it. README advertises the field. | Drop `defaultModel` from the schema or wire it (reorder `resolveAll()` output so the chosen id sorts first). | dismissed: kept as forward-compat slot for a future `/droid-default <id>` command |
| 4 | Phase 3 `resolveModel` `o.input ?? ["text"]` | `discovery.ts` | MED | codebase-fit | No per-family image-input default; every Claude/Gemini entry is text-only unless user manually overrides. Vibeproxy's `familyDefaults` (`discovery.ts:113`) gives Anthropic `["text","image"]`. | Add `input` to `DroidModel` + seed `["text","image"]` for `anthropic`/`google` families, OR document v1 as text-only and drop the regression. | applied: `DroidModel.input?` added; Anthropic + Google entries declare `IMAGE_CAPABLE`; `resolveModel` falls back through `override → curated → ["text"]` |
| 5 | Phase 4 catch + Phase 5 `/droid-status` `lastError` | `providers.ts` + `commands.ts` | MED | actionability | `state.lastError` only ever assigned `undefined`. `streamDroid` writes `output.errorMessage` but never propagates into `RuntimeState`. `/droid-status` always reports `ok` even after a hard failure. | Wire the error string into `RuntimeState.lastError` from `streamDroid` (e.g., via module-level `lastError` getter alongside `lastSpawnAt`) or drop the field from `/droid-status`. | applied: module-level `lastError` in providers.ts; surfaced via `getSessionSnapshot().lastError` + `clearLastError()`; dropped from `RuntimeState`; `/droid-status` reads from snapshot |
| 6 | Phase 4 `getOrCreateSession` `execArgs` + `autonomyLevel` | `providers.ts` | MED | code-quality | Redundant: passes `--auto` via CLI flag AND `autonomyLevel` SDK option. If SDK already emits `--auto`, binary gets it twice. | Pick one channel — SDK `autonomyLevel` is higher-level; drop `execArgs`. | applied: dropped `execArgs`; SDK `autonomyLevel` is the sole channel |
| 7 | Phases 2/3/6 Automated Verification | Success criteria using `node -e "import('./src/config.ts')"` | MED | actionability | Node can't import `.ts` directly without `tsx`/`ts-node` loader. Package has no such devDep. | Swap to `pnpm --filter @victormilk/pi-droid typecheck` for type checks; replace runtime smoke tests with `tsc --noEmit` invocations. | applied: Phase 2/3 swapped to grep + `pi -e … --list-models` checks; Phase 6 kept the existing `pnpm -r typecheck` + headless `pi -e` |
| 8 | Phase 4 `providers.ts` `onAbort` calls `droidSession?.interrupt()` | research note line 198 confirms SDK auto-interrupts | LOW | code-quality | SDK wires `abortSignal → client.interruptSession()` internally when passed via `session.stream({ abortSignal })`. Manual call is redundant; risks double-interrupting. | Drop explicit `interrupt()`; keep listener only for the `aborted` flag. | applied: dropped `interrupt()` from `onAbort`; comment cites `helpers.ts:wireAbortSignal` |
| 9 | Phase 4 catch block `session = null; lastSpawnAt = undefined` | `providers.ts` | LOW | code-quality | Bypasses `closeSession()` helper; the orphaned `DroidSession` leaks its `ProcessTransport` until next call (no `s.close()` invoked). | Call `void closeSession()` in the hard-error branch instead of inline nulling. | applied: catch now `void closeSession()`; `closeSession()` zeroes `lastSpawnAt` and awaits subprocess close |
| 10 | Phase 6 root `README.md` MODIFY block | root `README.md` | LOW | actionability | Code fence shows the full two-row table; description says "append one row". Implementer may overwrite vs. append. | Show only the added row + 1-line context, or re-label as "Replace Packages table with…". | applied: MODIFY block now shows only the new row + insertion instructions |
| 11 | Phase 6 `pi-droid/README.md` "Node ≥ 20" vs. `package.json` no `engines.node` | `packages/pi-droid/package.json` | LOW | code-quality | README declares Node floor unenforced by manifest. SDK requires `>=18`; pi-droid is silent. | Add `"engines": { "node": ">=20.0.0" }` to `package.json`, or drop version claim from README. | applied: `engines.node: >=20.0.0` added to `package.json` + criterion in Phase 6 Automated Verification |
| 12 | Phase 4 `output.timestamp = Date.now()` at construction | `providers.ts` `streamDroid` `output` init | LOW | code-quality | Set before upstream subprocess responds; semantically the receive-prep time, not assistant-reply time. Matches Anthropic example convention. | Either accept (matches convention) or move assignment to `done`/`error` push site. | dismissed: matches `custom-provider-anthropic/index.ts:357` convention |
| 13 | Phase 1 `ResolvedModel.family` duplicates `source.family` | `types.ts` | LOW | code-quality | Both fields carry the same `DroidFamily` value (set together in `resolveModel`); `groupByFamily` uses `m.family`. | Drop `ResolvedModel.family` (read through `source.family`), OR drop `DroidModel.family`. | dismissed: minor surface duplication; both fields are convenient for grouping vs. catalog lookup |
| 14 | Phase 4 Success Criteria `grep -nE 'delete .*content\['` mentions "F2 fix" | `providers.ts` Automated Verification | LOW | actionability | `Plan History` lists no "F2" reference; check is ungrounded narrative. | Remove the check or document F2 in Plan History. | dismissed: Plan History entry for Phase 4 now documents the dead-loop removal; check is still a useful invariant guard |
| 15 | Phase 4 `translate()` `WorkingStateChanged` case | `providers.ts` | NIT | code-quality | Empty `if (event.state === Idle && stopReason === "stop") { }` block. Dead branch. | Delete the empty `if` or drop the case (falls through default). | dismissed: kept as anchor for future per-state UI hints (the comment is the value, not the code) |
| 16 | Phase 4 `translate()` `Error` case throws mid-stream | `providers.ts` | NIT | code-quality | Throws while open `text_start` / `toolcall_start` blocks have no `*_end`. Pi consumers see truncated blocks. | Document the truncation behavior in a comment; not load-bearing. | dismissed: truncation is the correct behavior on protocol error; mid-block close events would be lying about a successful end |
| 17 | Phase 4 `const config: ProviderConfig = { … }` then `pi.registerProvider(name, config)` | `providers.ts` `registerProvider` | NIT | code-quality | Inlines object literal would match vibeproxy `providers.ts:60-66`. | Inline the literal into `pi.registerProvider("droid", { … })`. | dismissed: typed local is clearer when the `streamSimple` arrow captures `cfg` |
| 18 | Phase 5 `(ctx as ExtensionContext).hasUI` casts | `commands.ts` `notify()` helper | NIT | code-quality | `ExtensionCommandContext extends ExtensionContext` per `types.d.ts:241`; `ctx.hasUI` accessible without cast. Union typing unnecessary — every call site is command context. | Drop the cast and union. | applied: dropped both casts; comment cites types.d.ts:241 inheritance |

## References

- Research: `thoughts/shared/research/2026-05-15_15-25-58_pi-droid-factory-ai-provider.md`
- Discover (FRD): `thoughts/shared/discover/2026-05-15_15-00-31_pi-droid-factory-ai-provider.md`
- Sibling plan (vibeproxy): `thoughts/shared/plans/2026-05-15_13-51-28_pi-vibeproxy-extension.md`
- SDK source: `https://github.com/Factory-AI/droid-sdk-typescript`
- Pi extension types: `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`
- Pi AI types: `packages/pi-vibeproxy/node_modules/@earendil-works/pi-ai/dist/types.d.ts`
- Anthropic streamSimple template: `packages/pi-vibeproxy/node_modules/@earendil-works/pi-coding-agent/examples/extensions/custom-provider-anthropic/index.ts`
