---
date: 2026-05-15T13:23:34-0300
author: victor
commit: no-commit
branch: no-branch
repository: pilks-mono
topic: "@victormilk/pi-vibeproxy — Pi Coding Agent extension for CLIProxyAPIPlus (VibeProxy) v2 rewrite"
tags: [design, pi-coding-agent, pi-package, custom-provider, vibeproxy, cliproxyapiplus, monorepo, rewrite]
status: complete
parent: thoughts/shared/research/2026-05-15_12-31-41_proxy-model-vibeproxy-extension.md
last_updated: 2026-05-15T13:23:34-0300
last_updated_by: victor
---

# Design: @victormilk/pi-vibeproxy — Pi Coding Agent extension for CLIProxyAPIPlus

## Summary
First extension shipped from the `pilks-mono` pnpm monorepo: `@victormilk/pi-vibeproxy`, a Pi Coding Agent extension that registers two model providers (`vibeproxy` for `anthropic-messages`, `vibeproxy-openai` for `openai-completions`) backed by a single CLIProxyAPIPlus instance with different path suffixes. Configuration lives in `~/.pi/agent/vibeproxy.json` with env-var overrides; capabilities come from per-model config overrides merged onto conservative defaults (no id-substring heuristics). This is a deliberate full rewrite-from-zero of the developer's prior MVP `pi-proxy-models@0.0.4` — that MVP is reference-only behavior documentation, no code is to be copied.

