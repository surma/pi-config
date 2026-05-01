/**
 * RTK auto-rewrite for pi.
 *
 * Mutates `bash` tool calls in place via the `tool_call` event so the
 * rewritten command flows through whichever `bash` tool implementation is
 * registered (e.g. the managed-jobs replacement in bash-jobs.ts). Mirrors
 * the exit-code protocol of rtk's Claude Code hook
 * (hooks/claude/rtk-rewrite.sh):
 *
 *   0 + stdout  Rewrite found, no deny/ask rule matched -> use rewrite
 *   1           No RTK equivalent -> pass through unchanged
 *   2           Deny rule matched -> pass through (let pi's permission
 *               flow handle it)
 *   3 + stdout  Ask rule matched -> use rewrite (pi will prompt as usual)
 *
 * If rtk is missing or the call errors, leave the command untouched.
 */

import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function rewriteCommand(command: string): string {
	try {
		const result = spawnSync("rtk", ["rewrite", command], {
			encoding: "utf-8",
			timeout: 5000,
		});
		if (result.error || result.status === null) return command;
		if (result.status === 0 || result.status === 3) {
			const rewritten = (result.stdout ?? "").trim();
			if (rewritten.length === 0 || rewritten === command) return command;
			// Force C locale: rtk's parsers expect ASCII output (numbers,
			// dates, error messages) and break on locale-translated tooling.
			return `LC_ALL=C ${rewritten}`;
		}
		return command;
	} catch {
		return command;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return;
		const input = event.input as { command?: string } | undefined;
		if (!input || typeof input.command !== "string" || input.command.length === 0) return;
		input.command = rewriteCommand(input.command);
	});
}
