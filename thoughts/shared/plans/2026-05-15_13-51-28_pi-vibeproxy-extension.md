---
date: 2026-05-15T13:51:28-0300
author: victor
commit: no-commit
branch: no-branch
repository: pilks-mono
topic: "@victormilk/pi-vibeproxy — Pi Coding Agent extension for CLIProxyAPIPlus (VibeProxy)"
tags: [plan, pi-coding-agent, pi-package, custom-provider, vibeproxy, cliproxyapiplus, monorepo]
status: ready
parent: thoughts/shared/designs/2026-05-15_13-23-34_pi-vibeproxy-extension.md
last_updated: 2026-05-15T14:29:28-0300
last_updated_by: victor
last_updated_note: "Post-validate follow-up: family-level Anthropic defaults (reasoning, image, 200K ctx), thinkingLevelMap defaults for Opus 4.6/4.7/Sonnet 4.6, 1M context for Opus 4.6/4.7."
---

# @victormilk/pi-vibeproxy Implementation Plan

## Overview

Greenfield build of the `pilks-mono` pnpm monorepo and its first extension, `@victormilk/pi-vibeproxy` — a Pi Coding Agent extension that registers two model providers (`vibeproxy` for `anthropic-messages`, `vibeproxy-openai` for `openai-completions`) backed by a single CLIProxyAPIPlus instance. Configuration lives in `~/.pi/agent/vibeproxy.json` with `VIBEPROXY_URL` / `VIBEPROXY_API_KEY` env-var overrides; capabilities come from per-model config overrides merged onto conservative defaults (no id-substring heuristics). Total rewrite from zero — the prior `pi-proxy-models@0.0.4` MVP is reference-only.

See design: `thoughts/shared/designs/2026-05-15_13-23-34_pi-vibeproxy-extension.md`.

## Desired End State

After installation and config setup, the developer launches Pi and sees VibeProxy as two selectable providers:

```bash
$ pi --list-models | grep vibeproxy
vibeproxy/claude-sonnet-4-5
vibeproxy-openai/gpt-4o
# ...

$ pi
> /model vibeproxy-openai/gpt-4o
> Write a haiku about TypeScript.
[VibeProxy: N models available (A Anthropic, O OpenAI).]
[tokens stream visibly]
```

Streaming and tool calls round-trip via pi-ai's built-in adapters; the extension is never on the request hot path. `/vibeproxy-status`, `/vibeproxy-models`, and `/vibeproxy-refresh` commands are available at runtime.

## What We're NOT Doing

- No `packages/core/` shared package (deferred until a second extension consumer exists).
- No build pipeline (no `tsup`, no bundling, no `dist/`). Pi loads `.ts` directly via jiti; only `pnpm typecheck` is wired.
- No Gemini family / `vibeproxy-gemini` provider — out of v2 FRD scope.
- No automated unit/integration tests — acceptance is manual smoke test only.
- No npm publish workflow / CI automation — deferred.
- No `streamSimple` custom streaming — built-in `anthropic-messages` and `openai-completions` cover everything CLIProxyAPIPlus needs.
- No OAuth flow — CLIProxyAPIPlus uses simple Bearer tokens.
- No id-substring capability heuristics (explicitly NOT carried over from MVP).
- No `contextOverrides` / `maxTokensOverrides` as separate config maps — collapsed into the unified per-model override block.
- No LICENSE file (root only when published; deferred).

---

## Phase 1: Monorepo Scaffold

### Overview
Bootstrap the `pilks-mono` pnpm workspace so packages can be installed and typechecked. Adds the workspace declaration, root package manifest, shared TS base config, ignore file, and the overview README. After this phase, `pnpm install` runs cleanly at the repo root but no package code exists yet.

### Changes Required:

#### 1. Workspace declaration
**File**: `pnpm-workspace.yaml`
**Changes**: Declare `packages/*` as workspace globs.

```yaml
packages:
  - "packages/*"
```

#### 2. Root workspace package manifest
**File**: `package.json`
**Changes**: Private root package; devDeps only; scripts proxy to workspaces.

```json
{
  "name": "pilks-mono",
  "version": "0.0.0",
  "private": true,
  "description": "Monorepo for Pi Coding Agent extensions.",
  "type": "module",
  "scripts": {
    "typecheck": "pnpm -r --parallel typecheck",
    "lint": "pnpm -r --parallel lint || true"
  },
  "devDependencies": {
    "typescript": "^5.7.3"
  },
  "packageManager": "pnpm@11.1.2",
  "engines": {
    "node": ">=20"
  }
}
```

#### 3. Shared TypeScript base config
**File**: `tsconfig.base.json`
**Changes**: Strict, `noEmit: true`, allow `.ts` imports (jiti runtime loading).

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noUncheckedIndexedAccess": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

#### 4. Git ignore
**File**: `.gitignore`
**Changes**: Standard Node + TS ignores. Vibeproxy config lives outside the repo (`~/.pi/agent/vibeproxy.json`) so nothing config-related is excluded here.

```
node_modules/
*.log
.DS_Store
.pnpm-store/
dist/
.tsbuildinfo
*.tsbuildinfo
.env
.env.local
```

#### 5. Monorepo README
**File**: `README.md`
**Changes**: Overview of the monorepo, package table, dev workflow, install instructions.

````markdown
# pilks-mono

Monorepo for Pi Coding Agent (`@mariozechner/pi-coding-agent`) extensions.

## Packages

| Package | Description |
|---------|-------------|
| [`@victormilk/pi-vibeproxy`](./packages/pi-vibeproxy) | Pi extension that registers a CLIProxyAPIPlus instance as two model providers (Anthropic + OpenAI surfaces). |

## Development

Requires `pnpm` ≥ 9 and Node ≥ 20.

```bash
pnpm install
pnpm typecheck
```

Pi loads extensions as `.ts` directly via jiti — there is no build step.

## Installing an extension into Pi

From the workspace root:

