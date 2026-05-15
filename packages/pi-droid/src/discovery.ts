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

/** Per-family default `input` capabilities — Anthropic + Google natively support image input. */
const IMAGE_CAPABLE: ReadonlyArray<"text" | "image"> = ["text", "image"];

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
