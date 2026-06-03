import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readReserveTokens } from "./lib/compaction-settings.js";

const ENTRY_CONFIG = "token-window-reminder-config";
const ENTRY_REMINDER = "token-window-reminder-fired";
const ENTRY_RESET = "token-window-reminder-reset";

const DEFAULT_ENABLED = true;

// =============================================================================
// Editable knobs
// =============================================================================
//
// Reminders fire on a STAGGERED LADDER anchored at pi's compaction point and
// climbing into the reserve toward the hard context limit. Each rung escalates
// the wording, pushing the model harder to stop and hand control back.
//
// Why anchor at the compaction point (and not earlier): pi can only auto-compact
// (summarize) at an agent-run boundary — once the model yields back to the user
// (agent_end), never between tool turns and not while it is being steered. Below
// the compaction point there is nothing useful to do: pi won't compact and there
// is headroom. The FIRST reminder fires the moment usage crosses pi's compaction
// point (`contextWindow - reserveTokens`) — the exact point pi *would* compact if
// the model yielded. If the model keeps working instead, it eats into the reserve
// pi holds for its response; the next two rungs escalate as it heads toward
// running out of context entirely.
//
// Rungs are positioned by how far INTO THE RESERVE usage has pushed past the
// compaction point: `reserveFraction` is the fraction of `reserveTokens` consumed
// beyond `contextWindow - reserveTokens`. So 0.0 == exactly at the compaction
// point and 1.0 == the full context window. `reserveTokens` is read from pi's
// global settings (see ./lib/compaction-settings) so this tracks pi automatically.
//
// Each rung carries an `escalation` line, appended on top of every lower rung's
// line once usage reaches it, so urgency builds cumulatively and tracks the
// ladder even if you retune it. The base message stays factual; all directives
// live here. Keep the rungs sorted ascending.
const REMINDER_LADDER: readonly { reserveFraction: number; escalation: string }[] = [
	{
		reserveFraction: 0.0,
		escalation:
			"When you reach a natural stopping point, call the `compaction_handoff` tool to record a thorough hand-off and end your turn so pi can compact.",
	},
	{
		reserveFraction: 0.5,
		escalation:
			"You are now past the compaction point and eating into the reserve pi keeps for its own response. Wrap up the current step and call `compaction_handoff` now rather than starting new work.",
	},
	{
		reserveFraction: 0.85,
		escalation:
			"URGENT: you are about to run out of context entirely. Call `compaction_handoff` immediately and stop — do not begin anything new. Yielding is the only thing that lets pi compact and recover the window.",
	},
];

function formatPercent(percent: number): string {
	return Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(1)}%`;
}

// reserveFraction 0 == pi's compaction point (contextWindow - reserveTokens),
// 1 == the full window; rungs sit proportionally in between.
function rungThresholdTokens(reserveFraction: number, contextWindow: number, reserveTokens: number): number {
	return contextWindow - reserveTokens + reserveFraction * reserveTokens;
}

// Display fields for the current usage, in FULL-WINDOW terms (matches pi's
// footer). Prefers pi's own `percent` so the number can't diverge from what the
// user sees, deriving it only as a fallback if pi reports tokens without one.
type UsageInfo = { tokens: number; contextWindow: number; percent: number; tokensToFull: number };

function describeUsage(tokens: number, contextWindow: number, percent?: number | null): UsageInfo {
	return {
		tokens,
		contextWindow,
		percent: percent ?? (tokens / contextWindow) * 100,
		tokensToFull: Math.max(0, contextWindow - tokens),
	};
}

function usageLabel(usage: UsageInfo): string {
	return `${formatPercent(usage.percent)} (${Math.round(usage.tokens).toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens)`;
}

// Returns -1 when usage is still below the first rung (pi's compaction point).
function highestRungAtOrBelow(tokens: number, contextWindow: number, reserveTokens: number): number {
	let index = -1;
	for (let i = 0; i < REMINDER_LADDER.length; i++) {
		if (tokens >= rungThresholdTokens(REMINDER_LADDER[i].reserveFraction, contextWindow, reserveTokens)) index = i;
	}
	return index;
}

// Steering message: a factual base (the compaction point has been reached, and
// how to hand off) plus every rung's escalation line up to and including the
// rung that fired, so urgency tracks ladder position.
function renderWarning(rungIndex: number, usage: UsageInfo): string {
	const remaining = Math.round(usage.tokensToFull).toLocaleString();
	const lines = [
		"<system_reminder>",
		`Your context has reached pi's compaction point: now at ${usageLabel(usage)}, ~${remaining} tokens before the window is full. pi will compact (summarize) this conversation only once you hand control back to the user — it cannot compact while you keep working or are being steered. Hand off via the \`compaction_handoff\` tool: it records a thorough hand-off (your goal, current work, next steps, and every key decision, file path, and fact needed to resume) and ends your turn so pi can compact. Be complete, not terse — a future instance with no memory of this session depends entirely on it.`,
	];
	for (let i = 0; i <= rungIndex; i++) {
		lines.push("", REMINDER_LADDER[i].escalation);
	}
	lines.push("</system_reminder>");
	return lines.join("\n");
}

