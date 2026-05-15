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