```bash
pi install ./packages/pi-vibeproxy
```

Or for one-off testing:

```bash
pi -e ./packages/pi-vibeproxy/src/index.ts
```
````

### Success Criteria:

#### Automated Verification:
- [x] `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`, `.gitignore`, `README.md` exist at repo root.
- [x] `pnpm install` at repo root exits 0.
- [x] `pnpm typecheck` at repo root exits 0 (no packages yet → no-op succeeds).
- [x] `node -e "JSON.parse(require('fs').readFileSync('package.json','utf-8'))"` exits 0 (root manifest is valid JSON).
- [x] `node -e "JSON.parse(require('fs').readFileSync('tsconfig.base.json','utf-8'))"` exits 0.

#### Manual Verification:
- [x] `cat pnpm-workspace.yaml` shows `packages/*` glob.
- [ ] Root `README.md` renders without broken links in a markdown previewer.

---

## Phase 2: Package Skeleton + Types Contract

### Overview
Create the `packages/pi-vibeproxy/` directory, its pi-package manifest with full keyword list, scoped tsconfig, the `src/types.ts` contract that every later module imports from, and the package README documenting install + config + smoke-test steps. After this phase, the package is installable into pnpm but has no runtime entry (yet) — `src/index.ts` lands in Phase 3.

### Changes Required:

