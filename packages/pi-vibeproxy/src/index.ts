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
