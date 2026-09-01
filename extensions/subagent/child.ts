import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const delegatedPrompt = process.env.PI_SUBAGENT_SYSTEM_PROMPT || "";
const promptPath = process.env.PI_SUBAGENT_PROMPT_PATH;
const childSessionDir = process.env.PI_SUBAGENT_SESSION_DIR;
const childIncarnation = process.env.PI_SUBAGENT_INCARNATION;
const DEFAULT_HEALTH_WAIT_TIMEOUT_MS = 5_000;
const DEFAULT_HEALTH_POLL_INTERVAL_MS = 25;
const DEFAULT_CHILD_FILE_OPERATION_TIMEOUT_MS = 5_000;
const subagentDepth = Math.max(
	1,
	Number.parseInt(process.env.PI_SUBAGENT_DEPTH || "1", 10) || 1,
);

/** Out-of-band marker written after the child extension registers its hooks. */
export const CHILD_EXTENSION_HEALTH_SIGNAL =
	"pi-subagent-child-extension-ready/v1\n";
export const CHILD_EXTENSION_HEALTH_MAX_BYTES = 128;

/** Build the unique marker path that belongs to one child incarnation. */
export function childExtensionHealthPath(
	sessionDir: string,
	incarnation: string,
): string {
	return join(sessionDir, `child-extension-health-${incarnation}.marker`);
}

function abortError(): Error {
	const error = new Error("The child file operation was aborted.");
	error.name = "AbortError";
	return error;
}

function timeoutError(label: string): Error {
	const error = new Error(`Timed out during child file ${label}.`);
	error.name = "TimeoutError";
	return error;
}

function positiveTimeout(value: number | undefined): number {
	return Number.isFinite(value) && value !== undefined
		? Math.max(1, Math.floor(value))
		: DEFAULT_CHILD_FILE_OPERATION_TIMEOUT_MS;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

/** Race one child file operation against cancellation and a deadline. */
function boundedChildFileOperation<T>(
	operation: () => PromiseLike<T>,
	signal: AbortSignal | undefined,
	timeoutMs: number,
	label: string,
	onLateResolve?: (value: T) => void,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			callback();
		};
		const onAbort = () => finish(() => reject(abortError()));
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		timer = setTimeout(
			() => finish(() => reject(timeoutError(label))),
			positiveTimeout(timeoutMs),
		);
		timer.unref?.();
		let pending: PromiseLike<T>;
		try {
			pending = operation();
		} catch (error) {
			finish(() => reject(error));
			return;
		}
		void Promise.resolve(pending).then(
			(value) => {
				if (settled) {
					try {
						onLateResolve?.(value);
					} catch {
						// A late cleanup callback cannot escape the child extension.
					}
					return;
				}
				finish(() => resolve(value));
			},
			(error) => {
				if (!settled) finish(() => reject(error));
			},
		);
	});
}

async function readBoundedFile(
	path: string,
	maxBytes: number,
	signal?: AbortSignal,
	timeoutMs = DEFAULT_CHILD_FILE_OPERATION_TIMEOUT_MS,
): Promise<Buffer | undefined> {
	let file: Awaited<ReturnType<typeof fs.open>> | undefined;
	const closeLateFile = (lateFile: Awaited<ReturnType<typeof fs.open>>) => {
		void boundedChildFileOperation(
			() => lateFile.close(),
			undefined,
			timeoutMs,
			"close",
		).catch(() => {});
	};
	try {
		file = await boundedChildFileOperation(
			() => fs.open(path, "r"),
			signal,
			timeoutMs,
			"open",
			closeLateFile,
		);
		const stat = await boundedChildFileOperation(
			() => file!.stat(),
			signal,
			timeoutMs,
			"stat",
		);
		if (
			!stat.isFile() ||
			!Number.isSafeInteger(stat.size) ||
			stat.size < 0 ||
			stat.size > maxBytes
		)
			return undefined;
		const buffer = Buffer.allocUnsafe(maxBytes + 1);
		let bytesRead = 0;
		while (bytesRead < buffer.length) {
			const result = await boundedChildFileOperation(
				() =>
					file!.read(
						buffer,
						bytesRead,
						buffer.length - bytesRead,
						bytesRead,
					),
				signal,
				timeoutMs,
				"read",
			);
			if (result.bytesRead <= 0) break;
			bytesRead += result.bytesRead;
		}
		if (bytesRead > maxBytes) return undefined;
		return buffer.subarray(0, bytesRead);
	} finally {
		if (file) {
			const closeSignal = signal?.aborted ? undefined : signal;
			await boundedChildFileOperation(
				() => file!.close(),
				closeSignal,
				timeoutMs,
				"close",
			).catch(() => {});
		}
	}
}

