/**
 * Agent-done notification.
 *
 * Fires `noti local "Agent is done"` (and, when mobile mode is enabled, also
 * `noti mobile "Agent is done"`) when the agent genuinely stops — not when it's
 * only momentarily idle between
 * auto-continuations or busy compacting.
 *
 * The hard part is deciding what "done" means. Two things can keep the agent
 * active near an `agent_end` event, and neither should trigger a notification:
 *
 *   1. A successful `compaction_handoff` can queue one follow-up user message
 *      before settlement. So `agent_end` alone does not always mean "done".
 *   2. Auto-compaction runs at a run boundary (after `agent_end`). During
 *      compaction `ctx.isIdle()` returns true — compaction is tracked
 *      separately and does not count as streaming — so a plain idle check would
 *      mistake compaction for completion.
 *
 * Strategy: arm a short idle-grace timer on `agent_end`; when it fires, notify
 * only if the agent is genuinely idle with nothing queued.
 *
 *   - Handoff case: the follow-up message queues before the agent settles, so
 *     the agent is busy again and the idle guard suppresses notification.
 *   - Compaction case: pause the timer when compaction starts and re-arm it
 *     when compaction finishes. After compaction the agent is either busy or
 *     genuinely done.
 *   - Abort case: if the user pressed Escape (`ctx.signal.aborted` at
 *     `agent_end`), the agent was interrupted, not done — do not arm at all.
 */

import { execFile } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// The notification command is `noti <target> "<message>"`. Local notifications
// always fire; mobile mode adds a second `noti mobile` notification.
type NotiTarget = "local" | "mobile";
const NOTI_MESSAGE = "Agent is done";
const STATUS_KEY = "agent-done-noti";

// How long the agent must stay idle after agent_end or compaction before we
// consider it done. The delay covers queued handoff continuations.
const IDLE_GRACE_MS = 2000;

function formatStatus(mobileEnabled: boolean): string {
	return [
		"Agent-done notifications",
		"Local target: noti local (always)",
		`Mobile target: ${mobileEnabled ? "enabled (noti mobile in addition)" : "disabled"}`,
		"Usage:",
		"  /noti status",
		"  /noti mobile enable",
		"  /noti mobile disable",
	].join("\n");
}

export default function agentDoneNoti(pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	let mobileEnabled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	// Set when compaction interrupts a pending notification, so we know to
	// resume watching for idle once compaction finishes (vs. a manual /compact
	// while idle, which should not produce a notification).
	let rearmAfterCompact = false;

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(STATUS_KEY, mobileEnabled ? "noti:on" : "noti:off");
	}

	function cancel(): void {
		if (timer === undefined) return;
		clearTimeout(timer);
		timer = undefined;
	}

	function runNoti(target: NotiTarget): void {
		execFile("noti", [target, NOTI_MESSAGE], () => {
			// Fire-and-forget; ignore errors (e.g. noti not installed).
		});
	}

	function arm(ctx: ExtensionContext): void {
		cancel();
		timer = setTimeout(() => {
			timer = undefined;
			try {
				// Still idle with nothing queued => the agent really stopped.
				if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
			} catch {
				// Runtime may have been reloaded while the timer was pending.
				return;
			}
			runNoti("local");
			if (mobileEnabled) runNoti("mobile");
		}, IDLE_GRACE_MS);
	}

	pi.registerCommand("noti", {
		description: "Configure agent-done notifications. Subcommands: status | mobile enable | mobile disable",
		handler: async (args, ctx) => {
			const trimmed = args.trim().toLowerCase();
			if (!trimmed || trimmed === "status" || trimmed === "mobile") {
				ctx.ui.notify(formatStatus(mobileEnabled), "info");
				return;
			}

			if (trimmed === "mobile enable") {
				mobileEnabled = true;
				updateStatus(ctx);
				ctx.ui.notify("Agent-done notifications will use `noti local` and `noti mobile`.", "info");
				return;
			}

			if (trimmed === "mobile disable") {
				mobileEnabled = false;
				updateStatus(ctx);
				ctx.ui.notify("Agent-done notifications will use `noti local` only.", "info");
				return;
			}

			ctx.ui.notify(`Unknown /noti command.\n\n${formatStatus(mobileEnabled)}`, "warning");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		// User pressed Escape: interrupted, not done — don't notify. (Also drops
		// any timer from a prior agent_end; the abort is the latest signal.)
		if (ctx.signal?.aborted) {
			cancel();
			return;
		}
		// Re-arm on every agent_end. A pending handoff continuation produces
		// another agent_end shortly, resetting this before it can fire.
		arm(ctx);
	});

	// Compaction (after agent_end) is not "done" — pause until it finishes.
	pi.on("session_before_compact", async () => {
		rearmAfterCompact = timer !== undefined;
		cancel();
	});

	pi.on("session_compact", async (_event, ctx) => {
		if (!rearmAfterCompact) return;
		rearmAfterCompact = false;
		arm(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		cancel();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
