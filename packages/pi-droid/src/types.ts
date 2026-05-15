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