// Sent once after compaction frees the context back up, so the model stops
// acting on the earlier hand-off / yield reminders. Edit the wording freely.
function renderRecovery(usage: UsageInfo): string {
	return `<system_reminder>
Good news: your context window has freed up and is now at ${usageLabel(usage)}. You have plenty of headroom again.
Disregard any earlier reminders about running low on context — there is no need to wrap up or hand back for context-size reasons. Carry on with the task.
</system_reminder>`;
}

// =============================================================================

type ConfigEntry = {
	enabled: boolean;
	updatedAt: number;
};

// Only `rung` is read on replay (see rebuildFromBranch); the rest is point-in-time
// data kept purely for observability when inspecting the session log.
type ReminderEntry = {
	rung: number;
	windowPercent: number;
	tokens: number;
	contextWindow: number;
	reserveTokens: number;
	createdAt: number;
};

type ResetEntry = {
	createdAt: number;
};

function formatStatus(
	enabled: boolean,
	lastWarnedRung: number | undefined,
	reserveTokens: number,
	ctx: ExtensionContext,
): string {
	const usage = ctx.getContextUsage();
	let usageText = "unknown";
	// Default: describe rungs by their position in the reserve. Replaced with
	// window-% once usage is known and the geometry is non-degenerate.
	let thresholdsText = `Thresholds (% into the reserve past the compaction point): ${REMINDER_LADDER.map(
		(rung) => `${Math.round(rung.reserveFraction * 100)}%`,
	).join(", ")}`;
	if (usage && usage.tokens !== null && usage.contextWindow > 0) {
		usageText = usageLabel(describeUsage(usage.tokens, usage.contextWindow, usage.percent));
		if (usage.contextWindow > reserveTokens) {
			const windowPercents = REMINDER_LADDER.map((rung) =>
				formatPercent((rungThresholdTokens(rung.reserveFraction, usage.contextWindow, reserveTokens) / usage.contextWindow) * 100),
			).join(", ");
			thresholdsText = `Thresholds (% of window, from the compaction point up): ${windowPercents}`;
		}
	}
	const lastText = lastWarnedRung === undefined ? "none" : `rung ${lastWarnedRung + 1}`;
	return [
		"Token-window reminders",
		`Status: ${enabled ? "on" : "off"}`,
		thresholdsText,
		`Reserve tokens (from settings): ${reserveTokens.toLocaleString()}`,
		`Current context usage: ${usageText}`,
		`Highest rung warned this episode: ${lastText}`,
		"",
		"Usage:",
		"  /ctxwarn          Show this status",
		"  /ctxwarn status   Show this status",
		"  /ctxwarn on       Enable reminders",
		"  /ctxwarn off      Disable reminders",
		"  /ctxwarn reset    Clear the remembered fired thresholds",
	].join("\n");
}