## Requirements
From the FRD (`thoughts/shared/discover/2026-05-15_12-22-01_proxy-model-vibeproxy-extension.md`) and research artifact:
- pnpm + TypeScript monorepo with the extension under `packages/pi-vibeproxy/`.
- Register as a Pi model provider via `pi.registerProvider` against `@mariozechner/pi-coding-agent`'s documented extension API.
- Issue requests via built-in `api: "anthropic-messages"` and `api: "openai-completions"` (pi-ai owns SSE + tool calls — no `streamSimple`).
- Streaming + tool-call forwarding (inherited automatically from pi-ai's built-in adapters).
- Config from `~/.pi/agent/vibeproxy.json` with `VIBEPROXY_URL` / `VIBEPROXY_API_KEY` overrides.
- Acceptance: manual smoke test against a live CLIProxyAPIPlus instance.
- Total rewrite from zero — no code from `pi-proxy-models` is to be copied or ported.

## Current State Analysis
`pilks-mono` is greenfield: only `.pi/agents/*.md` (skill agent definitions) and empty `thoughts/shared/*/` directories exist. No `package.json`, no workspace config, no source code, no git history (`commit: no-commit`).

### Key Discoveries
- Pi extension entry shape: `export default function (pi: ExtensionAPI) { … }`, may be async, factory awaited before `--list-models` (`@mariozechner/pi-coding-agent/docs/custom-provider.md:69`).
- One `pi.registerProvider(name, ProviderConfig)` per (baseUrl, api) tuple — multiple protocols require multiple registrations (`@mariozechner/pi-coding-agent/docs/custom-provider.md:33-69`).
- Built-in `api` strings route to pi-ai's streaming implementations — `"anthropic-messages"` and `"openai-completions"` both handle SSE + tool calls + thinking deltas natively (`@mariozechner/pi-coding-agent/docs/custom-provider.md:213-230`).
- When `models` is supplied, the registration **replaces** all existing models for that name; `pi.unregisterProvider(name)` restores built-in behavior (`@mariozechner/pi-coding-agent/docs/custom-provider.md:151-185`).
- Pi-package manifest: `"pi": { "extensions": [...] }`, `"keywords": ["pi-package"]`, peer-deps on `@mariozechner/pi-coding-agent` + `@mariozechner/pi-ai` with `"*"` (no bundling) (`@mariozechner/pi-coding-agent/docs/packages.md:101-160`).
- Jiti loads `.ts` directly — no build step, `tsconfig.json` is `noEmit: true` with `allowImportingTsExtensions: true`. Reference: `pi-proxy-models/tsconfig.json:1-15` (shape only, not for copy).
- CLIProxyAPIPlus surface: `GET /v1/models` → `{ data: [{ id, owned_by }] }`; `POST /v1/messages` (Anthropic, baseUrl suffix `""`); `POST /v1/chat/completions` (OpenAI, baseUrl suffix `/v1`); optional `Authorization: Bearer <key>`.
- Pi quirk: `ProviderConfig.apiKey` non-empty required when `models` is supplied — must send placeholder when CLIProxyAPIPlus is unauthenticated.

## Scope

### Building
- Root pnpm workspace scaffold (`pnpm-workspace.yaml`, root `package.json`, shared `tsconfig.base.json`, `.gitignore`, root `README.md`).
- `packages/pi-vibeproxy/` extension package:
  - `package.json` with pi-package manifest + peer deps.
  - `tsconfig.json` (extends root, `noEmit: true`).
  - `src/types.ts` — config schema + family spec types.
  - `src/config.ts` — `~/.pi/agent/vibeproxy.json` loader + env overrides + defaults.
  - `src/discovery.ts` — fetch `/v1/models`, classify family by `owned_by` / `id`, apply config overrides + safe defaults, fallback list.
  - `src/providers.ts` — register/unregister two providers (`vibeproxy`, `vibeproxy-openai`).
  - `src/commands.ts` — `/vibeproxy-status`, `/vibeproxy-models`, `/vibeproxy-refresh`.
  - `src/index.ts` — async extension factory: load config, probe `/v1/models`, warn on 401, register, hook session_start.
  - `README.md` — install, config schema, smoke-test steps.

### Not Building
- `packages/core/` shared package — deferred until a second extension consumer exists (FRD FR-9 dropped per research checkpoint).
- Build pipeline (`tsup`, bundling, dist output) — Pi loads `.ts` directly via jiti; only `pnpm typecheck` (=`tsc --noEmit`) is wired.
- Gemini family / `vibeproxy-gemini` provider — out of FRD scope.
- Automated unit/integration tests — FRD acceptance is manual smoke test only.
- npm publish workflow / CI — deferred (publish-target package name `@victormilk/pi-vibeproxy` is decided, but `npm publish` automation is out of scope).
- `streamSimple` custom streaming — pi-ai's built-in `anthropic-messages` and `openai-completions` cover everything CLIProxyAPIPlus needs.
- OAuth login flow — CLIProxyAPIPlus uses simple Bearer tokens; no `pi.oauth` integration.
- Id-substring capability heuristics — explicitly NOT carried over from MVP (`pi-proxy-models/index.ts:191-237`).
- Per-model `contextOverrides` / `maxTokensOverrides` as separate maps — collapsed into the unified per-model config override block.
- LICENSE file — root only when published (deferred).

## Decisions

### Two providers, partition by upstream API
**Ambiguity**: Pi's `ProviderConfig` is per-(baseUrl, api) tuple, but CLIProxyAPIPlus exposes both Anthropic and OpenAI surfaces.
**Explored**:
- Option A: Two `registerProvider` calls — `vibeproxy` (`anthropic-messages`, baseUrl ``) + `vibeproxy-openai` (`openai-completions`, baseUrl `/v1`). Inherited from research checkpoint.
- Option B: One provider with custom `streamSimple` dispatch. Would re-implement what pi-ai already provides (reference: `examples/extensions/custom-provider-gitlab-duo/index.ts:225-280`).
**Decision**: Option A. Zero `streamSimple` code; pi-ai's built-in adapters handle SSE + tool calls (`@mariozechner/pi-coding-agent/docs/custom-provider.md:213-230`).

### Gemini family deferred
**Decision**: OpenAI + Anthropic providers only for v2 scope. FRD literal (`thoughts/shared/discover/2026-05-15_12-22-01_proxy-model-vibeproxy-extension.md:5`); Gemini is a follow-up. Family-spec table is shaped so a third entry can be added in one line later.

### Config-driven capabilities + safe defaults (no heuristics)
**Ambiguity**: CLIProxyAPIPlus's `/v1/models` returns only `{id, owned_by}`, but Pi's `ProviderModelConfig` needs `reasoning`, `input`, `contextWindow`, `maxTokens`, `cost`.
**Explored**:
- Option A: Per-model config overrides in `vibeproxy.json` merged onto conservative defaults (`reasoning: false`, `input: ["text"]`, `contextWindow: 128000`, `maxTokens: 8192`, `cost: 0`). Zero substring heuristics.
- Option B: Isolated heuristic module + config overrides (cleaner MVP, still id-substring based).
- Option C: Config-only — every model declared manually.
**Decision**: Option A. Explicitly rejects the MVP's id-substring fragility (`pi-proxy-models/index.ts:191-237`). User declares per-model overrides to unlock reasoning/images; defaults are safe but conservative.

### Modular file split inside the package
**Decision**: `src/` split across `types`, `config`, `discovery`, `providers`, `commands`, `index`. Optimizes testability and clear seams for future monorepo extensions. Trade-off: more files for ~300 lines of logic; accepted.

### Package name `@victormilk/pi-vibeproxy`, directory `packages/pi-vibeproxy/`
**Decision**: scoped under the developer's npm namespace, distinct from `pi-proxy-models@0.0.4` MVP. Workspace dir matches npm name. Overrides FRD's literal `packages/proxy-model/`.

### Env-var overrides for URL + API key
**Decision**: `VIBEPROXY_URL` and `VIBEPROXY_API_KEY` (when set) override file values. Layered: env → file → defaults. Matches 12-factor + MVP behavior model (not code).

### Startup auth probe with warn-but-continue
**Decision**: Async factory probes `GET /v1/models` with current auth at startup. On 401: `console.warn` + queue an `ctx.ui.notify` for `session_start`; still register providers using the fallback model list so Pi doesn't brick. Distinct from MVP, which silently sent placeholder and let the first model call 401.

### Placeholder `"no-key"` apiKey when unauthenticated
**Decision**: Pi's `ProviderConfig` validation requires non-empty `apiKey` when `models` is set. When the user's effective apiKey is empty, send the literal string `"no-key"` to satisfy validation; CLIProxyAPIPlus ignores it when its own `api-keys:` list is empty. This is a load-bearing Pi quirk acknowledged in research.

### `.ts` loaded directly via jiti — no build step
**Decision**: `pi.extensions` points at `./src/index.ts`. Package ships `.ts` source; pi loads it via jiti at runtime. Only `pnpm typecheck` (= `tsc --noEmit`) is wired into CI; no `dist/` output, no `tsup`. `package.json` declares `"type": "module"`.

### TypeScript-only schema validation (no zod/typebox)
**Decision**: Hand-written interfaces in `types.ts`; defensive type-narrowing in `config.ts` at parse time. Pi's docs use `typebox` only for tool parameters; config files don't need a validator. Keeps peer-deps minimal.

## Architecture

### pnpm-workspace.yaml — NEW
Root workspace manifest.

```yaml
packages:
  - "packages/*"
```

### package.json — NEW
Root workspace package — devDeps only, scripts proxy to workspaces.

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
    "typescript": "^5.6.0"
  },
  "packageManager": "pnpm@9.0.0",
  "engines": {
    "node": ">=20"
  }
}
```

### tsconfig.base.json — NEW
Shared TS config; packages extend this.

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

### .gitignore — NEW
Standard Node + TS ignores; vibeproxy config is outside repo (`~/.pi/agent/vibeproxy.json`).

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

### README.md — NEW
Root README — what the monorepo is, list of packages, dev workflow.

```markdown
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
```

### packages/pi-vibeproxy/package.json — NEW
Pi-package manifest. `pi.extensions` points at the TS entry point. Peer deps (per `@mariozechner/pi-coding-agent/docs/packages.md:148-150`) are not bundled.

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
    "@mariozechner/pi-ai": "*",
    "@mariozechner/pi-coding-agent": "*"
  },
  "devDependencies": {
    "@mariozechner/pi-ai": "*",
    "@mariozechner/pi-coding-agent": "^0.67.68",
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0"
  }
}
```