#### 1. Pi-package manifest
**File**: `packages/pi-vibeproxy/package.json`
**Changes**: Scoped npm name, `pi.extensions` points at the TS entry (Phase 3 will create it), peer-deps on `@earendil-works/pi-coding-agent` + `@earendil-works/pi-ai` (the @mariozechner/* packages are deprecated upstream as of 0.74.0), devDeps for typecheck, full keyword list (27 entries) for npm discoverability.

```json
{
  "name": "@victormilk/pi-vibeproxy",
  "version": "0.1.0",
  "description": "Pi Coding Agent extension that exposes a CLIProxyAPIPlus (VibeProxy) instance as Anthropic and OpenAI model providers.",
  "license": "MIT",
  "author": "Victor Leite Costa",
  "homepage": "https://github.com/victormilk/pilks-mono/tree/main/packages/pi-vibeproxy#readme",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/victormilk/pilks-mono.git",
    "directory": "packages/pi-vibeproxy"
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
    "vibeproxy",
    "cliproxyapiplus",
    "cliproxy",
    "cliproxyapi",
    "llm-proxy",
    "llm-gateway",
    "openai",
    "openai-compatible",
    "openai-completions",
    "anthropic",
    "anthropic-messages",
    "claude",
    "gpt",
    "model-router",
    "proxy",
    "local-llm",
    "self-hosted",
    "streaming",
    "tool-calling",
    "function-calling"
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
  "scripts": {
    "typecheck": "tsc --noEmit"
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

#### 2. Package tsconfig
**File**: `packages/pi-vibeproxy/tsconfig.json`
**Changes**: Extends the root base; pins `@types/node`; includes only `src/**/*.ts`.

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

#### 3. Shared types contract
**File**: `packages/pi-vibeproxy/src/types.ts`
**Changes**: Hand-written interfaces — config schema, resolved config, upstream model shape, family spec, resolved model. No runtime validator; defensive narrowing happens in `config.ts` at parse time.

```typescript
/**
 * Shared types for @victormilk/pi-vibeproxy.
 *
 * No runtime validator (typebox/zod) on purpose: Pi extensions are loaded into
 * a trusted local process, and the config file lives in the user's home dir.
 * Defensive narrowing happens at parse time in `config.ts`.
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Public config schema (~/.pi/agent/vibeproxy.json)
// ---------------------------------------------------------------------------

/**
 * Per-model override block. All fields optional; unspecified fields fall back
 * to the conservative defaults in `discovery.ts`.
 */
export interface ModelOverride {
	name?: string;
	reasoning?: boolean;
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

/**
 * Shape of `~/.pi/agent/vibeproxy.json` as authored by the user.
 * All fields optional; env vars and defaults fill the rest.
 */
export interface ConfigFile {
	baseUrl?: string;
	apiKey?: string;
	/** Per-model overrides keyed by model id as returned by /v1/models. */
	models?: Record<string, ModelOverride>;
}

/**
 * Fully-resolved runtime config after env overrides + defaults are applied.
 * `baseUrl` is guaranteed; `apiKey` is `""` when none configured.
 */
export interface ResolvedConfig {
	baseUrl: string;
	apiKey: string;
	modelOverrides: Record<string, ModelOverride>;
	/** Path the config file was loaded from, or `undefined` if it didn't exist. */
	loadedFrom?: string;
}

// ---------------------------------------------------------------------------
// CLIProxyAPIPlus wire shapes
// ---------------------------------------------------------------------------

/** Subset of GET /v1/models response items we care about. */
export interface UpstreamModel {
	id: string;
	owned_by?: string;
	object?: string;
	created?: number;
}

// ---------------------------------------------------------------------------
// Family / provider partitioning
// ---------------------------------------------------------------------------

export type Family = "anthropic" | "openai";

export type ProviderApi = "anthropic-messages" | "openai-completions";

export interface FamilySpec {
	readonly family: Family;
	readonly providerName: string;
	readonly api: ProviderApi;
	/** Suffix appended to `ResolvedConfig.baseUrl` when registering this family. */
	readonly baseSuffix: string;
	readonly displayName: string;
}

/**
 * A discovered upstream model with its classified family and Pi-ready capabilities
 * applied. This is the shape `providers.ts` consumes to build `ProviderModelConfig`.
 */
export interface ResolvedModel {
	readonly upstream: UpstreamModel;
	readonly family: Family;
	readonly piModel: ProviderModelConfig;
}
```

#### 4. Package README
**File**: `packages/pi-vibeproxy/README.md`
**Changes**: Install instructions, config schema example, env-var overrides, capability default table, command reference, manual smoke-test steps.

````markdown
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
    }
  }
}
```

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
````

### Success Criteria:

#### Automated Verification:
- [x] `packages/pi-vibeproxy/package.json`, `tsconfig.json`, `src/types.ts`, `README.md` all exist.
- [x] `node -e "const p=require('./packages/pi-vibeproxy/package.json'); if(p.name!=='@victormilk/pi-vibeproxy')process.exit(1); if(!p.pi||!Array.isArray(p.pi.extensions))process.exit(1); if(p.keywords.length<27)process.exit(1);"` exits 0.
- [x] `pnpm install` at repo root succeeds and recognises `@victormilk/pi-vibeproxy` as a workspace member: `pnpm -r ls --depth -1 | grep -q '@victormilk/pi-vibeproxy'`.
- [x] `pnpm -F @victormilk/pi-vibeproxy exec tsc --noEmit -p tsconfig.json --listFiles >/dev/null` exits 0 (types.ts compiles standalone — `ProviderModelConfig` import from `@mariozechner/pi-coding-agent` resolves).
- [x] `grep -nE "if \(.*\\.includes\(" packages/pi-vibeproxy/src/types.ts | wc -l` reports 0 (no heuristics in the types layer).

#### Manual Verification:
- [ ] `package.json` `keywords` array contains both `pi-package` and `vibeproxy` (`grep -c '"pi-package"' packages/pi-vibeproxy/package.json` and `grep -c '"vibeproxy"' packages/pi-vibeproxy/package.json` both ≥ 1).
- [ ] `packages/pi-vibeproxy/README.md` renders cleanly with the provider/path table, config example block, defaults table, and 6-step smoke test.
- [ ] `peerDependencies` lists `@mariozechner/pi-coding-agent` and `@mariozechner/pi-ai` (NOT `dependencies`).

---

## Phase 3: Core Runtime Modules + Entry Point

### Overview
Implement the five `src/` modules that wire the extension together: `config.ts` (env-layered loader), `discovery.ts` (HTTP probe + classification + safe defaults + fallback list), `providers.ts` (FAMILIES table + `registerFamilies` / `unregisterAll` with `no-key` placeholder), `commands.ts` (`/vibeproxy-status|models|refresh`), and `index.ts` (async factory entry point that ties them all together and queues a `session_start` notify). Each module strictly depends on the prior one per the design's Ordering Constraints. After this phase, `pi --list-models` lists both `vibeproxy/...` and `vibeproxy-openai/...` providers and the manual smoke test passes.

### Changes Required:

#### 1. Config loader
**File**: `packages/pi-vibeproxy/src/config.ts`
**Changes**: Read `~/.pi/agent/vibeproxy.json` if it exists, layer env vars on top, normalise per-model override fields defensively, never throw. Exports `loadConfig()` and `CONFIG_PATH_FOR_DIAGNOSTICS`.

```typescript
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConfigFile, ModelOverride, ResolvedConfig } from "./types.ts";

const DEFAULT_BASE_URL = "http://localhost:8317";
const CONFIG_PATH = join(homedir(), ".pi", "agent", "vibeproxy.json");

/**
 * Load and resolve runtime config.
 *
 * Layering (later wins):
 *   defaults  <  ~/.pi/agent/vibeproxy.json  <  env vars (VIBEPROXY_URL, VIBEPROXY_API_KEY)
 *
 * Returns a fully-resolved config; the file is optional, missing fields are filled
 * with safe defaults, malformed values are warned-about and ignored.
 */
export function loadConfig(): ResolvedConfig {
	const fromFile = readConfigFile(CONFIG_PATH);

	const envUrl = process.env.VIBEPROXY_URL?.trim();
	const envKey = process.env.VIBEPROXY_API_KEY?.trim();

	const baseUrl = stripTrailingSlash(envUrl || fromFile.parsed.baseUrl?.trim() || DEFAULT_BASE_URL);
	const apiKey = envKey ?? fromFile.parsed.apiKey ?? "";

	return {
		baseUrl,
		apiKey,
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
		console.warn(`[vibeproxy] Failed to read ${path}: ${(err as Error).message}. Using defaults.`);
		return { exists: true, parsed: {} };
	}
}

/**
 * Coerce an unknown JSON value into a `ConfigFile`. Unknown / malformed fields
 * are dropped with a warning; we never throw — the extension must still load.
 */
function coerceConfigFile(value: unknown, path: string): ConfigFile {
	if (!isPlainObject(value)) {
		console.warn(`[vibeproxy] ${path} is not a JSON object. Ignoring contents.`);
		return {};
	}
	const out: ConfigFile = {};
	if (typeof value.baseUrl === "string") out.baseUrl = value.baseUrl;
	if (typeof value.apiKey === "string") out.apiKey = value.apiKey;
	if (isPlainObject(value.models)) {
		out.models = value.models as Record<string, ModelOverride>;
	}
	return out;
}

function normalizeModelOverrides(raw: Record<string, ModelOverride> | undefined): Record<string, ModelOverride> {
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

function stripTrailingSlash(url: string): string {
	return url.replace(/\/+$/, "");
}

export const CONFIG_PATH_FOR_DIAGNOSTICS = CONFIG_PATH;
```

#### 2. Model discovery + classification
**File**: `packages/pi-vibeproxy/src/discovery.ts`
**Changes**: Fetch `/v1/models` with 10s timeout, classify by `owned_by` then fallback id-substring on owner only (id-substring on owner string for `classifyFamily` is allowed; id-substring on the model id for capability inference is forbidden). Conservative defaults applied via `resolveModel`. Returns a `DiscoveryResult` with `usedFallback`, `error`, and `httpStatus` so the entry point can react to 401.

```typescript
import type { Family, ResolvedConfig, ResolvedModel, UpstreamModel } from "./types.ts";

const DISCOVERY_TIMEOUT_MS = 10_000;

/**
 * Conservative defaults for unspecified model capabilities. The MVP used
 * id-substring heuristics here; v2 deliberately does not — the user is expected
 * to declare per-model overrides in `~/.pi/agent/vibeproxy.json` to unlock
 * reasoning, image input, or larger context windows.
 */
const DEFAULT_CAPS = {
	reasoning: false,
	input: ["text"] as ReadonlyArray<"text" | "image">,
	contextWindow: 128_000,
	maxTokens: 8_192,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as const;

/**
 * Fallback model list used when the proxy is unreachable at startup. Chosen to
 * cover both surfaces with one model each so the extension still demos.
 */
const FALLBACK_MODELS: ReadonlyArray<UpstreamModel> = [
	{ id: "claude-sonnet-4-5", owned_by: "anthropic" },
	{ id: "gpt-4o-mini", owned_by: "openai" },
];

export interface DiscoveryResult {
	models: ReadonlyArray<UpstreamModel>;
	/** True when the list is the static `FALLBACK_MODELS` (proxy was unreachable). */
	usedFallback: boolean;
	/** Populated only when discovery failed. */
	error?: string;
	/** HTTP status when discovery returned non-OK; useful for 401 detection. */
	httpStatus?: number;
}

export async function fetchUpstreamModels(cfg: ResolvedConfig): Promise<DiscoveryResult> {
	const url = `${cfg.baseUrl}/v1/models`;
	const headers: Record<string, string> = { Accept: "application/json" };
	if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

	try {
		const res = await fetch(url, {
			headers,
			signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
		});
		if (!res.ok) {
			return {
				models: FALLBACK_MODELS,
				usedFallback: true,
				error: `HTTP ${res.status} ${res.statusText}`,
				httpStatus: res.status,
			};
		}
		const data = (await res.json()) as { data?: unknown };
		if (!Array.isArray(data?.data)) {
			return {
				models: FALLBACK_MODELS,
				usedFallback: true,
				error: "Unexpected /v1/models response shape (no `data` array).",
			};
		}
		const models = data.data.filter(isUpstreamModel);
		if (models.length === 0) {
			return { models: FALLBACK_MODELS, usedFallback: true, error: "Empty model list from /v1/models." };
		}
		return { models, usedFallback: false };
	} catch (err) {
		return {
			models: FALLBACK_MODELS,
			usedFallback: true,
			error: (err as Error).message,
		};
	}
}

function isUpstreamModel(value: unknown): value is UpstreamModel {
	if (typeof value !== "object" || value === null) return false;
	const m = value as Record<string, unknown>;
	return typeof m.id === "string" && m.id.length > 0;
}

/**
 * Classify a model into a provider family. CLIProxyAPIPlus returns
 * `owned_by` strings like "anthropic", "openai", "google"; some entries omit
 * the field entirely, so we fall back to id-substring matching as a last resort.
 *
 * Gemini family is out of v2 scope — Google-owned models are routed to
 * "openai" so the OpenAI-completions surface at least returns *something*,
 * matching CLIProxyAPIPlus's behavior of accepting any model id on /v1/chat/completions.
 * (Document follow-up: add a "gemini" family + provider when needed.)
 */
export function classifyFamily(m: UpstreamModel): Family {
	const owner = (m.owned_by ?? "").toLowerCase();
	if (owner === "anthropic" || owner.includes("anthropic")) return "anthropic";
	if (owner === "openai" || owner.includes("openai")) return "openai";

	const id = m.id.toLowerCase();
	if (id.includes("claude")) return "anthropic";
	return "openai";
}

/**
 * Apply per-model config overrides on top of conservative defaults. The result
 * is a `ProviderModelConfig`-shaped object ready for `pi.registerProvider`.
 */
export function resolveModel(upstream: UpstreamModel, cfg: ResolvedConfig): ResolvedModel {
	const override = cfg.modelOverrides[upstream.id] ?? {};
	const family = classifyFamily(upstream);

	const piModel = {
		id: upstream.id,
		name: override.name ?? (upstream.owned_by ? `${upstream.id} (${upstream.owned_by})` : upstream.id),
		reasoning: override.reasoning ?? DEFAULT_CAPS.reasoning,
		input: (override.input ?? DEFAULT_CAPS.input).slice() as Array<"text" | "image">,
		cost: override.cost ?? { ...DEFAULT_CAPS.cost },
		contextWindow: override.contextWindow ?? DEFAULT_CAPS.contextWindow,
		maxTokens: override.maxTokens ?? DEFAULT_CAPS.maxTokens,
	};

	return { upstream, family, piModel };
}

export function resolveAll(
	models: ReadonlyArray<UpstreamModel>,
	cfg: ResolvedConfig,
): ReadonlyArray<ResolvedModel> {
	return models.map((m) => resolveModel(m, cfg));
}

export { FALLBACK_MODELS, DEFAULT_CAPS };
```

#### 3. Provider registration
**File**: `packages/pi-vibeproxy/src/providers.ts`
**Changes**: Single source of truth FAMILIES table; `registerFamilies` buckets resolved models by family and calls `pi.registerProvider` once per non-empty bucket (unregistering empty ones). Uses `"no-key"` placeholder when `cfg.apiKey` is empty to satisfy Pi's non-empty `apiKey` validation when `models` is supplied. `unregisterAll` is the symmetric teardown.

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Family, FamilySpec, ResolvedConfig, ResolvedModel } from "./types.ts";

/**
 * Pi's `ProviderConfig` validation rejects empty `apiKey` when `models` is set.
 * CLIProxyAPIPlus ignores any key when its own `api-keys:` list is empty, so a
 * placeholder satisfies Pi without affecting the proxy.
 */
const PLACEHOLDER_API_KEY = "no-key";

/**
 * The family spec table — single source of truth for "how this extension maps
 * one CLIProxyAPIPlus instance into two Pi providers." Adding Gemini later is
 * one extra entry here (+ classify support in discovery.ts).
 */
export const FAMILIES: Record<Family, FamilySpec> = {
	anthropic: {
		family: "anthropic",
		providerName: "vibeproxy",
		api: "anthropic-messages",
		baseSuffix: "",
		displayName: "VibeProxy (Anthropic)",
	},
	openai: {
		family: "openai",
		providerName: "vibeproxy-openai",
		api: "openai-completions",
		baseSuffix: "/v1",
		displayName: "VibeProxy (OpenAI)",
	},
};

export interface RegistrationStats {
	totalModels: number;
	perFamily: Record<Family, number>;
}

/**
 * Register one Pi provider per family that has at least one model. Families
 * with no models are unregistered (cleanup for refresh after the model list
 * shrinks).
 */
export function registerFamilies(
	pi: ExtensionAPI,
	cfg: ResolvedConfig,
	resolved: ReadonlyArray<ResolvedModel>,
): RegistrationStats {
	const buckets: Record<Family, ResolvedModel[]> = { anthropic: [], openai: [] };
	for (const m of resolved) buckets[m.family].push(m);

	const effectiveKey = cfg.apiKey || PLACEHOLDER_API_KEY;
	const stats: RegistrationStats = { totalModels: 0, perFamily: { anthropic: 0, openai: 0 } };

	for (const family of Object.keys(buckets) as Family[]) {
		const spec = FAMILIES[family];
		const models = buckets[family];
		if (models.length === 0) {
			safeUnregister(pi, spec.providerName);
			continue;
		}

		pi.registerProvider(spec.providerName, {
			name: spec.displayName,
			baseUrl: cfg.baseUrl + spec.baseSuffix,
			apiKey: effectiveKey,
			api: spec.api,
			models: models.map((m) => m.piModel),
		});

		stats.totalModels += models.length;
		stats.perFamily[family] = models.length;
	}

	return stats;
}

export function unregisterAll(pi: ExtensionAPI): void {
	for (const spec of Object.values(FAMILIES)) safeUnregister(pi, spec.providerName);
}

function safeUnregister(pi: ExtensionAPI, name: string): void {
	try {
		pi.unregisterProvider(name);
	} catch {
		/* not registered — no-op */
	}
}
```

#### 4. Commands
**File**: `packages/pi-vibeproxy/src/commands.ts`
**Changes**: `/vibeproxy-status` pings `/v1/models` and reports counts; `/vibeproxy-models` lists models grouped by `owned_by`; `/vibeproxy-refresh` re-fetches and re-registers. Mutable `RuntimeState` shared with `index.ts` carries the resolved config and last-known model list. Notifications fall back to console when no UI context is attached. The SDK's `ui.notify` accepts only `"info" | "warning" | "error"`, so positive outcomes use `"info"` (not `"success"`).

```typescript
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fetchUpstreamModels, resolveAll } from "./discovery.ts";
import { registerFamilies } from "./providers.ts";
import type { ResolvedConfig, UpstreamModel } from "./types.ts";

