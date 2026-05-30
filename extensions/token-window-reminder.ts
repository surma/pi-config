import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ENTRY_CONFIG = "token-window-reminder-config";
const ENTRY_REMINDER = "token-window-reminder-fired";
const ENTRY_RESET = "token-window-reminder-reset";

const DEFAULT_ENABLED = true;

// =============================================================================
// Editable knobs
// =============================================================================
//
// The context-window utilization percentages (ascending) at which a reminder
// fires as usage climbs. Each threshold fires once until usage drops back below
// the lowest threshold (e.g. after compaction), at which point they re-arm.
const REMINDER_THRESHOLDS = [80, 90, 95];

// Renders the steering message shown to the model. Tone escalates with
// "pressure" (the current utilization): below the lowest threshold the context
// has freed up again (relaxed); the higher it climbs, the more urgent. Edit the
// wording freely.
function renderReminder(percent: number, tokens: number | null, contextWindow: number): string {
	const usage = `${formatPercent(percent)} (${formatTokens(tokens, contextWindow)})`;
	const crossed = REMINDER_THRESHOLDS.filter((threshold) => percent >= threshold).length;

	// Low pressure: context just freed up (e.g. after compaction).
	if (crossed === 0) {
		return `<system_reminder>
Good news: your context window has freed up and is now at ${usage}. You have plenty of headroom again.
Disregard any earlier reminders about running low on context — there is no need to yield or wrap up for context-size reasons. Carry on with the task.
</system_reminder>`;
	}

	// The hand-off the model should record before it yields, so nothing is lost
	// when the context is compacted.
	const handoff = `Before you yield, write down a concise hand-off so no context is lost when this conversation is compacted:
- The overarching goal you are working toward.
- What you are doing right now.
- What you intend to do next.
- Any key decisions, constraints, file paths, or facts needed to resume.`;

	// Medium pressure: nudge toward wrapping up.
	if (crossed === 1) {
		return `<system_reminder>
Heads up: your context window is filling up — currently at ${usage}.
Start looking for a natural place to pause and hand back to the user. ${handoff}
</system_reminder>`;
	}

	// High pressure: yield now.
	return `<system_reminder>
Your context window is at ${usage} and is close to its limit. Stop taking on new work and yield back to the user at the next safe point.
${handoff}
</system_reminder>`;
}

// =============================================================================

type ConfigEntry = {
	enabled: boolean;
	updatedAt: number;
};

type ReminderEntry = {
	threshold: number;
	usagePercent: number;
	tokens: number | null;
	contextWindow: number;
	createdAt: number;
};

type ResetEntry = {
	createdAt: number;
};

function lowestThreshold(): number | undefined {
	return REMINDER_THRESHOLDS.length > 0 ? Math.min(...REMINDER_THRESHOLDS) : undefined;
}

function highestThresholdAtOrBelow(percent: number): number | undefined {
	let result: number | undefined;
	for (const threshold of REMINDER_THRESHOLDS) {
		if (percent >= threshold && (result === undefined || threshold > result)) result = threshold;
	}
	return result;
}