### packages/pi-vibeproxy/tsconfig.json — NEW
Extends root base; package-scoped include + types pointer at the pi-coding-agent's bundled `@types/node` so import resolution stays consistent with the MVP's working setup.

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

### packages/pi-vibeproxy/src/types.ts — NEW
Hand-written config + spec types; the contract every other module consumes.

```typescript
/**
 * Shared types for @victormilk/pi-vibeproxy.
 *
 * No runtime validator (typebox/zod) on purpose: Pi extensions are loaded into
 * a trusted local process, and the config file lives in the user's home dir.
 * Defensive narrowing happens at parse time in `config.ts`.
 */

import type { ProviderModelConfig } from "@mariozechner/pi-coding-agent";

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

### packages/pi-vibeproxy/src/config.ts — NEW
Loads `~/.pi/agent/vibeproxy.json`, layers env-var overrides, validates field types defensively.

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

### packages/pi-vibeproxy/src/discovery.ts — NEW
Fetches `/v1/models`, classifies family, applies overrides + defaults, fallback list.

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

### packages/pi-vibeproxy/src/providers.ts — NEW
Family-spec table, `registerFamilies`, stale-registration cleanup, no-key placeholder.

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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

### packages/pi-vibeproxy/src/commands.ts — NEW
`/vibeproxy-status`, `/vibeproxy-models`, `/vibeproxy-refresh`. Refresh re-fetches `/v1/models` and re-registers.

```typescript
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
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
				"success",
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
				"success",
			);
		},
	});
}

