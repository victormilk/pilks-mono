import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import {
	calculateCost,
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type ToolCall,
} from "@earendil-works/pi-ai";
import {
	AutonomyLevel,
	createSession,
	DroidMessageType,
	ToolConfirmationOutcome,
	type DroidMessage,
	type DroidSession,
} from "@factory/droid-sdk";
import type { ResolvedConfig, ResolvedModel } from "./types.ts";

const PROVIDER_NAME = "droid";
const PROVIDER_DISPLAY_NAME = "Factory Droid";
const PROVIDER_API = "droid-exec";
/** Self-documenting sentinel — `streamSimple` owns transport, but Pi requires a non-empty baseUrl when models are set. */
const PROVIDER_BASE_URL = "droid-exec://local";
/** Env-var NAME (not value). Pi resolves it via `resolve-config-value.js:14-20` and passes the value as `options.apiKey`. */
const PROVIDER_API_KEY_ENV = "FACTORY_API_KEY";

/**
 * Module-level singleton — one `DroidSession` per Pi-extension instance. The SDK
 * multiplexes multiple turns onto the same underlying `droid exec` subprocess.
 *
 * Lifecycle:
 *   - first `streamSimple()` call lazily spawns the session
 *   - `pi.on("session_shutdown")` closes it
 *   - `/droid-restart` calls `closeSession()` so the next turn respawns
 *   - any uncaught stream error nulls the singleton so the next turn respawns
 */
let session: DroidSession | null = null;
let lastSpawnAt: number | undefined;
let lastError: string | undefined;

/** Exposed for `commands.ts` (`/droid-status`, `/droid-restart`). */
export function getSessionSnapshot(): {
	sessionId: string | null;
	lastSpawnAt: number | undefined;
	lastError: string | undefined;
} {
	return { sessionId: session?.sessionId ?? null, lastSpawnAt, lastError };
}

/** Clear cached error — used by `/droid-refresh` and `/droid-restart`. */
export function clearLastError(): void {
	lastError = undefined;
}

/** Idempotent teardown — safe to call when no session exists. */
export async function closeSession(): Promise<void> {
	const s = session;
	session = null;
	lastSpawnAt = undefined;
	if (s) {
		try {
			await s.close();
		} catch {
			/* swallow — shutdown must not throw */
		}
	}
}

/**
 * Register the `"droid"` provider. `models` carries every curated entry with
 * overrides applied; the same `streamSimple` body serves every model id.
 *
 * Idempotent — re-calling with a new model list replaces the existing models
 * for this provider (see `@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:866-873`).
 */
export function registerProvider(
	pi: ExtensionAPI,
	cfg: ResolvedConfig,
	resolved: ReadonlyArray<ResolvedModel>,
): { totalModels: number } {
	const config: ProviderConfig = {
		name: PROVIDER_DISPLAY_NAME,
		baseUrl: PROVIDER_BASE_URL,
		apiKey: PROVIDER_API_KEY_ENV,
		api: PROVIDER_API,
		streamSimple: (model, context, options) => streamDroid(model, context, options, cfg),
		models: resolved.map((m) => m.piModel),
	};
	pi.registerProvider(PROVIDER_NAME, config);
	return { totalModels: resolved.length };
}

/** Wire subprocess teardown to Pi's session-shutdown event. */
export function wireSessionShutdown(pi: ExtensionAPI): void {
	pi.on("session_shutdown", async () => {
		await closeSession();
	});
}

// ---------------------------------------------------------------------------
// `streamSimple` body — translates `DroidMessage` → `AssistantMessageEvent`
// ---------------------------------------------------------------------------

