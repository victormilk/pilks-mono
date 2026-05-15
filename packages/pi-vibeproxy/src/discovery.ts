import type { Family, ResolvedConfig, ResolvedModel, UpstreamModel } from "./types.ts";
import type { ThinkingLevelMap } from "@earendil-works/pi-ai";

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
 * Family-level capability defaults. The Anthropic family on CLIProxyAPIPlus
 * always tunnels through the upstream `/v1/messages` endpoint, which supports
 * extended thinking and image input for every Claude model; OpenAI-family
 * models stay on the conservative text-only baseline because the proxy may
 * front a mix of reasoning- and non-reasoning chat models.
 */
function familyDefaults(family: Family) {
	if (family === "anthropic") {
		return {
			reasoning: true,
			input: ["text", "image"] as ReadonlyArray<"text" | "image">,
			contextWindow: 200_000,
			maxTokens: 16_384,
			cost: DEFAULT_CAPS.cost,
		};
	}
	return DEFAULT_CAPS;
}

/**
 * Default context window / maxTokens overrides for Anthropic adaptive-thinking
 * models, mirroring Pi's first-party catalog (`@earendil-works/pi-ai`
 * `models.generated.js` Opus 4.6 / 4.7 entries: 1M context, 128K max output).
 */
function defaultLimits(family: Family, id: string): { contextWindow?: number; maxTokens?: number } {
	if (family !== "anthropic") return {};
	const lower = id.toLowerCase();
	if (
		lower.includes("opus-4-6") ||
		lower.includes("opus-4.6") ||
		lower.includes("opus-4-7") ||
		lower.includes("opus-4.7")
	) {
		return { contextWindow: 1_000_000, maxTokens: 128_000 };
	}
	return {};
}

/**
 * Default `thinkingLevelMap` for Anthropic adaptive-thinking models. Pi's TUI
 * only exposes the `xhigh` thinking level when the model declares it via this
 * map (see `@earendil-works/pi-ai` `models.js` `getSupportedThinkingLevels`).
 * CLIProxyAPIPlus's `/v1/models` cannot surface this capability, so we mirror
 * the first-party Anthropic catalog: Opus 4.7 uses `xhigh→xhigh`, the older
 * adaptive 4.6 models use `xhigh→max`.
 *
 * This is an id-pattern lookup on Anthropic-family models only, narrowly scoped
 * to one published Anthropic surface (the `thinkingLevelMap` field) — not the
 * broader capability inference the plan forbids.
 */
function defaultThinkingLevelMap(family: Family, id: string): ThinkingLevelMap | undefined {
	if (family !== "anthropic") return undefined;
	const lower = id.toLowerCase();
	if (lower.includes("opus-4-7") || lower.includes("opus-4.7")) {
		return { xhigh: "xhigh" };
	}
	if (
		lower.includes("opus-4-6") ||
		lower.includes("opus-4.6") ||
		lower.includes("sonnet-4-6") ||
		lower.includes("sonnet-4.6")
	) {
		return { xhigh: "max" };
	}
	return undefined;
}

/**
 * Apply per-model config overrides on top of family-level defaults. The result
 * is a `ProviderModelConfig`-shaped object ready for `pi.registerProvider`.
 */
export function resolveModel(upstream: UpstreamModel, cfg: ResolvedConfig): ResolvedModel {
	const override = cfg.modelOverrides[upstream.id] ?? {};
	const family = classifyFamily(upstream);
	const defaults = familyDefaults(family);

	const limits = defaultLimits(family, upstream.id);
	const piModel: ResolvedModel["piModel"] = {
		id: upstream.id,
		name: override.name ?? (upstream.owned_by ? `${upstream.id} (${upstream.owned_by})` : upstream.id),
		reasoning: override.reasoning ?? defaults.reasoning,
		input: (override.input ?? defaults.input).slice() as Array<"text" | "image">,
		cost: override.cost ?? { ...defaults.cost },
		contextWindow: override.contextWindow ?? limits.contextWindow ?? defaults.contextWindow,
		maxTokens: override.maxTokens ?? limits.maxTokens ?? defaults.maxTokens,
	};
	const thinkingLevelMap = override.thinkingLevelMap ?? defaultThinkingLevelMap(family, upstream.id);
	if (thinkingLevelMap) {
		piModel.thinkingLevelMap = thinkingLevelMap;
	}

	return { upstream, family, piModel };
}

export function resolveAll(
	models: ReadonlyArray<UpstreamModel>,
	cfg: ResolvedConfig,
): ReadonlyArray<ResolvedModel> {
	return models.map((m) => resolveModel(m, cfg));
}

export { FALLBACK_MODELS, DEFAULT_CAPS };