/** Verify one exact, bounded child-extension health marker. */
export async function verifyChildExtensionHealth(
	path: string,
	signal?: AbortSignal,
	operationTimeoutMs?: number,
): Promise<boolean> {
	if (!path) return false;
	try {
		const content = await readBoundedFile(
			path,
			CHILD_EXTENSION_HEALTH_MAX_BYTES,
			signal,
			positiveTimeout(operationTimeoutMs),
		);
		return content?.toString("utf8") === CHILD_EXTENSION_HEALTH_SIGNAL;
	} catch (error) {
		if (isAbortError(error)) throw error;
		return false;
	}
}

async function bestEffortChildFileOperation(
	operation: () => PromiseLike<unknown>,
	signal: AbortSignal | undefined,
	timeoutMs: number,
	label: string,
): Promise<void> {
	try {
		await boundedChildFileOperation(operation, signal, timeoutMs, label);
	} catch (error) {
		if (isAbortError(error)) throw error;
	}
}

/** Publish the child-extension marker without writing anything to RPC stdout. */
export async function writeChildExtensionHealthSignal(
	path: string,
	signal?: AbortSignal,
	operationTimeoutMs?: number,
): Promise<boolean> {
	if (!path) return false;
	const timeoutMs = positiveTimeout(operationTimeoutMs);
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
	try {
		await boundedChildFileOperation(
			() => fs.mkdir(dirname(path), { recursive: true, mode: 0o700 }),
			signal,
			timeoutMs,
			"mkdir",
		);
		await bestEffortChildFileOperation(
			() => fs.chmod(dirname(path), 0o700),
			signal,
			timeoutMs,
			"chmod",
		);
		await boundedChildFileOperation(
			() =>
				fs.writeFile(temporary, CHILD_EXTENSION_HEALTH_SIGNAL, {
					encoding: "utf8",
					mode: 0o600,
				}),
			signal,
			timeoutMs,
			"write",
		);
		await bestEffortChildFileOperation(
			() => fs.chmod(temporary, 0o600),
			signal,
			timeoutMs,
			"chmod",
		);
		await boundedChildFileOperation(
			() => fs.rename(temporary, path),
			signal,
			timeoutMs,
			"rename",
		);
		await bestEffortChildFileOperation(
			() => fs.chmod(path, 0o600),
			signal,
			timeoutMs,
			"chmod",
		);
		return true;
	} catch (error) {
		if (isAbortError(error)) throw error;
		return false;
	} finally {
		await boundedChildFileOperation(
			() => fs.unlink(temporary),
			undefined,
			timeoutMs,
			"unlink",
		).catch(() => {});
	}
}

export interface ChildHealthWaitOptions {
	timeoutMs?: number;
	pollIntervalMs?: number;
	signal?: AbortSignal;
	operationTimeoutMs?: number;
}

/** Wait for a marker with bounded polling so startup can reject a missing hook. */
export async function waitForChildExtensionHealth(
	path: string,
	options: ChildHealthWaitOptions = {},
): Promise<boolean> {
	const timeoutMs = Number.isFinite(options.timeoutMs)
		? Math.max(0, Math.floor(options.timeoutMs ?? 0))
		: DEFAULT_HEALTH_WAIT_TIMEOUT_MS;
	const pollIntervalMs = Number.isFinite(options.pollIntervalMs)
		? Math.max(1, Math.floor(options.pollIntervalMs ?? 1))
		: DEFAULT_HEALTH_POLL_INTERVAL_MS;
	const operationTimeoutMs = positiveTimeout(options.operationTimeoutMs);
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (options.signal?.aborted) throw abortError();
		const remainingBeforeAttempt = Math.max(0, deadline - Date.now());
		const attemptTimeoutMs =
			remainingBeforeAttempt === 0
				? Math.min(operationTimeoutMs, 25)
				: Math.max(1, Math.min(operationTimeoutMs, remainingBeforeAttempt));
		if (
			await verifyChildExtensionHealth(
				path,
				options.signal,
				attemptTimeoutMs,
			)
		)
			return true;
		const remaining = deadline - Date.now();
		if (remaining <= 0) return false;
		await boundedChildFileOperation(
			() =>
				new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, Math.min(pollIntervalMs, remaining));
					timer.unref?.();
				}),
			options.signal,
			Math.min(pollIntervalMs, remaining),
			"health wait",
		);
	}
}

