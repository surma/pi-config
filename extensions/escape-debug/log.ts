/**
 * Shared append-only diagnostic logger for the escape-debug investigation.
 *
 * This file is NOT auto-loaded as an extension because it does not export a
 * default extension factory and is not the `index.ts` of this subdirectory.
 * It is consumed by:
 *   - extensions/escape-debug/index.ts   (the diagnostic extension itself)
 *   - extensions/bash-jobs.ts            (logs signal/abort lifecycle)
 *   - extensions/goal.ts                 (logs scheduling/continuation lifecycle)
 *
 * Logs go to a single file so timelines from different modules can be
 * correlated by timestamp. Path: $PI_ESCAPE_DEBUG_LOG or ~/.pi/agent/escape-debug.log.
 *
 * Writes are synchronous (appendFileSync) so we don't lose data on a crash
 * or hard exit (Ctrl+D). One JSON object per line. Each line contains both
 * wall-clock and monotonic-ish timestamps so we can order events tightly
 * even when wall-clock jumps.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_PATH = join(homedir(), ".pi", "agent", "escape-debug.log");
const ROTATE_BYTES = 50 * 1024 * 1024; // 50 MB — rotate to .1 then start fresh
const KEPT_ROTATIONS = 3;

const logPath = process.env.PI_ESCAPE_DEBUG_LOG || DEFAULT_PATH;
const sessionPid = process.pid;
// Share the session id across multiple imports of this module within the
// same pi process. Jiti / ESM caching may load this module per-extension,
// which would otherwise produce different ids and make correlation harder.
const SESSION_ID_GLOBAL_KEY = "__PI_ESCAPE_DEBUG_SESSION_ID__";
const processGlobal = process as unknown as Record<string, unknown>;
let sessionId = processGlobal[SESSION_ID_GLOBAL_KEY] as string | undefined;
if (!sessionId) {
	sessionId = `${sessionPid}-${process.hrtime.bigint().toString(36)}`;
	processGlobal[SESSION_ID_GLOBAL_KEY] = sessionId;
}

let rotateChecked = false;
let lastFailureWarned = false;

function ensureDir(): void {
	try {
		const dir = dirname(logPath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	} catch {
		// ignore
	}
}

function rotateIfNeeded(): void {
	if (rotateChecked) return;
	rotateChecked = true;
	try {
		if (!existsSync(logPath)) return;
		const size = statSync(logPath).size;
		if (size < ROTATE_BYTES) return;
		// Rotate .N-1 → .N, ... .1 → .2, current → .1
		for (let i = KEPT_ROTATIONS; i >= 1; i--) {
			const from = i === 1 ? logPath : `${logPath}.${i - 1}`;
			const to = `${logPath}.${i}`;
			if (existsSync(from)) {
				try {
					renameSync(from, to);
				} catch {
					// ignore
				}
			}
		}
	} catch {
		// ignore
	}
}

function writeLine(obj: Record<string, unknown>): void {
	try {
		appendFileSync(logPath, `${JSON.stringify(obj)}\n`, { encoding: "utf8" });
	} catch (err) {
		if (!lastFailureWarned) {
			lastFailureWarned = true;
			try {
				process.stderr.write(`escape-debug log write failed: ${(err as Error)?.message ?? err}\n`);
			} catch {
				// ignore
			}
		}
	}
}

ensureDir();
rotateIfNeeded();

// Boot record so we can find session boundaries in the log.
writeLine({
	ts: new Date().toISOString(),
	hr: process.hrtime.bigint().toString(),
	tag: "BOOT",
	event: "module_loaded",
	pid: sessionPid,
	sessionId,
	cwd: process.cwd(),
	argv: process.argv,
	logPath,
	nodeVersion: process.version,
});

/**
 * Append one diagnostic record to the shared log.
 *
 * `tag` groups records by module (INPUT, STATE, AGENT, TOOL, BASH, GOAL, ESCAPE, …)
 * so they can be filtered with `jq` or grep.
 *
 * `event` is a short symbolic name within that tag.
 *
 * `data` is any extra structured context (signal state, args, etc.).
 */
export function dlog(tag: string, event: string, data?: Record<string, unknown>): void {
	writeLine({
		ts: new Date().toISOString(),
		hr: process.hrtime.bigint().toString(),
		pid: sessionPid,
		sessionId,
		tag,
		event,
		...(data ?? {}),
	});
}

/**
 * Get a short, ANSI-safe representation of a key/input sequence so the log
 * stays readable in `cat`/`less`. Returns both raw codepoints and a printable
 * form.
 */
export function describeInput(data: string): { len: number; hex: string; printable: string; isEscape: boolean } {
	const codes: string[] = [];
	let printable = "";
	for (let i = 0; i < data.length; i++) {
		const code = data.charCodeAt(i);
		codes.push(code.toString(16).padStart(2, "0"));
		if (code < 0x20 || code === 0x7f) {
			printable += `\\x${code.toString(16).padStart(2, "0")}`;
		} else {
			printable += data[i];
		}
	}
	const isEscape =
		data === "\x1b" ||
		data === "\x1b\x1b" ||
		(data.startsWith("\x1b[") && /^\x1b\[27(?:;\d+)?(?::\d+)?u$/.test(data));
	return { len: data.length, hex: codes.join(" "), printable, isEscape };
}

export const ESCAPE_DEBUG_LOG_PATH = logPath;
