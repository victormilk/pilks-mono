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