export default function tokenWindowReminder(pi: ExtensionAPI) {
	let enabled = DEFAULT_ENABLED;
	// Read from pi's global settings (fail-safe default) and refreshed on every
	// branch rebuild so the compaction point always matches pi's actual point.
	let reserveTokens = readReserveTokens();
	// Index of the highest ladder rung already warned this episode; undefined == none.
	// Re-armed ONLY by an actual compaction (session_compact), a config change, a
	// reset, or a branch rebuild — never by usage merely dipping below a rung, so
	// jitter around a threshold can never re-fire the same warning.
	let lastWarnedRung: number | undefined;
	// Set when a compaction drops usage after we had warned, so the next turn can
	// announce the recovery once usage is known again.
	let recoveryPending = false;

	function persistConfig(nextEnabled: boolean): void {
		enabled = nextEnabled;
		lastWarnedRung = undefined;
		recoveryPending = false;
		pi.appendEntry<ConfigEntry>(ENTRY_CONFIG, {
			enabled,
			updatedAt: Date.now(),
		});
	}

	function resetReminderState(): void {
		lastWarnedRung = undefined;
		recoveryPending = false;
		pi.appendEntry<ResetEntry>(ENTRY_RESET, { createdAt: Date.now() });
	}

	function rebuildFromBranch(ctx: ExtensionContext): void {
		reserveTokens = readReserveTokens();
		enabled = DEFAULT_ENABLED;
		lastWarnedRung = undefined;
		recoveryPending = false;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "compaction") {
				// Compaction shrinks the live context back down, so a reminder fired
				// before this point no longer reflects current usage. Re-arm the ladder.
				lastWarnedRung = undefined;
				continue;
			}
			if (entry.type !== "custom") continue;
			switch (entry.customType) {
				case ENTRY_CONFIG: {
					const data = entry.data as ConfigEntry | undefined;
					if (!data) break;
					enabled = data.enabled;
					lastWarnedRung = undefined;
					break;
				}
				case ENTRY_REMINDER: {
					const data = entry.data as Partial<ReminderEntry> | undefined;
					if (!data) break;
					// Pre-upgrade entries have no `rung` but still mean "had warned" —
					// treat them as rung 0 so a resumed session does not re-fire.
					const rung = typeof data.rung === "number" ? data.rung : 0;
					lastWarnedRung = Math.max(lastWarnedRung ?? -1, rung);
					break;
				}
				case ENTRY_RESET: {
					lastWarnedRung = undefined;
					break;
				}
			}
		}
	}

	function deliver(message: string, ctx: ExtensionContext): void {
		try {
			if (ctx.isIdle()) {
				pi.sendUserMessage(message);
			} else {
				pi.sendUserMessage(message, { deliverAs: "steer" });
			}
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI) ctx.ui.notify(`Token-window reminder failed: ${reason}`, "warning");
		}
	}

	function maybeSendReminder(ctx: ExtensionContext): void {
		if (!enabled) return;

		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null || usage.contextWindow <= 0) return;
		const tokens = usage.tokens;
		const contextWindow = usage.contextWindow;
		// reserve >= window leaves no usable budget; the ladder geometry is
		// degenerate (compaction point <= 0), so stay silent rather than spam.
		if (reserveTokens >= contextWindow) return;

		// Announce recovery once usage is known again after a compaction dropped it.
		if (recoveryPending) {
			recoveryPending = false;
			// Rung 0 sits exactly at pi's compaction point.
			const compactionPoint = rungThresholdTokens(REMINDER_LADDER[0].reserveFraction, contextWindow, reserveTokens);
			if (tokens < compactionPoint) {
				lastWarnedRung = undefined;
				deliver(renderRecovery(describeUsage(tokens, contextWindow, usage.percent)), ctx);
				return;
			}
			// Still high: lastWarnedRung was cleared on compaction, so fall through
			// and (re-)warn at whatever rung now applies.
		}

		const rungIndex = highestRungAtOrBelow(tokens, contextWindow, reserveTokens);
		// Below the compaction point. Do NOT re-arm here — re-arming only on a real
		// compaction is what keeps jitter around a threshold from re-firing.
		if (rungIndex < 0) return;
		if (lastWarnedRung !== undefined && rungIndex <= lastWarnedRung) return;

		lastWarnedRung = rungIndex;
		const usageInfo = describeUsage(tokens, contextWindow, usage.percent);
		pi.appendEntry<ReminderEntry>(ENTRY_REMINDER, {
			rung: rungIndex,
			windowPercent: usageInfo.percent,
			tokens,
			contextWindow,
			reserveTokens,
			createdAt: Date.now(),
		});

		deliver(renderWarning(rungIndex, usageInfo), ctx);
	}

	pi.registerTool({
		name: "compaction_handoff",
		label: "Compaction Hand-off",
		description: [
			"Record a hand-off and END YOUR TURN so pi can compact (summarize) the conversation and free the context window.",
			"Call this when you are asked to hand off for compaction, or when the context is nearly full and you have reached a safe stopping point.",
			"After calling it, STOP: do not call any more tools or keep working. pi compacts once you yield, and your hand-off stays in the conversation that gets summarized.",
			"Be exhaustive — a future instance with no memory of this session relies entirely on what you write here. Do not be terse.",
		].join(" "),
		parameters: Type.Object({
			goal: Type.String({
				description: "The overarching goal/objective you are working toward.",
			}),
			work_in_progress: Type.String({
				description:
					"What you are doing right now, in detail: the current step, partial progress, and anything left half-done.",
			}),
			next_steps: Type.String({
				description: "The concrete next actions to take, in order, to continue the work.",
			}),
			key_context: Type.String({
				description:
					"Key decisions and their rationale, constraints, file paths, commands, findings, and any other facts needed to resume. Be exhaustive.",
			}),
		}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const usage = ctx?.getContextUsage();
			// pi compacts at a run boundary when tokens > contextWindow - reserveTokens.
			const overCompactionPoint =
				!!usage && usage.tokens !== null && usage.contextWindow > 0 && usage.tokens > usage.contextWindow - reserveTokens;
			const tail = overCompactionPoint
				? "pi will compact the conversation once you yield."
				: "Note: context is not over pi's compaction point yet, so pi may not compact right away — still stop if you were asked to hand off.";
			return {
				content: [
					{
						type: "text",
						text: `Hand-off recorded. End your turn now — do not call any more tools or keep working. ${tail}`,
					},
				],
				details: undefined,
			};
		},
	});

	pi.registerCommand("ctxwarn", {
		description: "Configure token-window reminder steering messages",
		getArgumentCompletions: (prefix) => {
			const values = ["status", "on", "off", "reset"];
			const filtered = values.filter((value) => value.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim().toLowerCase();

			if (!trimmed || trimmed === "status") {
				ctx.ui.notify(formatStatus(enabled, lastWarnedRung, reserveTokens, ctx), "info");
				return;
			}

			if (trimmed === "on") {
				persistConfig(true);
				ctx.ui.notify("Token-window reminders enabled.", "info");
				maybeSendReminder(ctx);
				return;
			}

			if (trimmed === "off") {
				persistConfig(false);
				ctx.ui.notify("Token-window reminders disabled.", "info");
				return;
			}

			if (trimmed === "reset") {
				resetReminderState();
				ctx.ui.notify("Token-window reminder state reset.", "info");
				maybeSendReminder(ctx);
				return;
			}

			ctx.ui.notify(
				`Unknown /ctxwarn argument.\n\n${formatStatus(enabled, lastWarnedRung, reserveTokens, ctx)}`,
				"warning",
			);
		},
	});

	pi.on("turn_end", async (_event, ctx) => {
		maybeSendReminder(ctx);
	});

	pi.on("session_compact", async (_event, _ctx) => {
		// Compaction drops utilization. If we had warned, queue a recovery notice so
		// the model learns it has headroom again, and re-arm the whole ladder. OR in
		// (rather than overwrite) so a second compaction before the next turn cannot
		// drop a recovery already queued by the first.
		recoveryPending = recoveryPending || lastWarnedRung !== undefined;
		lastWarnedRung = undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		rebuildFromBranch(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		rebuildFromBranch(ctx);
	});
}
