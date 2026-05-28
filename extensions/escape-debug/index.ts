/**
 * Escape-debug diagnostic extension.
 *
 * Purpose: capture every signal we can about the input pipeline and agent
 * lifecycle, so when "Escape doesn't work" happens again, the log file is
 * sufficient on its own to identify which branch of the failure tree we hit
 * (A: input never arrives, B: stale escape handler, C: isStreaming false at
 * escape time, D: agent.abort no-op, E: tool ignores signal).
 *
 * This extension is intentionally observational. It does NOT change pi
 * behavior. It only registers:
 *   - an onTerminalInput listener (does NOT consume; just observes),
 *   - handlers for every pi.on() event that touches abort/streaming,
 *   - a periodic state poller (slow, only logs when state changes),
 *   - a /escape-debug command for runtime control / status.
 *
 * Pair with the logging added to bash-jobs.ts and goal.ts to get full
 * timelines of "what happened around the escape key press".
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describeInput, dlog, ESCAPE_DEBUG_LOG_PATH } from "./log.js";

// State we derive locally from event sequences. ctx exposes `signal` and
// `isIdle()` but NOT isCompacting/isBashRunning/retryAttempt; we maintain
// our own mirror by listening to the corresponding events.
type DerivedState = {
	isIdle: boolean;
	signalAborted: boolean | null;
	hasPendingMessages: boolean;
	inCompaction: boolean;
	inRetry: boolean;
	currentTool: string | null;
	currentToolCallId: string | null;
	turnDepth: number;
	lastAgentStartAt: number | null;
	lastAgentEndAt: number | null;
	lastEscapePressAt: number | null;
	abortHandlerSeen: boolean;
	contextUsagePercent: number | null;
};

// Per-input record so we can correlate "escape was pressed at HR=X" with
// "agent_end fired at HR=Y" later. Bounded.
type EscapeEvent = {
	hr: bigint;
	atMs: number;
	derived: DerivedState;
};
const recentEscapes: EscapeEvent[] = [];
const MAX_RECENT = 32;
const STUCK_THRESHOLD_MS = 5_000;
let stuckCheckTimer: NodeJS.Timeout | undefined;

export default function escapeDebugExtension(pi: ExtensionAPI): void {
	let state: DerivedState = {
		isIdle: true,
		signalAborted: null,
		hasPendingMessages: false,
		inCompaction: false,
		inRetry: false,
		currentTool: null,
		currentToolCallId: null,
		turnDepth: 0,
		lastAgentStartAt: null,
		lastAgentEndAt: null,
		lastEscapePressAt: null,
		abortHandlerSeen: false,
		contextUsagePercent: null,
	};

	function snapshot(ctx?: ExtensionContext): DerivedState {
		if (ctx) {
			try {
				state.isIdle = ctx.isIdle();
			} catch {
				// ignore
			}
			try {
				state.signalAborted = ctx.signal?.aborted ?? null;
			} catch {
				// ignore
			}
			try {
				state.hasPendingMessages = ctx.hasPendingMessages();
			} catch {
				// ignore
			}
			try {
				const usage = ctx.getContextUsage();
				state.contextUsagePercent = usage?.percent ?? null;
			} catch {
				// ignore
			}
		}
		return { ...state };
	}

	function logStateChange(reason: string, ctx?: ExtensionContext): void {
		dlog("STATE", reason, snapshot(ctx));
	}

	function recordEscape(ctx?: ExtensionContext): void {
		const hr = process.hrtime.bigint();
		const atMs = Date.now();
		state.lastEscapePressAt = atMs;
		const derived = snapshot(ctx);
		recentEscapes.push({ hr, atMs, derived });
		if (recentEscapes.length > MAX_RECENT) recentEscapes.shift();
		dlog("ESCAPE", "press_detected", {
			...derived,
			pendingEscapesTracked: recentEscapes.length,
			thresholdMs: STUCK_THRESHOLD_MS,
		});
	}

	function checkForStuckEscapes(): void {
		const now = Date.now();
		// An escape is "stuck" if:
		//   - we recorded a press,
		//   - more than STUCK_THRESHOLD_MS has elapsed,
		//   - the agent is still streaming (not idle), and
		//   - agent_end has not fired since the press.
		while (recentEscapes.length > 0) {
			const head = recentEscapes[0];
			const elapsed = now - head.atMs;
			if (elapsed < STUCK_THRESHOLD_MS) break;
			const agentEndedAfterPress =
				state.lastAgentEndAt !== null && state.lastAgentEndAt >= head.atMs;
			if (state.isIdle || agentEndedAfterPress) {
				// Escape effectively worked (or wasn't relevant). Drop without warning.
				recentEscapes.shift();
				continue;
			}
			dlog("ESCAPE", "stuck", {
				...state,
				escapePressAt: head.atMs,
				ageMs: elapsed,
				agentEndedAfterPress,
				note:
					"Escape was pressed >" +
					STUCK_THRESHOLD_MS +
					"ms ago and agent has not gone idle / no agent_end since. " +
					"Likely failure modes: signal listener never fired in tool, signal not propagated, " +
					"or onEscape handler did not call agent.abort().",
			});
			recentEscapes.shift();
		}
	}

	// ─── 1. Capture EVERY raw input event ──────────────────────────────────────
	//
	// This is the single most important data point: did the escape key
	// actually arrive at the TUI, and if so, what bytes? If we see no escape
	// input at all when the user reports pressing escape, that pins it on the
	// terminal / Kitty protocol / shell layer. If we see it but no
	// ESCAPE.press_detected from the editor path, that pins it on the TUI
	// dispatch chain.
	//
	// Note: onTerminalInput is only available with hasUI = true. We register
	// inside an event handler so we can grab the ui context lazily.
	let inputListenerInstalled = false;
	let inputListenerCtx: ExtensionContext | null = null;
	function installInputListener(ctx: ExtensionContext): void {
		if (inputListenerInstalled) return;
		if (!ctx.hasUI) {
			dlog("BOOT", "skip_input_listener_no_ui", {});
			return;
		}
		try {
			inputListenerCtx = ctx;
			ctx.ui.onTerminalInput((data) => {
				const info = describeInput(data);
				dlog("INPUT", "raw", {
					...info,
					...snapshot(inputListenerCtx ?? undefined),
				});
				if (info.isEscape) {
					recordEscape(inputListenerCtx ?? undefined);
				}
				return undefined; // do NOT consume
			});
			inputListenerInstalled = true;
			dlog("BOOT", "input_listener_installed", {});
		} catch (err) {
			dlog("BOOT", "input_listener_install_failed", {
				error: (err as Error)?.message ?? String(err),
			});
		}
	}

	// ─── 2. Agent lifecycle ────────────────────────────────────────────────────

	pi.on("agent_start", async (_event, ctx) => {
		state.turnDepth = 0;
		state.lastAgentStartAt = Date.now();
		state.abortHandlerSeen = false;
		installInputListener(ctx);
		logStateChange("agent_start", ctx);
	});

	pi.on("agent_end", async (event, ctx) => {
		state.lastAgentEndAt = Date.now();
		const messages = (event as { messages?: unknown }).messages;
		const lastMessage =
			Array.isArray(messages) && messages.length > 0 ? messages[messages.length - 1] : undefined;
		dlog("AGENT", "agent_end", {
			...snapshot(ctx),
			messagesCount: Array.isArray(messages) ? messages.length : 0,
			lastStopReason: (lastMessage as { stopReason?: unknown } | undefined)?.stopReason,
			lastErrorMessage: (lastMessage as { errorMessage?: unknown } | undefined)?.errorMessage,
		});
	});

	pi.on("turn_start", async (_event, ctx) => {
		state.turnDepth += 1;
		dlog("AGENT", "turn_start", { ...snapshot(ctx), turnDepth: state.turnDepth });
	});

	pi.on("turn_end", async (event, ctx) => {
		const msg = (event as { message?: { stopReason?: string; errorMessage?: string } }).message;
		const toolResults = (event as { toolResults?: unknown[] }).toolResults ?? [];
		dlog("AGENT", "turn_end", {
			...snapshot(ctx),
			stopReason: msg?.stopReason,
			errorMessage: msg?.errorMessage,
			toolResultCount: toolResults.length,
		});
	});

	// ─── 3. Tool execution ─────────────────────────────────────────────────────

	pi.on("tool_execution_start", async (event, ctx) => {
		const ev = event as { toolName?: string; toolCallId?: string; args?: unknown };
		state.currentTool = ev.toolName ?? null;
		state.currentToolCallId = ev.toolCallId ?? null;
		dlog("TOOL", "execution_start", {
			...snapshot(ctx),
			toolName: ev.toolName,
			toolCallId: ev.toolCallId,
		});
	});

	pi.on("tool_execution_update", async (event, _ctx) => {
		const ev = event as { toolName?: string; toolCallId?: string };
		// Update events are extremely frequent (every output chunk). Don't log
		// the full payload; just keep a heartbeat so we know the tool is still
		// updating.
		dlog("TOOL", "execution_update", {
			toolName: ev.toolName,
			toolCallId: ev.toolCallId,
		});
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		const ev = event as { toolName?: string; toolCallId?: string; isError?: boolean };
		const wasCurrent =
			state.currentToolCallId === ev.toolCallId && state.currentTool === ev.toolName;
		if (wasCurrent) {
			state.currentTool = null;
			state.currentToolCallId = null;
		}
		dlog("TOOL", "execution_end", {
			...snapshot(ctx),
			toolName: ev.toolName,
			toolCallId: ev.toolCallId,
			isError: ev.isError,
		});
	});

	// ─── 4. Compaction and retry (escape handler is swapped during these) ─────

	pi.on("session_before_compact", async (event, ctx) => {
		state.inCompaction = true;
		const ev = event as { signal?: AbortSignal; preparation?: unknown };
		dlog("COMPACT", "session_before_compact", {
			...snapshot(ctx),
			signalAlreadyAborted: ev.signal?.aborted ?? null,
			hasPreparation: !!ev.preparation,
		});
		// Watch the compaction signal so we know exactly when it aborts.
		ev.signal?.addEventListener(
			"abort",
			() => {
				dlog("COMPACT", "compaction_signal_aborted", snapshot(ctx));
			},
			{ once: true },
		);
		return undefined;
	});

	pi.on("session_compact", async (_event, ctx) => {
		state.inCompaction = false;
		dlog("COMPACT", "session_compact_done", snapshot(ctx));
	});

	// ─── 5. Input event (after autocomplete/prompt-template expansion) ────────

	pi.on("input", async (event, ctx) => {
		const ev = event as { source?: string; text?: string };
		dlog("INPUT", "post_input_event", {
			...snapshot(ctx),
			source: ev.source,
			textLen: typeof ev.text === "string" ? ev.text.length : 0,
			textPreview: typeof ev.text === "string" ? ev.text.slice(0, 80) : undefined,
		});
		return { action: "continue" } as const;
	});

	// ─── 6. Periodic state poll (only logs deltas) ────────────────────────────

	let lastPolled: string | null = null;
	const pollTimer = setInterval(() => {
		const s = snapshot(inputListenerCtx ?? undefined);
		const key = JSON.stringify({
			isIdle: s.isIdle,
			signalAborted: s.signalAborted,
			hasPending: s.hasPendingMessages,
			inCompaction: s.inCompaction,
			inRetry: s.inRetry,
			tool: s.currentTool,
			turn: s.turnDepth,
		});
		if (key !== lastPolled) {
			lastPolled = key;
			dlog("STATE", "poll_changed", s);
		}
		checkForStuckEscapes();
	}, 250);
	pollTimer.unref?.();
	stuckCheckTimer = pollTimer;

	pi.on("session_shutdown", async () => {
		if (stuckCheckTimer) {
			clearInterval(stuckCheckTimer);
			stuckCheckTimer = undefined;
		}
		dlog("BOOT", "session_shutdown", {});
	});

	pi.on("session_start", async (_event, ctx) => {
		installInputListener(ctx);
		dlog("BOOT", "session_start", snapshot(ctx));
	});

	pi.on("session_tree", async (_event, ctx) => {
		dlog("BOOT", "session_tree", snapshot(ctx));
	});

	// ─── 7. Manual control ────────────────────────────────────────────────────

	pi.registerCommand("escape-debug", {
		description:
			"Inspect or control the escape-debug diagnostic logger. Subcommands: status | path | mark <note>",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed || trimmed === "status") {
				const s = snapshot(ctx);
				ctx.ui.notify(
					[
						`escape-debug log: ${ESCAPE_DEBUG_LOG_PATH}`,
						`isIdle=${s.isIdle} signalAborted=${s.signalAborted}`,
						`pending=${s.hasPendingMessages} compaction=${s.inCompaction} retry=${s.inRetry}`,
						`tool=${s.currentTool ?? "—"} turn=${s.turnDepth}`,
						`recentEscapesTracked=${recentEscapes.length}`,
					].join("\n"),
					"info",
				);
				return;
			}
			if (trimmed === "path") {
				ctx.ui.notify(ESCAPE_DEBUG_LOG_PATH, "info");
				return;
			}
			if (trimmed.startsWith("mark")) {
				const note = trimmed.slice(4).trim() || "(no note)";
				dlog("USER", "mark", { note, state: snapshot(ctx) });
				ctx.ui.notify(`Marked in escape-debug log: ${note}`, "info");
				return;
			}
			ctx.ui.notify("Unknown subcommand. Use status | path | mark <note>.", "warning");
		},
	});

	dlog("BOOT", "extension_registered", { logPath: ESCAPE_DEBUG_LOG_PATH });
}
