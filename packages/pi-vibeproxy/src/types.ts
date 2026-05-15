/**
 * Shared types for @victormilk/pi-vibeproxy.
 *
 * No runtime validator (typebox/zod) on purpose: Pi extensions are loaded into
 * a trusted local process, and the config file lives in the user's home dir.
 * Defensive narrowing happens at parse time in `config.ts`.
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevelMap } from "@earendil-works/pi-ai";

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
	/**
	 * Maps Pi thinking levels ("off" | "minimal" | "low" | "medium" | "high" | "xhigh")
	 * to provider-specific values. `null` marks a level unsupported. To expose the
	 * Anthropic `"max"` effort on adaptive-thinking models, set `{ "xhigh": "max" }`.
	 * `xhigh` only appears in Pi's UI when this map defines a value for it.
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
