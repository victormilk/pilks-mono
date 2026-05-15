import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { groupByFamily, resolveAll } from "./discovery.ts";
import { clearLastError, closeSession, getSessionSnapshot, registerProvider } from "./providers.ts";
import type { ResolvedConfig, ResolvedModel } from "./types.ts";

/**
 * Mutable runtime state shared with the entry point. Held in a single object
 * so commands can mutate it (e.g. refresh updates `lastModels`) without
 * reaching back into module-level let-bindings.
 *
 * `lastError` is NOT stored here — it lives in `providers.ts` so the streaming
 * code path (which has no access to this object) can write to it. `/droid-status`
 * reads it via `getSessionSnapshot().lastError`.
 */
export interface RuntimeState {
	/** Mutated by `/droid-refresh` so config edits apply without a full reload. */
	cfg: ResolvedConfig;
	lastModels: ReadonlyArray<ResolvedModel>;
}

export function registerCommands(pi: ExtensionAPI, state: RuntimeState): void {
	pi.registerCommand("droid-status", {
		description: "Report pi-droid session + config state.",
		handler: async (_args, ctx) => {
			const snap = getSessionSnapshot();
			const sessionLine = snap.sessionId
				? `session ${snap.sessionId.slice(0, 8)} (spawned ${formatAge(snap.lastSpawnAt)})`
				: "no active session";
			const configLine = state.cfg.loadedFrom ?? "defaults (no config file)";
			const errorLine = snap.lastError ?? "ok";
			const lines = [
				`droid: ${sessionLine}`,
				`  autonomy=${state.cfg.autoLevel} | binary=${state.cfg.droidBinary}`,
				`  models=${state.lastModels.length} | last error: ${errorLine}`,
				`  config: ${configLine}`,
			];
			if (ctx.hasUI) {
				ctx.ui.notify(lines[0] ?? "droid", "info");
			}
			for (const line of lines) console.log(`[pi-droid] ${line}`);
		},
	});

	pi.registerCommand("droid-models", {
		description: "List curated Droid models grouped by family.",
		handler: async (_args, ctx) => {
			const grouped = groupByFamily(state.lastModels);
			if (ctx.hasUI) {
				ctx.ui.notify(`${state.lastModels.length} models — see console for full list.`, "info");
			}
			for (const bucket of grouped) {
				console.log(`[pi-droid] ${bucket.family}:`);
				for (const m of bucket.models) {
					console.log(`[pi-droid]   ${m.piModel.id}  —  ${m.piModel.name}`);
				}
			}
		},
	});

	pi.registerCommand("droid-refresh", {
		description: "Re-read ~/.pi/agent/droid.json and re-register the provider.",
		handler: async (_args, ctx) => {
			// Re-read the config file so edits to ~/.pi/agent/droid.json take effect
			// without restarting Pi. `state.cfg` is mutated so /droid-status reflects
			// the new values on its next invocation.
			state.cfg = loadConfig();
			const resolved = resolveAll(state.cfg);
			const stats = registerProvider(pi, state.cfg, resolved);
			state.lastModels = resolved;
			clearLastError();
			notify(
				ctx,
				`pi-droid: re-registered ${stats.totalModels} models (config: ${state.cfg.loadedFrom ?? "defaults"}).`,
				"info",
			);
		},
	});

	pi.registerCommand("droid-restart", {
		description: "Close the droid subprocess. The next turn will respawn it.",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			await closeSession();
			clearLastError();
			notify(
				ctx,
				"pi-droid: session closed. Next turn will respawn the droid subprocess.",
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
	// `ExtensionCommandContext extends ExtensionContext` (types.d.ts:241), so
	// `hasUI` / `ui.notify` are accessible on both branches without casting.
	if (ctx.hasUI) {
		ctx.ui.notify(msg, kind);
	} else if (kind === "error") {
		console.error(`[pi-droid] ${msg}`);
	} else {
		console.log(`[pi-droid] ${msg}`);
	}
}

function formatAge(timestamp: number | undefined): string {
	if (!timestamp) return "—";
	const seconds = Math.floor((Date.now() - timestamp) / 1000);
	if (seconds < 60) return `${seconds}s ago`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
	return `${Math.floor(seconds / 3600)}h ago`;
}