const childHealthPath =
	childSessionDir && childIncarnation
		? childExtensionHealthPath(childSessionDir, childIncarnation)
		: undefined;
let childFileController = new AbortController();

async function publishHealthSignal(signal = childFileController.signal): Promise<void> {
	if (!childHealthPath) return;
	try {
		if (
			await writeChildExtensionHealthSignal(
				childHealthPath,
				signal,
				DEFAULT_CHILD_FILE_OPERATION_TIMEOUT_MS,
			)
		)
			return;
	} catch (error) {
		if (isAbortError(error)) return;
		process.stderr.write(
			`Failed to publish child extension health signal at ${childHealthPath}: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		return;
	}
	if (!signal.aborted)
		process.stderr.write(
			`Failed to publish child extension health signal at ${childHealthPath}.\n`,
		);
}

async function captureEffectivePrompt(
	prompt: string,
	signal = childFileController.signal,
): Promise<void> {
	if (!promptPath) return;
	const timeoutMs = DEFAULT_CHILD_FILE_OPERATION_TIMEOUT_MS;
	try {
		await boundedChildFileOperation(
			() => fs.mkdir(dirname(promptPath), { recursive: true, mode: 0o700 }),
			signal,
			timeoutMs,
			"mkdir",
		);
		await bestEffortChildFileOperation(
			() => fs.chmod(dirname(promptPath), 0o700),
			signal,
			timeoutMs,
			"chmod",
		);
		await boundedChildFileOperation(
			() => fs.writeFile(promptPath, prompt, { encoding: "utf8", mode: 0o600 }),
			signal,
			timeoutMs,
			"write",
		);
		await bestEffortChildFileOperation(
			() => fs.chmod(promptPath, 0o600),
			signal,
			timeoutMs,
			"chmod",
		);
	} catch (error) {
		if (!isAbortError(error))
			process.stderr.write(
				`Failed to capture Pi effective system prompt: ${error instanceof Error ? error.message : String(error)}\n`,
			);
	}
}

function delegatedSystemPrompt(systemPrompt: string): string {
	const sections = [systemPrompt];
	if (delegatedPrompt.trim())
		sections.push(`Direct delegated guidance:\n${delegatedPrompt.trim()}`);
	sections.push(`Subagent execution rules:
- You are handling a delegated subtask for a parent agent.
- You are a subagent, not the top-level agent.
- Stay tightly scoped to the assigned task and return a definitive result.
- Prefer concise, high-signal findings over long narration.
- Never call subagent_start from within a subagent. Nested delegation is disabled. If further delegation seems necessary, tell the parent agent instead.
- Your final answer should be useful to another agent that did not watch your full run.
- Current delegated depth: ${subagentDepth}`);
	return sections.filter(Boolean).join("\n\n");
}

export default function childSubagentExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		childFileController.abort();
		childFileController = new AbortController();
		await publishHealthSignal(childFileController.signal);
		await captureEffectivePrompt(ctx.getSystemPrompt(), childFileController.signal);
	});

	pi.on("session_shutdown", async () => {
		childFileController.abort();
	});

	pi.on("agent_start", async (_event, ctx) => {
		await captureEffectivePrompt(ctx.getSystemPrompt(), childFileController.signal);
	});

	pi.on("before_agent_start", async (event) => {
		const systemPrompt = delegatedSystemPrompt(event.systemPrompt);
		await captureEffectivePrompt(systemPrompt, childFileController.signal);
		return { systemPrompt };
	});
}
