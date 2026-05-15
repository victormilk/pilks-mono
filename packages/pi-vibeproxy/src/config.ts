import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConfigFile, ModelOverride, ResolvedConfig } from "./types.ts";

const DEFAULT_BASE_URL = "http://localhost:8317";
const CONFIG_PATH = join(homedir(), ".pi", "agent", "vibeproxy.json");

/**
 * Load and resolve runtime config.
 *
 * Layering (later wins):
 *   defaults  <  ~/.pi/agent/vibeproxy.json  <  env vars (VIBEPROXY_URL, VIBEPROXY_API_KEY)
 *
 * Returns a fully-resolved config; the file is optional, missing fields are filled
 * with safe defaults, malformed values are warned-about and ignored.
 */
export function loadConfig(): ResolvedConfig {
	const fromFile = readConfigFile(CONFIG_PATH);

	const envUrl = process.env.VIBEPROXY_URL?.trim();
	const envKey = process.env.VIBEPROXY_API_KEY?.trim();

	const baseUrl = stripTrailingSlash(envUrl || fromFile.parsed.baseUrl?.trim() || DEFAULT_BASE_URL);
	const apiKey = envKey ?? fromFile.parsed.apiKey ?? "";

	return {
		baseUrl,
		apiKey,
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
		console.warn(`[vibeproxy] Failed to read ${path}: ${(err as Error).message}. Using defaults.`);
		return { exists: true, parsed: {} };
	}
}

/**
 * Coerce an unknown JSON value into a `ConfigFile`. Unknown / malformed fields
 * are dropped with a warning; we never throw — the extension must still load.
 */
function coerceConfigFile(value: unknown, path: string): ConfigFile {
	if (!isPlainObject(value)) {
		console.warn(`[vibeproxy] ${path} is not a JSON object. Ignoring contents.`);
		return {};
	}
	const out: ConfigFile = {};
	if (typeof value.baseUrl === "string") out.baseUrl = value.baseUrl;
	if (typeof value.apiKey === "string") out.apiKey = value.apiKey;
	if (isPlainObject(value.models)) {
		out.models = value.models as Record<string, ModelOverride>;
	}
	return out;
}

function normalizeModelOverrides(raw: Record<string, ModelOverride> | undefined): Record<string, ModelOverride> {
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

function stripTrailingSlash(url: string): string {
	return url.replace(/\/+$/, "");
}

export const CONFIG_PATH_FOR_DIAGNOSTICS = CONFIG_PATH;