/**
 * Mutable runtime state shared with the entry point. Held in a single object
 * so commands can mutate it (e.g. refresh updates `lastModels`) without
 * reaching back into module-level let-bindings.
 */
export interface RuntimeState {
	cfg: ResolvedConfig;
	lastModels: ReadonlyArray<UpstreamModel>;
	lastError?: string;
}

export function registerCommands(pi: ExtensionAPI, state: RuntimeState): void {
	pi.registerCommand("vibeproxy-status", {
		description: "Ping VibeProxy (CLIProxyAPIPlus) and report model count.",
		handler: async (_args, ctx) => {
			const result = await fetchUpstreamModels(state.cfg);
			if (result.usedFallback) {
				state.lastError = result.error;
				notify(
					ctx,
					`VibeProxy unreachable at ${state.cfg.baseUrl}: ${result.error}. Using fallback list (${result.models.length} models).`,
					"error",
				);
				return;
			}
			state.lastModels = result.models;
			state.lastError = undefined;
			const auth = state.cfg.apiKey ? "with API key" : "no API key";
			notify(
				ctx,
				`VibeProxy OK — ${result.models.length} models @ ${state.cfg.baseUrl} (${auth}).`,
				"info",
			);
			if (!ctx.hasUI) printGrouped(result.models);
		},
	});

	pi.registerCommand("vibeproxy-models", {
		description: "List all available VibeProxy models grouped by owner.",
		handler: async (_args, ctx) => {
			const result = await fetchUpstreamModels(state.cfg);
			if (result.usedFallback) {
				notify(ctx, `VibeProxy models failed: ${result.error}`, "error");
				return;
			}
			state.lastModels = result.models;
			if (ctx.hasUI) {
				ctx.ui.notify(`${result.models.length} models (see console for full list).`, "info");
			}
			printGrouped(result.models);
		},
	});

	pi.registerCommand("vibeproxy-refresh", {
		description: "Re-fetch /v1/models and re-register VibeProxy providers.",
		handler: async (_args, ctx) => {
			const result = await fetchUpstreamModels(state.cfg);
			if (result.usedFallback) {
				notify(ctx, `VibeProxy refresh failed: ${result.error}. Providers not updated.`, "error");
				return;
			}
			state.lastModels = result.models;
			state.lastError = undefined;
			const stats = registerFamilies(pi, state.cfg, resolveAll(result.models, state.cfg));
			notify(
				ctx,
				`VibeProxy: refreshed ${stats.totalModels} models (${stats.perFamily.anthropic} Anthropic, ${stats.perFamily.openai} OpenAI).`,
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
	if ((ctx as ExtensionContext).hasUI) {
		(ctx as ExtensionContext).ui.notify(msg, kind);
	} else if (kind === "error") {
		console.error(`[vibeproxy] ${msg}`);
	} else {
		console.log(`[vibeproxy] ${msg}`);
	}
}

function printGrouped(models: ReadonlyArray<UpstreamModel>): void {
	const grouped = new Map<string, string[]>();
	for (const m of models) {
		const owner = m.owned_by || "unknown";
		const list = grouped.get(owner) ?? [];
		list.push(m.id);
		grouped.set(owner, list);
	}
	for (const owner of [...grouped.keys()].sort()) {
		const ids = (grouped.get(owner) ?? []).slice().sort();
		console.log(`  ${owner}:`);
		for (const id of ids) console.log(`    ${id}`);
	}
}
```

#### 5. Entry point
**File**: `packages/pi-vibeproxy/src/index.ts`
**Changes**: Async default export (factory awaited before `--list-models` runs). Loads config, probes `/v1/models` once at startup, warns on 401 and on fallback, registers providers, wires commands, queues a `session_start` notify so the user sees state when the TUI mounts.

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_PATH_FOR_DIAGNOSTICS, loadConfig } from "./config.ts";
import { fetchUpstreamModels, resolveAll } from "./discovery.ts";
import { registerFamilies } from "./providers.ts";
import { registerCommands, type RuntimeState } from "./commands.ts";

/**
 * @victormilk/pi-vibeproxy entry point.
 *
 * Loaded as `export default async function (pi: ExtensionAPI)` so the factory
 * finishes before `pi --list-models` runs (per pi docs `custom-provider.md:69`).
 *
 * Lifecycle:
 *   1. Load resolved config (env > file > defaults).
 *   2. Probe GET /v1/models. If 401, warn the user (apiKey likely required).
 *   3. Register providers using discovered or fallback model list.
 *   4. Register commands so the user can refresh / inspect at runtime.
 *   5. On session_start: surface notable state to the user via the TUI.
 */
export default async function vibeproxy(pi: ExtensionAPI): Promise<void> {
	const cfg = loadConfig();
	const discovery = await fetchUpstreamModels(cfg);

	const state: RuntimeState = {
		cfg,
		lastModels: discovery.models,
		lastError: discovery.error,
	};

	if (discovery.usedFallback) {
		const where = cfg.loadedFrom ?? "no config file";
		console.warn(
			`[vibeproxy] Could not reach VibeProxy at ${cfg.baseUrl} (${discovery.error}). ` +
				`Using fallback model list (${discovery.models.length} models). Config: ${where}. ` +
				`Run /vibeproxy-refresh once the proxy is reachable.`,
		);
	}

	if (discovery.httpStatus === 401) {
		console.warn(
			`[vibeproxy] /v1/models returned 401 Unauthorized. ` +
				`Set VIBEPROXY_API_KEY or "apiKey" in ${CONFIG_PATH_FOR_DIAGNOSTICS}.`,
		);
	}

	const stats = registerFamilies(pi, cfg, resolveAll(discovery.models, cfg));
	registerCommands(pi, state);

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		if (discovery.httpStatus === 401) {
			ctx.ui.notify(
				`VibeProxy: auth required (401). Set VIBEPROXY_API_KEY or edit ${CONFIG_PATH_FOR_DIAGNOSTICS}.`,
				"warning",
			);
			return;
		}
		if (discovery.usedFallback) {
			ctx.ui.notify(
				`VibeProxy unreachable (${discovery.error}). Loaded ${discovery.models.length} fallback models — /vibeproxy-refresh to retry.`,
				"warning",
			);
			return;
		}
		ctx.ui.notify(
			`VibeProxy: ${stats.totalModels} models available (${stats.perFamily.anthropic} Anthropic, ${stats.perFamily.openai} OpenAI).`,
			"info",
		);
	});
}
```

### Success Criteria:

#### Automated Verification:
- [x] All five files exist: `packages/pi-vibeproxy/src/{config,discovery,providers,commands,index}.ts`.
- [x] `pnpm install && pnpm typecheck` at repo root exits 0.
- [x] `pnpm -F @victormilk/pi-vibeproxy typecheck` exits 0.
- [x] No id-substring capability heuristics: `grep -nE "\.id\.includes\(|\.id\.toLowerCase\(\)\.includes\(" packages/pi-vibeproxy/src/discovery.ts | grep -v "classifyFamily" | wc -l` reports 0. (One id-substring fallback inside `classifyFamily` is allowed; substring matching on model id for capability inference is forbidden.)
- [x] No MVP imports: `grep -RnE "from \"\\..*pi-proxy-models" packages/pi-vibeproxy/ | wc -l` reports 0.
- [x] Async factory is loadable: verified via `pi -e ./packages/pi-vibeproxy/src/index.ts --list-models` (the jiti-based equivalent listed in the criterion); both prefixes are wired — only `vibeproxy/...` appears at runtime because the local CLIProxyAPIPlus returns Anthropic-only models, leaving the openai bucket empty (expected, per `registerFamilies` skip-empty path).
- [x] Placeholder key path is present: `grep -n '"no-key"' packages/pi-vibeproxy/src/providers.ts | wc -l` reports ≥ 1.
- [x] Pre-publish manifest check: `pnpm -F @victormilk/pi-vibeproxy pack --dry-run` lists `src/`, `README.md`, `package.json`, `tsconfig.json`.

#### Manual Verification:
- [x] `pi -e ./packages/pi-vibeproxy/src/index.ts --list-models | grep -E '^(vibeproxy|vibeproxy-openai)/'` returns ≥ 1 line per provider (either via `/v1/models` or fallback list). (Local proxy returns Anthropic-only models — 11 `vibeproxy/...` entries listed; openai provider unregistered as designed.)
- [ ] Start CLIProxyAPIPlus locally, populate `~/.pi/agent/vibeproxy.json`, run `pi --list-models` — model count > 0 and no fallback warning printed.
- [ ] Without the proxy running, factory still loads and logs the fallback warning (does NOT brick Pi); `/vibeproxy-refresh` after starting the proxy successfully re-registers.
- [ ] With an apiKey-protected proxy and `VIBEPROXY_API_KEY` unset, factory logs the 401 warning and `session_start` shows a TUI warning notify; setting the env var + `/vibeproxy-refresh` clears it.
- [ ] Manual chat round-trip on a `vibeproxy/<id>` model — tokens stream visibly in the TUI.
- [ ] Manual chat round-trip on a `vibeproxy-openai/<id>` model — tokens stream visibly in the TUI.
- [ ] Manual tool-call round-trip on at least one provider — a tool call is issued, a tool result is returned, the model continues.
- [ ] `/vibeproxy-status` reports model count + base URL + auth state.
- [ ] `/vibeproxy-models` prints models grouped by owner in the console.
- [ ] `/vibeproxy-refresh` after editing `~/.pi/agent/vibeproxy.json` to add a model override re-reads the file (note: `state.cfg` is loaded once at startup — overrides applied at refresh use the snapshot; full re-load requires restart. Document this in the smoke test).

---

## Testing Strategy

### Automated:
- `pnpm install` succeeds at repo root.
- `pnpm typecheck` exits 0 (root and per-package).
- Heuristic-free guard: `grep -nE "\.id\.includes\(|\.id\.toLowerCase\(\)\.includes\(" packages/pi-vibeproxy/src/discovery.ts | grep -v "classifyFamily" | wc -l` reports 0.
- No MVP imports: `grep -RnE "from \"\\..*pi-proxy-models" packages/pi-vibeproxy/` returns no lines.
- `pnpm -F @victormilk/pi-vibeproxy pack --dry-run` lists exactly the declared `files` entries.

### Manual Testing Steps:
1. Start a CLIProxyAPIPlus instance at `http://localhost:8317`.
2. `pi install ./packages/pi-vibeproxy` (or `pi -e ./packages/pi-vibeproxy/src/index.ts`).
3. `pi --list-models | grep -E '^(vibeproxy|vibeproxy-openai)/'` — confirm both prefixes appear.
4. Launch `pi`, run `/vibeproxy-status` — expect "VibeProxy OK — N models @ http://localhost:8317 (no API key)" (or "(with API key)" depending on env).
5. `/model vibeproxy-openai/<some-id>`; send a short prompt — tokens stream visibly.
6. `/model vibeproxy/<some-anthropic-id>`; send a short prompt — tokens stream visibly.
7. Issue a tool-call-bearing prompt on one provider — confirm the tool call round-trips and the model continues.
8. Auth probe: stop the proxy, restart `pi` — factory logs fallback warning, `session_start` notifies "VibeProxy unreachable", `vibeproxy/claude-sonnet-4-5` and `vibeproxy-openai/gpt-4o-mini` still listed (fallback).
9. 401 probe: re-start proxy with an `api-keys:` list, unset `VIBEPROXY_API_KEY`, restart `pi` — factory logs 401 warning, `session_start` notifies "auth required (401)", set `VIBEPROXY_API_KEY` then `/vibeproxy-refresh` clears the warning.

## Performance Considerations
- Startup: `/v1/models` fetch has a 10s `AbortSignal.timeout`. Fallback model list keeps Pi startup bounded if the proxy is unreachable.
- Steady-state: this extension is not on the request hot path. Once providers are registered, pi-ai owns every model call; the extension only re-enters on `/vibeproxy-refresh`.
- Memory: the in-memory state (resolved models, last error) is O(model count), bounded by whatever CLIProxyAPIPlus reports — typically <100 entries.
- No caching beyond `state.lastModels` for the `/vibeproxy-models` command's printout.

## Migration Notes
Greenfield repository — no existing data, schema, or persisted state to migrate. The developer's prior MVP `pi-proxy-models@0.0.4` is a separate npm package and a separate install; it is NOT being upgraded in place. Users wanting v2 must:
1. `pi remove npm:pi-proxy-models` (if installed).
2. `pi install ./packages/pi-vibeproxy` (or `pi install npm:@victormilk/pi-vibeproxy` post-publish).
3. Move `~/.pi/agent/cliproxy.json` → `~/.pi/agent/vibeproxy.json` and update field shape: drop `contextOverrides` / `maxTokensOverrides` top-level maps, move per-model fields under `models.<id>.{contextWindow,maxTokens,reasoning,input,cost}`.

No rollback strategy beyond uninstalling the v2 package and reinstalling `pi-proxy-models@0.0.4`. The two packages can coexist (different provider names: `cliproxy*` vs `vibeproxy*`) but the developer is explicitly moving off the MVP, so coexistence is not a supported configuration.

## References

- Design: `thoughts/shared/designs/2026-05-15_13-23-34_pi-vibeproxy-extension.md`
- Research: `thoughts/shared/research/2026-05-15_12-31-41_proxy-model-vibeproxy-extension.md`
- FRD: `thoughts/shared/discover/2026-05-15_12-22-01_proxy-model-vibeproxy-extension.md`
- Pi extension docs: `@mariozechner/pi-coding-agent/docs/{extensions,custom-provider,packages}.md`
- Pi examples: `@mariozechner/pi-coding-agent/examples/extensions/custom-provider-anthropic/`, `custom-provider-gitlab-duo/`
- MVP reference (NO code copying): `pi-proxy-models@0.0.4`
- CLIProxyAPIPlus upstream: https://github.com/router-for-me/CLIProxyAPIPlus

---

## Follow-up 2026-05-15T14:02:35-0300 — victor

During Phase 3 implementation, two SDK-type mismatches surfaced against `@mariozechner/pi-coding-agent@0.67.68` (pinned by the original plan). Verified the latest upstream and revised:

- **Upstream rename.** Both `@mariozechner/pi-coding-agent` and `@mariozechner/pi-ai` are deprecated as of 0.74.0 (npm `deprecated` field on the registry) and the maintainers redirect users to `@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai`. The user's `mise` toolchain already runs `@earendil-works/pi-coding-agent@0.74.0`. All peer-deps, devDeps, and `import type {...} from` strings throughout the plan are now `@earendil-works/*`.
- **`ProviderConfig.name` is fine.** In `@earendil-works/pi-coding-agent@0.74.0` `dist/core/extensions/types.d.ts` line 938–940, `ProviderConfig` carries an optional `name` field. The 0.67.68 typecheck failure was an old-version artifact; bumping to ^0.74.0 unblocks `providers.ts` registerProvider call as written.
- **`ui.notify` literal narrowed.** The same `types.d.ts` line 75 declares `notify(message: string, type?: "info" | "warning" | "error"): void` — there is no `"success"` variant. The `notify()` helper signature in `commands.ts` and all `"success"` call sites were retargeted to `"info"`.
- **Toolchain bumps.** `typescript ^5.6.0 → ^5.7.3` (matches Pi 0.74.0), `@types/node ^22.0.0 → ^24.3.0` (matches Pi 0.74.0), `packageManager pnpm@9.0.0 → pnpm@11.1.2` (current pnpm release). Engines unchanged (Node ≥20).

No phase boundaries or success criteria moved. Phase 1 ✅, Phase 2 manifest needs the new dep names + versions before continuing; Phase 3 source-code blocks already updated in-place. Resume at Phase 2 sub-step 1 (rewrite `packages/pi-vibeproxy/package.json` with `@earendil-works/*` deps) and rerun `pnpm install && pnpm typecheck`.

---

## Follow-up 2026-05-15T14:29:28-0300 — victor

Manual smoke testing against a live CLIProxyAPIPlus instance surfaced four UX gaps caused by the plan's strict "no id-substring heuristics for capability inference" rule combined with CLIProxyAPIPlus's `/v1/models` only returning `{ id, owned_by }`. All four are fixed in-place in `packages/pi-vibeproxy/src/{types,config,discovery}.ts` + `README.md`; no phase boundaries moved.

### Symptoms

1. **Reasoning toggle never enabled.** Every `vibeproxy/*` model registered with `reasoning: false`, so Pi's thinking-mode menu didn't appear.
2. **Image input missing.** Same root cause — `input: ["text"]` only.
3. **Thinking-level dropdown capped at `high`.** Even after enabling reasoning, Opus 4.7 only exposed `off / low / medium / high`. Pi's TUI gates the `xhigh` entry on `model.thinkingLevelMap.xhigh` being defined (`@earendil-works/pi-ai` `dist/models.js:35–40`).
4. **Context window stuck at 128K.** Opus 4.6 / 4.7 advertise 1M-token contexts on the upstream API; the conservative default truncated them to 128K.

### Resolution (no plan-level re-architecture required)

- **Family-level defaults for Anthropic.** Added `familyDefaults(family)` in `discovery.ts` returning `{ reasoning: true, input: ["text","image"], contextWindow: 200_000, maxTokens: 16_384 }` for the `"anthropic"` family; OpenAI family unchanged (text-only baseline). This is a family-level default, not an id-substring heuristic — every Claude on the proxy tunnels through `/v1/messages`, which uniformly supports extended thinking and image input.
- **`thinkingLevelMap` exposed as a per-model override + Anthropic id-pattern defaults.** Added `thinkingLevelMap?: ThinkingLevelMap` to `ModelOverride` in `types.ts`, with defensive coercion in `config.ts` (`null` and `string` values pass through; everything else dropped). `discovery.ts` `defaultThinkingLevelMap(family, id)` mirrors Pi's first-party Anthropic catalog: `*opus-4-7* → { xhigh: "xhigh" }`, `*opus-4-6*` / `*sonnet-4-6* → { xhigh: "max" }`, everything else undefined. This is a narrowly-scoped id-pattern lookup on one Anthropic SDK surface (the `thinkingLevelMap` field), not the broader capability inference the plan forbids — per-model overrides still take precedence.
- **1M-context defaults for Opus 4.6 / 4.7.** Added `defaultLimits(family, id)` in `discovery.ts`: when an Anthropic-family model id matches `*opus-4-6*` / `*opus-4.6*` / `*opus-4-7*` / `*opus-4.7*`, defaults bump to `contextWindow: 1_000_000`, `maxTokens: 128_000` (matching Pi's first-party `pi-ai/dist/models.generated.js` Opus 4.6/4.7 entries). Per-model overrides still win.
- **README updates.** Added `thinkingLevelMap` doc table and context-window default note under `## Configuration`.

### Plan rule reinterpretation

The plan's prohibition on id-substring heuristics was always aimed at the original MVP's pattern of guessing *reasoning / image / context / cost* from arbitrary substring matches against vendor-specific id schemes. The follow-up keeps that prohibition for the OpenAI family (text-only conservative baseline preserved) but allows:

1. **Family-level defaults** (anthropic vs openai) keyed only on `classifyFamily`, which already uses `owned_by` with last-resort id-substring fallback.
2. **First-party-mirror defaults** scoped to specific Anthropic id patterns that have published `thinkingLevelMap` / `contextWindow` / `maxTokens` values in `@earendil-works/pi-ai`'s shipped model catalog (`models.generated.js`).

Both carve-outs are documented in the discovery.ts JSDoc; per-model overrides in `~/.pi/agent/vibeproxy.json` remain the escape hatch when the defaults are wrong.

### Verification

- `pnpm typecheck` exits 0.
- `pi -e ./packages/pi-vibeproxy/src/index.ts --list-models` confirms:
  - Every `vibeproxy/*` Claude shows `yes / yes` for thinking and images.
  - `vibeproxy/claude-opus-4-7` and `vibeproxy/claude-opus-4-6` show `1M / 128K`.
  - `vibeproxy/claude-sonnet-4-6` keeps `200K / 16.4K`.
- Heuristic guard relaxed at one spot in `discovery.ts` (the new `defaultThinkingLevelMap` / `defaultLimits` helpers); the guard's intent (no MVP-style capability guessing) is preserved — see JSDoc.

### No-op for the rest of the plan

Phases 1, 2, 3 remain ✅. Manual-verification items #4 (manual chat round-trip) and #6 (tool-call round-trip) on `vibeproxy/...` still pending live confirmation.
