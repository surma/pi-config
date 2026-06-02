import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readReserveTokens } from "./lib/compaction-settings.js";

const ENTRY_CONFIG = "token-window-reminder-config";
const ENTRY_REMINDER = "token-window-reminder-fired";
const ENTRY_RESET = "token-window-reminder-reset";

const DEFAULT_ENABLED = true;

// =============================================================================
// Editable knobs
// =============================================================================
//
// The reminder fires a single steering message when context usage reaches pi's
// auto-compaction point: contextTokens >= contextWindow - reserveTokens. That is
// the exact boundary where pi will compact (summarize) at the end of the current
// agent run, so it is the right — and only — moment to ask the model to record a
// hand-off. `reserveTokens` is read from pi's global settings (see
// ./lib/compaction-settings), so this stays in sync with pi automatically.
//
// We intentionally do NOT warn earlier: firing below the compaction point makes
// the model dump context and yield prematurely while there is still plenty of
// headroom and no compaction follows. Firing AT the point means a steered
// message gets woven into the current run (compaction only triggers at the run
// boundary, never between tool turns), so the model records the hand-off inline
// and pi then compacts it into the summary.

function usageLabel(tokens: number, contextWindow: number): string {
	const percent = contextWindow > 0 ? (tokens / contextWindow) * 100 : 0;
	return `${formatPercent(percent)} (${formatTokens(tokens, contextWindow)})`;
}

// Steering message asking the model to record a hand-off before pi compacts.
// Edit the wording freely.
function renderWarning(tokens: number, contextWindow: number): string {
	const usage = usageLabel(tokens, contextWindow);
	return `<system_reminder>
Your context is at ${usage}, which has reached the point where pi will automatically compact (summarize) this conversation very soon — when your current turn finishes. So nothing important is lost in that summary, record a concise hand-off NOW, inline as part of your current work. You do NOT need to stop or hand back to the user — just write it down and carry on:
- The overarching goal you are working toward.
- What you are doing right now.
- What you intend to do next.
- Any key decisions, constraints, file paths, or facts needed to resume.
</system_reminder>`;
}

// Sent once after compaction frees the context back up, so the model stops
// acting on the earlier hand-off reminder. Edit the wording freely.
function renderRecovery(tokens: number, contextWindow: number): string {
	const usage = usageLabel(tokens, contextWindow);
	return `<system_reminder>
Good news: your context window has freed up and is now at ${usage}. You have plenty of headroom again.
Disregard any earlier reminders about running low on context — there is no need to wrap up for context-size reasons. Carry on with the task.
</system_reminder>`;
}

// =============================================================================

type ConfigEntry = {
	enabled: boolean;
	updatedAt: number;
};

type ReminderEntry = {
	tokens: number;
	contextWindow: number;
	reserveTokens: number;
	createdAt: number;
};

type ResetEntry = {
	createdAt: number;
};

