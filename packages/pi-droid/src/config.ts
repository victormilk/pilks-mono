import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AutoLevel, ConfigFile, ModelOverride, ResolvedConfig } from "./types.ts";

const DEFAULT_DROID_BINARY = "droid";
const DEFAULT_AUTO_LEVEL: AutoLevel = "medium";
const DEFAULT_MODEL = "claude-sonnet-4-6";
const CONFIG_PATH = join(homedir(), ".pi", "agent", "droid.json");

/**
 * Load and resolve runtime config.
 *
 * Layering (later wins):
 *   defaults  <  ~/.pi/agent/droid.json  <  env vars (DROID_BINARY, DROID_AUTO_LEVEL)
 *
 * `FACTORY_API_KEY` is NOT read here — it's the value Pi resolves from the
 * `apiKey: "FACTORY_API_KEY"` envvar-name registered in `providers.ts`, and
 * the SDK reads it again from `process.env` when it spawns the subprocess.
 *
 * Returns a fully-resolved config; the file is optional, missing fields are
 * filled with safe defaults, malformed values are warned-about and ignored.
 */
export function loadConfig(): ResolvedConfig {
	const fromFile = readConfigFile(CONFIG_PATH);

	const envBinary = process.env.DROID_BINARY?.trim();
	const envAutoLevel = coerceAutoLevel(process.env.DROID_AUTO_LEVEL?.trim());

	return {
		droidBinary: envBinary || fromFile.parsed.droidBinary?.trim() || DEFAULT_DROID_BINARY,
		autoLevel: envAutoLevel ?? coerceAutoLevel(fromFile.parsed.autoLevel) ?? DEFAULT_AUTO_LEVEL,
		defaultModel: fromFile.parsed.defaultModel?.trim() || DEFAULT_MODEL,
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
		console.warn(`[pi-droid] Failed to read ${path}: ${(err as Error).message}. Using defaults.`);
		return { exists: true, parsed: {} };
	}
}

/**
 * Coerce an unknown JSON value into a `ConfigFile`. Unknown / malformed fields
 * are dropped with a warning; we never throw — the extension must still load.
 */
function coerceConfigFile(value: unknown, path: string): ConfigFile {
	if (!isPlainObject(value)) {
		console.warn(`[pi-droid] ${path} is not a JSON object. Ignoring contents.`);
		return {};
	}
	const out: ConfigFile = {};
	if (typeof value.droidBinary === "string") out.droidBinary = value.droidBinary;
	const auto = coerceAutoLevel(value.autoLevel);
	if (auto) out.autoLevel = auto;
	if (typeof value.defaultModel === "string") out.defaultModel = value.defaultModel;
	if (isPlainObject(value.models)) {
		out.models = value.models as Record<string, ModelOverride>;
	}
	return out;
}

function coerceAutoLevel(value: unknown): AutoLevel | undefined {
	if (value === "low" || value === "medium" || value === "high") return value;
	return undefined;
}

function normalizeModelOverrides(
	raw: Record<string, ModelOverride> | undefined,
): Record<string, ModelOverride> {
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
		if (isPlainObject(o.thinkingLevelMap)) {
			const map: Record<string, string | null> = {};
			for (const [level, value] of Object.entries(o.thinkingLevelMap)) {
				if (value === null || typeof value === "string") map[level] = value;
			}
			if (Object.keys(map).length > 0) {
				normalized.thinkingLevelMap = map as ModelOverride["thinkingLevelMap"];
			}
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

export const CONFIG_PATH_FOR_DIAGNOSTICS = CONFIG_PATH;