function formatPercent(percent: number): string {
	return Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(1)}%`;
}

function formatTokens(tokens: number | null, contextWindow: number): string {
	const window = contextWindow.toLocaleString();
	return tokens === null ? `? / ${window} tokens` : `${Math.round(tokens).toLocaleString()} / ${window} tokens`;
}

function formatStatus(enabled: boolean, lastThreshold: number | undefined, ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	const usageText =
		usage && usage.percent !== null
			? `${formatPercent(usage.percent)} (${formatTokens(usage.tokens, usage.contextWindow)})`
			: "unknown";
	const lastText = lastThreshold === undefined ? "none" : formatPercent(lastThreshold);
	return [
		"Token-window reminders",
		`Status: ${enabled ? "on" : "off"}`,
		`Thresholds: ${REMINDER_THRESHOLDS.map(formatPercent).join(", ")}`,
		`Current context usage: ${usageText}`,
		`Last reminder threshold: ${lastText}`,
		"",
		"Usage:",
		"  /ctxwarn          Show this status",
		"  /ctxwarn status   Show this status",
		"  /ctxwarn on       Enable reminders",
		"  /ctxwarn off      Disable reminders",
		"  /ctxwarn reset    Clear remembered fired thresholds",
	].join("\n");
}

export default function tokenWindowReminder(pi: ExtensionAPI) {
	let enabled = DEFAULT_ENABLED;
	let lastReminderThreshold: number | undefined;
	// Set when context usage drops (compaction) after we had warned, so the next
	// turn announces the recovery once usage is known again.
	let recoveryPending = false;

	function persistConfig(nextEnabled: boolean): void {
		enabled = nextEnabled;
		lastReminderThreshold = undefined;
		recoveryPending = false;
		pi.appendEntry<ConfigEntry>(ENTRY_CONFIG, {
			enabled,
			updatedAt: Date.now(),
		});
	}

	function resetReminderState(): void {
		lastReminderThreshold = undefined;
		recoveryPending = false;
		pi.appendEntry<ResetEntry>(ENTRY_RESET, { createdAt: Date.now() });
	}

	function rebuildFromBranch(ctx: ExtensionContext): void {
		enabled = DEFAULT_ENABLED;
		lastReminderThreshold = undefined;
		recoveryPending = false;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "compaction") {
				// Compaction shrinks the live context back down, so any thresholds fired
				// before this point no longer reflect current usage. Treat it as a reset.
				lastReminderThreshold = undefined;
				continue;
			}
			if (entry.type !== "custom") continue;
			switch (entry.customType) {
				case ENTRY_CONFIG: {
					const data = entry.data as ConfigEntry | undefined;
					if (!data) break;
					enabled = data.enabled;
					lastReminderThreshold = undefined;
					break;
				}
				case ENTRY_REMINDER: {
					const data = entry.data as ReminderEntry | undefined;
					if (!data || typeof data.threshold !== "number") break;
					lastReminderThreshold = Math.max(lastReminderThreshold ?? 0, data.threshold);
					break;
				}
				case ENTRY_RESET: {
					lastReminderThreshold = undefined;
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
		if (!usage || usage.percent === null) return;
		const percent = usage.percent;

		// Announce recovery once usage is known again after a drop (e.g. compaction).
		if (recoveryPending) {
			recoveryPending = false;
			const floor = lowestThreshold();
			if (floor !== undefined && percent < floor) {
				deliver(renderReminder(percent, usage.tokens, usage.contextWindow), ctx);
				return;
			}
			// Not enough headroom was freed; fall through to normal warning logic.
		}

		const threshold = highestThresholdAtOrBelow(percent);
		if (threshold === undefined) return;
		if (lastReminderThreshold !== undefined && threshold <= lastReminderThreshold) return;

		lastReminderThreshold = threshold;
		pi.appendEntry<ReminderEntry>(ENTRY_REMINDER, {
			threshold,
			usagePercent: percent,
			tokens: usage.tokens,
			contextWindow: usage.contextWindow,
			createdAt: Date.now(),
		});

		deliver(renderReminder(percent, usage.tokens, usage.contextWindow), ctx);
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
				ctx.ui.notify(formatStatus(enabled, lastReminderThreshold, ctx), "info");
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
				ctx.ui.notify("Token-window reminder thresholds reset.", "info");
				maybeSendReminder(ctx);
				return;
			}

			ctx.ui.notify(`Unknown /ctxwarn argument.\n\n${formatStatus(enabled, lastReminderThreshold, ctx)}`, "warning");
		},
	});

	pi.on("turn_end", async (_event, ctx) => {
		maybeSendReminder(ctx);
	});

	pi.on("session_compact", async (_event, _ctx) => {
		// Compaction drops utilization. If we had warned, queue a recovery notice so
		// the model learns it has headroom again, and re-arm the warning thresholds.
		recoveryPending = lastReminderThreshold !== undefined;
		lastReminderThreshold = undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		rebuildFromBranch(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		rebuildFromBranch(ctx);
	});
}