function notify(
	ctx: ExtensionContext | ExtensionCommandContext,
	msg: string,
	kind: "info" | "success" | "error" | "warning",
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

### packages/pi-vibeproxy/src/index.ts — NEW
Async extension factory: load config → probe `/v1/models` → register providers → wire commands → hook `session_start` notify.

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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

### packages/pi-vibeproxy/README.md — NEW
Install, config schema, smoke-test instructions (the manual acceptance bar from the FRD).

```markdown
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
```

## Desired End State

After installation and config setup, the developer launches Pi and sees VibeProxy as two selectable providers:

```bash
$ pi --list-models | grep vibeproxy
vibeproxy/claude-sonnet-4-5
vibeproxy/claude-opus-4-5
vibeproxy-openai/gpt-4o
vibeproxy-openai/gpt-4o-mini
# ...

$ pi
> /model vibeproxy-openai/gpt-4o
> Write a haiku about TypeScript.
[VibeProxy: 7 models available (3 Anthropic, 4 OpenAI).]
Strongly-typed lines bloom
[tokens stream visibly]
...

> /vibeproxy-status
[VibeProxy OK — 7 models @ http://localhost:8317 (with API key).]

> /vibeproxy-refresh
[VibeProxy: refreshed 8 models (3 Anthropic, 5 OpenAI).]
```

Tool calls round-trip via pi-ai's built-in adapters; the extension code is never on the request hot path.

## File Map

```
pnpm-workspace.yaml                            # NEW — pnpm workspaces declaration
package.json                                   # NEW — root workspace package (devDeps, scripts)
tsconfig.base.json                             # NEW — shared TS compiler options
.gitignore                                     # NEW — Node + TS ignores
README.md                                      # NEW — monorepo overview
packages/pi-vibeproxy/package.json             # NEW — pi-package manifest, peer-deps
packages/pi-vibeproxy/tsconfig.json            # NEW — extends root base
packages/pi-vibeproxy/src/types.ts             # NEW — config schema + family spec types
packages/pi-vibeproxy/src/config.ts            # NEW — load ~/.pi/agent/vibeproxy.json + env layering
packages/pi-vibeproxy/src/discovery.ts         # NEW — fetch /v1/models, classify, defaults, fallback
packages/pi-vibeproxy/src/providers.ts         # NEW — FAMILIES table, register/unregister, no-key placeholder
packages/pi-vibeproxy/src/commands.ts          # NEW — /vibeproxy-status / /models / /refresh
packages/pi-vibeproxy/src/index.ts             # NEW — async factory entry point
packages/pi-vibeproxy/README.md                # NEW — install, config, smoke test
```

## Ordering Constraints
- Slice 1 (root scaffold) must exist before any package is installable — `pnpm install` requires `pnpm-workspace.yaml` and root `package.json`.
- Slice 2 (package skeleton + `types.ts`) must precede Slices 3-7 — every later module imports from `./types.ts`.
- Slices 3-6 (config, discovery, providers, commands) each depend on the previous strictly: `discovery` reads `ResolvedConfig` from `config`; `providers` consumes `ResolvedModel` from `discovery`; `commands` calls both `discovery` and `providers`.
- Slice 7 (entry point) depends on all of Slices 2-6; it wires everything together.
- No parallel slices — strictly sequential.

## Verification Notes

Carry-forward checks from research + FRD acceptance, framed as commands the user can run after `implement`:

- `[ ] pnpm install` at the repo root succeeds with `packages/pi-vibeproxy/` resolved as a workspace member.
- `[ ] pnpm typecheck` (root) returns 0; equivalent to `pnpm --filter @victormilk/pi-vibeproxy typecheck`. No `dist/` artifact is produced — `noEmit: true` is intentional.
- `[ ] grep -nE "if \\(.*\\.includes\\(" packages/pi-vibeproxy/src/discovery.ts | wc -l` — should report exactly 0 substring-heuristic occurrences (none of the MVP's id-substring inference may leak into v2). One `owned_by` `.includes()` is allowed for owner-string normalization in `classifyFamily`; substring matching on model id capability is forbidden.
- `[ ] grep -RnE "from \\\"\\..*pi-proxy-models" packages/pi-vibeproxy/ | wc -l` — should be 0 (no accidental imports from the MVP package).
- `[ ] node -e "import('./packages/pi-vibeproxy/src/index.ts')"` via jiti must not throw; verifies the factory is loadable.
- `[ ] pi -e ./packages/pi-vibeproxy/src/index.ts --list-models | grep -E '^(vibeproxy|vibeproxy-openai)/'` — confirms both providers register and at least one model is exposed per family (either from `/v1/models` or the fallback list).
- `[ ] Start CLIProxyAPIPlus locally, set ~/.pi/agent/vibeproxy.json, run pi --list-models — model count > 0 from /v1/models, no fallback warning.
- `[ ] Manual chat round-trip: pick a vibeproxy/ model and a vibeproxy-openai/ model, send a prompt to each, observe tokens stream visibly.
- `[ ] Manual tool-call round-trip on at least one provider — a tool call is issued, a tool result is returned, the model continues.
- `[ ] Pre-publish: package.json declares "@mariozechner/pi-coding-agent" and "@mariozechner/pi-ai" as peer-deps only (not dependencies); pnpm pack --dry-run lists src/, README.md, package.json, tsconfig.json.

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

## Pattern References
- `@mariozechner/pi-coding-agent/examples/extensions/custom-provider-anthropic/index.ts:1-450` — reference layout for a single-provider Pi extension with custom streamSimple. We use this for the **provider-registration shape only**; we do NOT use its streamSimple — built-in `anthropic-messages` covers our case.
- `@mariozechner/pi-coding-agent/examples/extensions/custom-provider-gitlab-duo/index.ts:1-330` — reference for a multi-backend provider (Anthropic + OpenAI Responses) using built-in pi-ai stream helpers. Confirms the "two surfaces, one extension" shape works.
- `@mariozechner/pi-coding-agent/docs/custom-provider.md:33-230` — `ProviderConfig` schema, async-factory contract, built-in `api` types, `compat` flags. Authoritative for our `pi.registerProvider` calls.
- `@mariozechner/pi-coding-agent/docs/extensions.md:60-110` — `pi.registerCommand`, `pi.on("session_start", ...)` lifecycle. Authoritative for our command + notify wiring.
- `@mariozechner/pi-coding-agent/docs/packages.md:101-160` — pi-package manifest, peer-deps convention, install sources.
- `pi-proxy-models/index.ts:50-345` — REFERENCE-ONLY behavior map (per research). No code copied; only the **what to do** (partition by family, async-factory discovery, fallback list, `no-key` placeholder, `/<prefix>-status|models|refresh` command UX). v2 implementation is fresh.

## Developer Context

### Inherited from research (Q/A — do not re-ask)
**Q (discover: Primary user and motivation): What problem does this Proxy Model extension solve?**
A: "Me as the Pi Coding Agent user" — route Pi's model calls through VibeProxy (CLIProxyAPIPlus).

**Q (discover: Integration shape):** A model provider adapter — `pi.registerProvider`-based.

**Q (discover: VibeProxy wire protocol):** Both OpenAI `/v1/chat/completions` and Anthropic `/v1/messages`.

**Q (discover: Streaming + Tools):** Required — resolved by built-in `api` strings; no `streamSimple` needed.

**Q (research: Provider shape):** Two providers, partition by surface (`vibeproxy` + `vibeproxy-openai`). `docs/custom-provider.md:33-69`.

**Q (research: Config location):** `~/.pi/agent/vibeproxy.json`. Survives `pi update`; matches MVP precedent location.

**Q (research: Build step):** No build step; jiti loads `.ts`. `pnpm typecheck` only.

**Q (research: Is VibeProxy a separate product?):** No — VibeProxy = CLIProxyAPIPlus.

**Q (research follow-up: Should v2 port MVP code?):** **No — total rewrite from zero.** MVP is reference-only.

### Resolved during this design checkpoint
**Q (`thoughts/shared/discover/2026-05-15_12-22-01_proxy-model-vibeproxy-extension.md:5` vs `pi-proxy-models/index.ts:68-74`): Gemini support — in or out of v2 scope?**
A: Out. OpenAI + Anthropic only. Family-spec table shaped so a Gemini entry is one-line extensible later.

**Q (`pi-proxy-models/index.ts:191-237`): How does v2 source per-model capabilities given `/v1/models` returns only `{id, owned_by}`?**
A: Per-model config overrides in `vibeproxy.json` merged onto conservative safe defaults (`reasoning: false`, `input: ["text"]`, `contextWindow: 128000`, `maxTokens: 8192`, zero cost). No id-substring heuristics — explicitly rejects the MVP's fragility surface.

**Q (`pi-proxy-models/index.ts:1-345`): Code organization — single-file or modular split inside `packages/pi-vibeproxy/`?**
A: Modular split — `src/{types,config,discovery,providers,commands,index}.ts`. Optimizes testability and seams for future extensions in this monorepo.

**Q (npm: `pi-proxy-models` v0.0.4 by Victor Leite Costa): Package name for `packages/pi-vibeproxy/package.json`?**
A: `@victormilk/pi-vibeproxy`. Scoped under developer's namespace; distinct from MVP. Workspace dir `packages/pi-vibeproxy/` matches the npm name. Overrides FRD's literal `packages/proxy-model/`.

**Q (FRD `discover/...md:3` vs MVP `pi-proxy-models/index.ts:96-100`): Env-var fallback policy?**
A: Env vars override file values. Layering: `defaults < ~/.pi/agent/vibeproxy.json < env (VIBEPROXY_URL, VIBEPROXY_API_KEY)`.

**Q (self-critique: MVP at `pi-proxy-models/index.ts:82-84` silently sends placeholder; what if proxy requires auth?): Auth-missing behavior?**
A: Warn via startup probe. Async factory issues `GET /v1/models`; on `401` log `console.warn` + queue `ctx.ui.notify` for `session_start`. Providers still register using the fallback list so Pi doesn't brick; the user sees the warning and runs `/vibeproxy-refresh` after fixing auth.

## Design History
- Slice 1: Monorepo scaffold — approved as generated
- Slice 2: Package skeleton + types contract — approved; revised: expanded package.json keywords from 7 to 27 for npm discoverability (added pi-provider/model-provider/custom-provider, cliproxy/cliproxyapi aliases, llm-gateway, model-router, claude/gpt, streaming, tool-calling, function-calling, local-llm, self-hosted)
- Slice 3: Config loader — approved as generated
- Slice 4: Model discovery + classification — approved as generated
- Slice 5: Provider registration — approved as generated
- Slice 6: Commands — approved as generated
- Slice 7: Entry point + startup probe — approved as generated

## References
- FRD: `thoughts/shared/discover/2026-05-15_12-22-01_proxy-model-vibeproxy-extension.md`
- Research: `thoughts/shared/research/2026-05-15_12-31-41_proxy-model-vibeproxy-extension.md`
- Pi extension docs: `@mariozechner/pi-coding-agent/docs/{extensions,custom-provider,packages}.md` (installed under `/Users/victor/.local/share/mise/installs/node/24.15.0/lib/node_modules/@juicesharp/rpiv-pi/node_modules/@mariozechner/pi-coding-agent/`).
- Pi extension examples: `@mariozechner/pi-coding-agent/examples/extensions/custom-provider-anthropic/`, `custom-provider-gitlab-duo/`.
- MVP reference (NO code copying): `pi-proxy-models@0.0.4` (`/Users/victor/.local/share/mise/installs/node/24.15.0/lib/node_modules/pi-proxy-models/`).
- CLIProxyAPIPlus upstream: https://github.com/router-for-me/CLIProxyAPIPlus