function formatPercent(percent: number): string {
	return Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(1)}%`;
}

function formatTokens(tokens: number | null, contextWindow: number): string {
	const window = contextWindow.toLocaleString();
	return tokens === null ? `? / ${window} tokens` : `${Math.round(tokens).toLocaleString()} / ${window} tokens`;
}

function formatStatus(enabled: boolean, reminderFired: boolean, reserveTokens: number, ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	let usageText = "unknown";
	let thresholdText = `${reserveTokens.toLocaleString()} reserve tokens below the context window`;
	if (usage && usage.tokens !== null && usage.contextWindow > 0) {
		usageText = usageLabel(usage.tokens, usage.contextWindow);
		thresholdText = `${formatTokens(usage.contextWindow - reserveTokens, usage.contextWindow)} (compaction point)`;
	}
	return [
		"Token-window reminders",
		`Status: ${enabled ? "on" : "off"}`,
		`Fires at: ${thresholdText}`,
		`Reserve tokens (from settings): ${reserveTokens.toLocaleString()}`,
		`Current context usage: ${usageText}`,
		`Reminder fired this episode: ${reminderFired ? "yes" : "no"}`,
		"",
		"Usage:",
		"  /ctxwarn          Show this status",
		"  /ctxwarn status   Show this status",
		"  /ctxwarn on       Enable reminders",
		"  /ctxwarn off      Disable reminders",
		"  /ctxwarn reset    Clear the remembered fired state",
	].join("\n");
}

export default function tokenWindowReminder(pi: ExtensionAPI) {
	let enabled = DEFAULT_ENABLED;
	// Read from pi's global settings (fail-safe default) and refreshed on every
	// branch rebuild so the threshold always matches pi's actual compaction point.
	let reserveTokens = readReserveTokens();
	// True once we have warned for the current high-usage episode; re-armed when
	// usage drops back below the compaction point (e.g. after compaction).
	let reminderFired = false;
	// Set when context usage drops (compaction) after we had warned, so the next
	// turn announces the recovery once usage is known again.
	let recoveryPending = false;

	function persistConfig(nextEnabled: boolean): void {
		enabled = nextEnabled;
		reminderFired = false;
		recoveryPending = false;
		pi.appendEntry<ConfigEntry>(ENTRY_CONFIG, {
			enabled,
			updatedAt: Date.now(),
		});
	}

	function resetReminderState(): void {
		reminderFired = false;
		recoveryPending = false;
		pi.appendEntry<ResetEntry>(ENTRY_RESET, { createdAt: Date.now() });
	}

	function rebuildFromBranch(ctx: ExtensionContext): void {
		reserveTokens = readReserveTokens();
		enabled = DEFAULT_ENABLED;
		reminderFired = false;
		recoveryPending = false;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "compaction") {
				// Compaction shrinks the live context back down, so a reminder fired
				// before this point no longer reflects current usage. Re-arm.
				reminderFired = false;
				continue;
			}
			if (entry.type !== "custom") continue;
			switch (entry.customType) {
				case ENTRY_CONFIG: {
					const data = entry.data as ConfigEntry | undefined;
					if (!data) break;
					enabled = data.enabled;
					reminderFired = false;
					break;
				}
				case ENTRY_REMINDER: {
					reminderFired = true;
					break;
				}
				case ENTRY_RESET: {
					reminderFired = false;
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
		// pi compacts when contextTokens > contextWindow - reserveTokens.
		const threshold = usage.contextWindow - reserveTokens;

		// Announce recovery once usage is known again after a drop (e.g. compaction).
		if (recoveryPending) {
			recoveryPending = false;
			if (tokens < threshold) {
				reminderFired = false;
				deliver(renderRecovery(tokens, usage.contextWindow), ctx);
				return;
			}
			// Still at/over the threshold; fall through to (re-)warn below.
		}

		if (tokens < threshold) {
			// Below pi's compaction point: re-arm so the next crossing warns again.
			reminderFired = false;
			return;
		}

		// At or over pi's compaction point: pi will compact at this run's boundary.
		if (reminderFired) return;
		reminderFired = true;
		pi.appendEntry<ReminderEntry>(ENTRY_REMINDER, {
			tokens,
			contextWindow: usage.contextWindow,
			reserveTokens,
			createdAt: Date.now(),
		});

		deliver(renderWarning(tokens, usage.contextWindow), ctx);
	}

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
				ctx.ui.notify(formatStatus(enabled, reminderFired, reserveTokens, ctx), "info");
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
				`Unknown /ctxwarn argument.\n\n${formatStatus(enabled, reminderFired, reserveTokens, ctx)}`,
				"warning",
			);
		},
	});

	pi.on("turn_end", async (_event, ctx) => {
		maybeSendReminder(ctx);
	});

	pi.on("session_compact", async (_event, _ctx) => {
		// Compaction drops utilization. If we had warned, queue a recovery notice so
		// the model learns it has headroom again, and re-arm the warning.
		recoveryPending = reminderFired;
		reminderFired = false;
	});

	pi.on("session_start", async (_event, ctx) => {
		rebuildFromBranch(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		rebuildFromBranch(ctx);
	});
}