function streamDroid(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	cfg: ResolvedConfig,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		// Tag each open block with its upstream key — message-id+block-index for text/thinking,
		// toolUseId for tool-calls — so we can find the active block by upstream identity.
		const indexOf = new Map<string, number>(); // BlockKey → contentIndex
		// Track block keys we've already opened to know when to emit a final `*_end`.
		const openTextKeys = new Set<string>();
		const openThinkingKeys = new Set<string>();

		// Cooperative abort: when Pi cancels, just flip a flag. The SDK's
		// `wireAbortSignal` already translates `options.signal` aborts into
		// `client.interruptSession()` calls when passed via `session.stream({ abortSignal })`.
		// Calling `interrupt()` manually here would double-interrupt.
		let aborted = false;
		const onAbort = () => {
			aborted = true;
		};
		options?.signal?.addEventListener("abort", onAbort, { once: true });

		try {
			const droidSession = await getOrCreateSession(cfg, options?.apiKey);
			stream.push({ type: "start", partial: output });

			// Build the user prompt from context. Drop `context.systemPrompt` —
			// Droid owns its own system prompt; layering Pi's risks duplication.
			const userPrompt = extractUserPrompt(context);

			for await (const event of droidSession.stream(userPrompt, {
				abortSignal: options?.signal,
			})) {
				translate(event, output, stream, indexOf, openTextKeys, openThinkingKeys, model);
			}

			if (aborted || options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			// Close any still-open text/thinking blocks before `done` (Droid's snake_case
			// notifications don't ship explicit "complete" events for text/thinking).
			closeOpenBlocks(output, stream, openTextKeys, openThinkingKeys, indexOf);

			stream.push({
				type: "done",
				reason: output.stopReason === "length" || output.stopReason === "toolUse"
					? output.stopReason
					: "stop",
				message: output,
			});
			stream.end();
		} catch (error) {
			// Hoist a typed local for the discriminated-union `reason` field — TS doesn't
			// narrow property reads from prior assignments under strict mode.
			const errorReason: "aborted" | "error" =
				aborted || options?.signal?.aborted ? "aborted" : "error";
			output.stopReason = errorReason;
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);

			// Null the singleton on hard errors so the next turn respawns.
			// Aborts are recoverable; everything else is suspect.
			if (errorReason === "error") {
				lastError = output.errorMessage;
				void closeSession();
			}

			stream.push({ type: "error", reason: errorReason, error: output });
			stream.end();
		} finally {
			options?.signal?.removeEventListener("abort", onAbort);
		}
	})();

	return stream;
}

function extractUserPrompt(context: Context): string {
	// Pi's coding-agent stitches the conversation in `context.messages` already;
	// Droid wants the latest user turn as a single string. Pull the last user
	// message (the one Pi just appended) and string-ify its content.
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const msg = context.messages[i];
		if (!msg || msg.role !== "user") continue;
		if (typeof msg.content === "string") return msg.content;
		return msg.content
			.filter((c): c is { type: "text"; text: string; textSignature?: string } => c.type === "text")
			.map((c) => c.text)
			.join("");
	}
	return "";
}

/**
 * Emit `*_end` events for any text/thinking blocks that were opened but never
 * received an explicit close from the upstream. Droid's stream protocol does
 * not ship `_complete` markers per block — the natural turn boundary is the
 * terminal `turn_complete` event, so we synthesize the per-block close here.
 */
function closeOpenBlocks(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	openTextKeys: Set<string>,
	openThinkingKeys: Set<string>,
	indexOf: Map<string, number>,
): void {
	for (const key of openTextKeys) {
		const idx = indexOf.get(key);
		if (idx === undefined) continue;
		const block = output.content[idx];
		if (block?.type !== "text") continue;
		stream.push({ type: "text_end", contentIndex: idx, content: block.text, partial: output });
	}
	openTextKeys.clear();
	for (const key of openThinkingKeys) {
		const idx = indexOf.get(key);
		if (idx === undefined) continue;
		const block = output.content[idx];
		if (block?.type !== "thinking") continue;
		stream.push({ type: "thinking_end", contentIndex: idx, content: block.thinking, partial: output });
	}
	openThinkingKeys.clear();
}

// ---------------------------------------------------------------------------
// Per-event translation
// ---------------------------------------------------------------------------

