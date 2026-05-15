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
