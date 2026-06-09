/**
 * Agent-done notification.
 *
 * Fires `noti local "Agent is done"` (and, when mobile mode is enabled, also
 * `noti mobile "Agent is done"`) when the agent genuinely stops — not when it's
 * only momentarily idle between
 * auto-continuations or busy compacting.
 *
 * The hard part is deciding what "done" means. Two things keep the agent going
 * after an `agent_end` event, and neither should trigger a notification:
 *
 *   1. The `goal` extension re-fires the loop on every `agent_end` (it schedules
 *      a continuation as soon as pi goes idle). So `agent_end` alone never means
 *      "done" while a goal is active.
 *   2. Auto-compaction runs at a run boundary (after `agent_end`). During
 *      compaction `ctx.isIdle()` returns true — compaction is tracked
 *      separately and does not count as streaming — so a plain idle check would
 *      mistake a mid-goal compaction for completion.
 *
 * Strategy: arm a short idle-grace timer on `agent_end`; when it fires, notify
 * only if the agent is genuinely idle with nothing queued.
 *
 *   - Goal case: the continuation re-fires the loop within milliseconds, so by
 *     the time the timer fires the agent is busy again and the idle guard
 *     suppresses it. (The full-length continuation turn usually outlasts the
 *     grace window, so the timer DOES fire mid-goal — the idle guard, not the
 *     debounce, is what suppresses it. Re-arming only matters for the rare
 *     turn shorter than the grace window.)
 *   - Compaction case: pause the timer when compaction starts and re-arm it
 *     when compaction finishes. After compaction either a goal continuation
 *     resumes (idle guard suppresses) or the agent is genuinely done (notify).
 *   - Abort case: if the user pressed Escape (`ctx.signal.aborted` at
 *     `agent_end`), the agent was interrupted, not done — don't arm at all.
 */

import { execFile } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// The notification command is `noti <target> "<message>"`. Local notifications
// always fire; mobile mode adds a second `noti mobile` notification.
type NotiTarget = "local" | "mobile";
const NOTI_MESSAGE = "Agent is done";

// How long the agent must stay idle after agent_end / compaction before we
// consider it done. Must comfortably exceed the gap between goal
// auto-continuations (sub-second).
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
	let mobileEnabled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	// Set when compaction interrupts a pending notification, so we know to
	// resume watching for idle once compaction finishes (vs. a manual /compact
	// while idle, which should not produce a notification).
	let rearmAfterCompact = false;

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
				ctx.ui.notify("Agent-done notifications will use `noti local` and `noti mobile`.", "info");
				return;
			}

			if (trimmed === "mobile disable") {
				mobileEnabled = false;
				ctx.ui.notify("Agent-done notifications will use `noti local` only.", "info");
				return;
			}

			ctx.ui.notify(`Unknown /noti command.\n\n${formatStatus(mobileEnabled)}`, "warning");
		},
	});

	pi.on("agent_end", async (_event, ctx) => {
		// User pressed Escape: interrupted, not done — don't notify. (Also drops
		// any timer from a prior agent_end; the abort is the latest signal.)
		if (ctx.signal?.aborted) {
			cancel();
			return;
		}
		// Re-arm on every agent_end. A pending goal continuation will produce
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

	pi.on("session_shutdown", async () => {
		cancel();
	});
}