function translate(
	event: DroidMessage,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	indexOf: Map<string, number>,
	openTextKeys: Set<string>,
	openThinkingKeys: Set<string>,
	model: Model<Api>,
): void {
	switch (event.type) {
		case DroidMessageType.AssistantTextDelta: {
			const key = `text:${event.messageId}:${event.blockIndex}`;
			let idx = indexOf.get(key);
			if (idx === undefined) {
				idx = output.content.length;
				output.content.push({ type: "text", text: "" });
				indexOf.set(key, idx);
				openTextKeys.add(key);
				stream.push({ type: "text_start", contentIndex: idx, partial: output });
			}
			const block = output.content[idx];
			if (block?.type !== "text") return;
			block.text += event.text;
			stream.push({ type: "text_delta", contentIndex: idx, delta: event.text, partial: output });
			return;
		}

		case DroidMessageType.ThinkingTextDelta: {
			const key = `think:${event.messageId}:${event.blockIndex}`;
			let idx = indexOf.get(key);
			if (idx === undefined) {
				idx = output.content.length;
				output.content.push({ type: "thinking", thinking: "", thinkingSignature: "" });
				indexOf.set(key, idx);
				openThinkingKeys.add(key);
				stream.push({ type: "thinking_start", contentIndex: idx, partial: output });
			}
			const block = output.content[idx];
			if (block?.type !== "thinking") return;
			block.thinking += event.text;
			stream.push({ type: "thinking_delta", contentIndex: idx, delta: event.text, partial: output });
			return;
		}

		case DroidMessageType.ToolUse: {
			// Droid yields one `tool_use` event per tool call carrying the final input. Pi's
			// consumer expects start + delta + end, so emit all three in sequence with the
			// snapshot as the delta payload.
			const args = (event.toolInput ?? {}) as Record<string, unknown>;
			const idx = output.content.length;
			const call: ToolCall = {
				type: "toolCall",
				id: event.toolUseId,
				name: event.toolName,
				arguments: args,
			};
			output.content.push(call);
			stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
			stream.push({
				type: "toolcall_delta",
				contentIndex: idx,
				delta: safeStringify(args),
				partial: output,
			});
			stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: call, partial: output });
			output.stopReason = "toolUse";
			return;
		}

		case DroidMessageType.TokenUsageUpdate: {
			output.usage.input = event.inputTokens ?? 0;
			output.usage.output = (event.outputTokens ?? 0) + (event.thinkingTokens ?? 0);
			output.usage.cacheRead = event.cacheReadTokens ?? 0;
			output.usage.cacheWrite = event.cacheCreationTokens ?? 0;
			output.usage.totalTokens =
				output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
			output.usage.cost = calculateCost(model, output.usage);
			return;
		}

		case DroidMessageType.WorkingStateChanged: {
			// Per-state UI hints could live here in v2; the natural turn end is `turn_complete`.
			return;
		}

		case DroidMessageType.Error: {
			throw new Error(`droid: ${event.errorType}: ${event.message}`);
		}

		case DroidMessageType.TurnComplete: {
			// Final SDK message — for-await exits naturally after this. If usage shipped
			// inside the sentinel, fold it in.
			if (event.tokenUsage) {
				output.usage.input = event.tokenUsage.inputTokens ?? 0;
				output.usage.output =
					(event.tokenUsage.outputTokens ?? 0) + (event.tokenUsage.thinkingTokens ?? 0);
				output.usage.cacheRead = event.tokenUsage.cacheReadTokens ?? 0;
				output.usage.cacheWrite = event.tokenUsage.cacheCreationTokens ?? 0;
				output.usage.totalTokens =
					output.usage.input +
					output.usage.output +
					output.usage.cacheRead +
					output.usage.cacheWrite;
				output.usage.cost = calculateCost(model, output.usage);
			}
			return;
		}

		// Drop everything else: ToolResult / ToolProgress (not assistant content), CreateMessage
		// (full-message rollup we've already streamed via deltas), permission / settings /
		// mission / MCP / session-title — not part of the assistant content stream Pi consumes.
		default:
			return;
	}
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return "";
	}
}

// ---------------------------------------------------------------------------
// Lazy session lifecycle
// ---------------------------------------------------------------------------

async function getOrCreateSession(cfg: ResolvedConfig, apiKey: string | undefined): Promise<DroidSession> {
	if (session) return session;
	// SDK requires `Record<string, string>` for `env`; strip undefined entries from `process.env`.
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (typeof v === "string") env[k] = v;
	}
	if (apiKey) {
		// Pi resolved `apiKey: "FACTORY_API_KEY"` to the real value via
		// `@earendil-works/pi-coding-agent/dist/core/resolve-config-value.js:14-20`.
		// Re-export it for the spawned droid (the SDK reads `env.FACTORY_API_KEY`).
		env.FACTORY_API_KEY = apiKey;
	}
	const created = await createSession({
		cwd: process.cwd(),
		execPath: cfg.droidBinary,
		// `autonomyLevel` is the SDK's typed channel for `--auto`; don't also pass `--auto`
		// via `execArgs` to avoid double-wiring.
		autonomyLevel: autonomyFromAutoLevel(cfg.autoLevel),
		permissionHandler: () => ToolConfirmationOutcome.ProceedOnce,
		env,
	});
	session = created;
	lastSpawnAt = Date.now();
	lastError = undefined;
	return created;
}

function autonomyFromAutoLevel(level: ResolvedConfig["autoLevel"]): AutonomyLevel {
	switch (level) {
		case "low":
			return AutonomyLevel.Low;
		case "high":
			return AutonomyLevel.High;
		default:
			return AutonomyLevel.Medium;
	}
}
