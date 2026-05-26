import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ENTRY_CONFIG = "token-window-reminder-config";
const ENTRY_REMINDER = "token-window-reminder-fired";
const ENTRY_RESET = "token-window-reminder-reset";

const DEFAULT_ENABLED = true;
const DEFAULT_START_PERCENT = 80;
const STEP_PERCENT = 10;
const MIN_START_PERCENT = 1;
const MAX_START_PERCENT = 99;

type ConfigEntry = {
	enabled: boolean;
	startPercent: number;
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

type Config = {
	enabled: boolean;
	startPercent: number;
};

function defaultConfig(): Config {
	return { enabled: DEFAULT_ENABLED, startPercent: DEFAULT_START_PERCENT };
}

function clampStartPercent(percent: number): number {
	return Math.max(MIN_START_PERCENT, Math.min(MAX_START_PERCENT, Math.round(percent)));
}

function parseStartPercent(input: string): number | undefined {
	const normalized = input.trim().replace(/%$/, "");
	if (!/^\d+(?:\.\d+)?$/.test(normalized)) return undefined;
	const parsed = Number(normalized);
	if (!Number.isFinite(parsed)) return undefined;
	return clampStartPercent(parsed);
}

function nextThresholdAtOrBelow(usagePercent: number, startPercent: number): number | undefined {
	if (usagePercent < startPercent) return undefined;
	const highestThreshold = startPercent + Math.floor((MAX_START_PERCENT - startPercent) / STEP_PERCENT) * STEP_PERCENT;
	const steps = Math.floor((usagePercent - startPercent) / STEP_PERCENT);
	return Math.min(startPercent + steps * STEP_PERCENT, highestThreshold);
}

function formatPercent(percent: number): string {
	return Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(1)}%`;
}

function formatTokens(tokens: number | null, contextWindow: number): string {
	const window = contextWindow.toLocaleString();
	return tokens === null ? `? / ${window} tokens` : `${Math.round(tokens).toLocaleString()} / ${window} tokens`;
}

function renderReminder(threshold: number, usage: NonNullable<ReturnType<ExtensionContext["getContextUsage"]>>): string {
	const usagePercent = usage.percent ?? threshold;
	return `<system_reminder>
Your token window is at ${formatPercent(usagePercent)} (${formatTokens(usage.tokens, usage.contextWindow)}), crossing the ${formatPercent(threshold)} reminder threshold.
Please find a yielding point to ask the user how to continue.
</system_reminder>`;
}

function formatStatus(config: Config, lastThreshold: number | undefined, ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	const usageText =
		usage && usage.percent !== null
			? `${formatPercent(usage.percent)} (${formatTokens(usage.tokens, usage.contextWindow)})`
			: "unknown";
	const lastText = lastThreshold === undefined ? "none" : formatPercent(lastThreshold);
	return [
		"Token-window reminders",
		`Status: ${config.enabled ? "on" : "off"}`,
		`Start threshold: ${formatPercent(config.startPercent)}`,
		`Step: ${STEP_PERCENT}%`,
		`Current context usage: ${usageText}`,
		`Last reminder threshold: ${lastText}`,
		"",
		"Usage:",
		"  /ctxwarn              Show this status",
		"  /ctxwarn status       Show this status",
		"  /ctxwarn <percent>    Enable reminders starting at <percent>",
		"  /ctxwarn on           Enable reminders",
		"  /ctxwarn off          Disable reminders",
		"  /ctxwarn reset        Clear remembered fired thresholds",
	].join("\n");
}

export default function tokenWindowReminder(pi: ExtensionAPI) {
	let config = defaultConfig();
	let lastReminderThreshold: number | undefined;

	function persistConfig(nextConfig: Config): void {
		config = nextConfig;
		lastReminderThreshold = undefined;
		pi.appendEntry<ConfigEntry>(ENTRY_CONFIG, {
			enabled: config.enabled,
			startPercent: config.startPercent,
			updatedAt: Date.now(),
		});
	}

	function resetReminderState(): void {
		lastReminderThreshold = undefined;
		pi.appendEntry<ResetEntry>(ENTRY_RESET, { createdAt: Date.now() });
	}

	function rebuildFromBranch(ctx: ExtensionContext): void {
		config = defaultConfig();
		lastReminderThreshold = undefined;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;
			switch (entry.customType) {
				case ENTRY_CONFIG: {
					const data = entry.data as ConfigEntry | undefined;
					if (!data) break;
					config = {
						enabled: data.enabled,
						startPercent: clampStartPercent(data.startPercent),
					};
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

	function maybeSendReminder(ctx: ExtensionContext): void {
		if (!config.enabled) return;

		const usage = ctx.getContextUsage();
		if (!usage || usage.percent === null) return;

		const threshold = nextThresholdAtOrBelow(usage.percent, config.startPercent);
		if (threshold === undefined) return;
		if (lastReminderThreshold !== undefined && threshold <= lastReminderThreshold) return;

		lastReminderThreshold = threshold;
		pi.appendEntry<ReminderEntry>(ENTRY_REMINDER, {
			threshold,
			usagePercent: usage.percent,
			tokens: usage.tokens,
			contextWindow: usage.contextWindow,
			createdAt: Date.now(),
		});

		const reminder = renderReminder(threshold, usage);
		try {
			if (ctx.isIdle()) {
				pi.sendUserMessage(reminder);
			} else {
				pi.sendUserMessage(reminder, { deliverAs: "steer" });
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI) ctx.ui.notify(`Token-window reminder failed: ${message}`, "warning");
		}
	}

	pi.registerCommand("ctxwarn", {
		description: "Configure token-window reminder steering messages",
		getArgumentCompletions: (prefix) => {
			const values = ["status", "on", "off", "reset", "70", "80", "90"];
			const filtered = values.filter((value) => value.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim().toLowerCase();

			if (!trimmed || trimmed === "status") {
				ctx.ui.notify(formatStatus(config, lastReminderThreshold, ctx), "info");
				return;
			}

			if (trimmed === "on") {
				persistConfig({ ...config, enabled: true });
				ctx.ui.notify(`Token-window reminders enabled from ${formatPercent(config.startPercent)}.`, "info");
				maybeSendReminder(ctx);
				return;
			}

			if (trimmed === "off") {
				persistConfig({ ...config, enabled: false });
				ctx.ui.notify("Token-window reminders disabled.", "info");
				return;
			}

			if (trimmed === "reset") {
				resetReminderState();
				ctx.ui.notify("Token-window reminder thresholds reset.", "info");
				maybeSendReminder(ctx);
				return;
			}

			const startPercent = parseStartPercent(trimmed);
			if (startPercent === undefined) {
				ctx.ui.notify(`Unknown /ctxwarn argument.\n\n${formatStatus(config, lastReminderThreshold, ctx)}`, "warning");
				return;
			}

			persistConfig({ enabled: true, startPercent });
			ctx.ui.notify(`Token-window reminders enabled from ${formatPercent(config.startPercent)}.`, "info");
			maybeSendReminder(ctx);
		},
	});

	pi.on("turn_end", async (_event, ctx) => {
		maybeSendReminder(ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		rebuildFromBranch(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		rebuildFromBranch(ctx);
	});
}
