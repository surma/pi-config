import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { BashToolDetails, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	createBashToolDefinition,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateTail,
} from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { dlog } from "./escape-debug/log.js";

const LOG_DIR = join(tmpdir(), "pi-bash-jobs");
const MAX_TAIL_BUFFER_BYTES = DEFAULT_MAX_BYTES * 2;
const DEFAULT_MAX_LOG_BYTES = 4 * 1024 * 1024 * 1024;
const FALLBACK_BASH_TIMEOUT_SECONDS = 10;
const BASH_UPDATE_THROTTLE_MS = 100;
const COMMAND_PREVIEW_MAX_CHARS = 160;
const STALL_CHECK_INTERVAL_MS = 5_000;
const STALL_THRESHOLD_MS = 45_000;
const COMPLETION_NOTIFICATION_BATCH_MS = 50;

const PROMPT_PATTERNS = [
	/\(y\/n\)/i,
	/\[y\/n\]/i,
	/\(yes\/no\)/i,
	/\b(?:Do you|Would you|Shall I|Are you sure|Ready to)\b.*\?\s*$/i,
	/Press (?:any key|Enter)/i,
	/Continue\?/i,
	/Overwrite\?/i,
] as const;

type JobStatus = "running" | "completed" | "failed" | "killed";

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
};

type BashJob = {
	jobId: string;
	command: string;
	cwd: string;
	pid: number | undefined;
	status: JobStatus;
	startedAt: number;
	endedAt?: number;
	exitCode?: number | null;
	outputPath: string;
	totalBytes: number;
	lastOutputAt: number;
	interactiveStall: boolean;
	stallSummary?: string;
	killedForLogLimit: boolean;
	killRequested: boolean;
	logStream: ReturnType<typeof createWriteStream>;
	outputListeners: Set<() => void>;
	chunks: Buffer[];
	chunksBytes: number;
	completion: Deferred<void>;
	stallTimer?: NodeJS.Timeout;
	finalized: boolean;
	detached: boolean;
	completionNotificationSuppressed: boolean;
	completionNotificationQueued: boolean;
	completionNotificationSent: boolean;
};

type TailState = {
	text: string;
	truncated: boolean;
	truncation: ReturnType<typeof truncateTail>;
};

type BashToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details?: BashToolDetails;
};

type CompletedJobResult = {
	text: string;
	details?: BashToolDetails;
	status: Exclude<JobStatus, "running">;
	exitCode?: number | null;
};

const defaultBashTimeoutSeconds = loadDefaultBashTimeoutSeconds();

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for this command (relative to the current working directory if not absolute)" })),
	timeout: Type.Optional(Type.Number({ minimum: 1, description: `Timeout in seconds (defaults to ${defaultBashTimeoutSeconds}; soft timeout: command keeps running if exceeded)` })),
});

const jobIdSchema = Type.Object({
	jobId: Type.String({ description: "Managed bash job id" }),
});

const jobs = new Map<string, BashJob>();
let maxLogBytes = DEFAULT_MAX_LOG_BYTES;

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function ensureLogDir(): void {
	mkdirSync(LOG_DIR, { recursive: true });
}

function parsePositiveNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return value;
	}
	if (typeof value !== "string") return undefined;
	const parsed = Number(value.trim());
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseByteSize(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return Math.floor(value);
	}
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim().toLowerCase();
	const match = /^(\d+(?:\.\d+)?)\s*(b|k|kb|m|mb|g|gb|t|tb)?$/.exec(trimmed);
	if (!match) return undefined;
	const amount = Number(match[1]);
	const unit = match[2] ?? "b";
	const multiplier =
		unit === "b"
			? 1
			: unit === "k" || unit === "kb"
				? 1024
				: unit === "m" || unit === "mb"
					? 1024 ** 2
					: unit === "g" || unit === "gb"
						? 1024 ** 3
						: 1024 ** 4;
	const bytes = amount * multiplier;
	return Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : undefined;
}

function loadMaxLogBytes(): number {
	return parseByteSize(process.env.PI_BASH_JOBS_MAX_LOG_BYTES) ?? DEFAULT_MAX_LOG_BYTES;
}

function loadDefaultBashTimeoutSeconds(): number {
	return parsePositiveNumber(process.env.PI_BASH_JOBS_DEFAULT_TIMEOUT_SECONDS) ?? FALLBACK_BASH_TIMEOUT_SECONDS;
}

function createJobId(): string {
	return `job_${randomBytes(4).toString("hex")}`;
}

function createLogPath(jobId: string): string {
	ensureLogDir();
	return join(LOG_DIR, `${jobId}.log`);
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

function formatStartedAt(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString();
}

function collapseWhitespace(input: string): string {
	return input.replace(/\s+/g, " ").trim();
}

function truncateForDisplay(input: string, maxChars: number): string {
	if (input.length <= maxChars) return input;
	return `${input.slice(0, maxChars - 1)}…`;
}

function formatCommandPreview(command: string): string {
	return truncateForDisplay(collapseWhitespace(command), COMMAND_PREVIEW_MAX_CHARS);
}

function shellPath(): string {
	return process.env.SHELL || "/bin/sh";
}

function shellArgs(command: string): string[] {
	return ["-lc", command];
}

function resolveCommandCwd(baseCwd: string, cwd: string | undefined): string {
	if (!cwd) return baseCwd;
	const normalized = cwd.startsWith("@") ? cwd.slice(1) : cwd;
	return isAbsolute(normalized) ? normalized : resolve(baseCwd, normalized);
}

function looksLikePrompt(text: string): boolean {
	const lastLine = text.trimEnd().split("\n").pop() ?? "";
	return PROMPT_PATTERNS.some((pattern) => pattern.test(lastLine));
}

function appendChunk(job: BashJob, chunk: Buffer): void {
	job.totalBytes += chunk.length;
	job.lastOutputAt = Date.now();
	job.chunks.push(chunk);
	job.chunksBytes += chunk.length;
	while (job.chunksBytes > MAX_TAIL_BUFFER_BYTES && job.chunks.length > 1) {
		const removed = job.chunks.shift();
		if (removed) job.chunksBytes -= removed.length;
	}
}

function getTailState(job: BashJob): TailState {
	const text = Buffer.concat(job.chunks).toString("utf8");
	const truncation = truncateTail(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	return {
		text: truncation.content || "",
		truncated: truncation.truncated || job.totalBytes > DEFAULT_MAX_BYTES,
		truncation,
	};
}

function formatRunningMessage(job: BashJob, tail = getTailState(job)): string {
	const lines = [
		`Command is still running as managed bash job ${job.jobId}.`,
		`Command: ${job.command}`,
		`Started: ${formatStartedAt(job.startedAt)} (${formatDuration(Date.now() - job.startedAt)} elapsed)`,
		`PID: ${job.pid ?? "unknown"}`,
		`Log file: ${job.outputPath}`,
		`Use bash_status with jobId \"${job.jobId}\" to inspect it, bash_kill to stop it, or bash_jobs to list jobs.`,
		"",
		"Output so far:",
		tail.text || "(no output yet)",
	];

	if (tail.truncated) {
		lines.push("", `[Showing recent output tail. Full log: ${job.outputPath}]`);
	}
	if (job.interactiveStall && job.stallSummary) {
		lines.push("", `[Possible interactive stall: ${job.stallSummary}]`);
	}

	return lines.join("\n");
}

function formatCompletedMessage(job: BashJob, includeHeader = false, tail = getTailState(job)): string {
	const lines: string[] = [];
	if (includeHeader) {
		const summary =
			job.status === "completed"
				? `Job ${job.jobId} completed successfully.`
				: job.status === "killed"
					? `Job ${job.jobId} was killed.`
					: `Job ${job.jobId} failed${job.exitCode !== undefined && job.exitCode !== null ? ` with exit code ${job.exitCode}` : ""}.`;
		lines.push(summary, `Command: ${job.command}`, `Runtime: ${formatDuration((job.endedAt ?? Date.now()) - job.startedAt)}`);
	}

	lines.push(tail.text || "(no output)");
	if (tail.truncated) {
		lines.push("", `[Showing recent output tail. Full log: ${job.outputPath}]`);
	}
	if (job.killedForLogLimit) {
		lines.push("", `[Job was killed after exceeding log size limit (${formatSize(maxLogBytes)}).]`);
	}
	if (job.interactiveStall && job.stallSummary) {
		lines.push("", `[Earlier possible interactive stall: ${job.stallSummary}]`);
	}
	return lines.join("\n").trim();
}

function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals = "SIGKILL"): void {
	if (!pid) return;
	try {
		if (process.platform !== "win32") {
			process.kill(-pid, signal);
		} else {
			process.kill(pid, signal);
		}
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// Ignore kill failures; process may already be gone.
		}
	}
}

function finalizeJob(job: BashJob, exitCode: number | null, _signal: NodeJS.Signals | null): void {
	if (job.finalized) return;
	job.finalized = true;
	if (job.stallTimer) {
		clearInterval(job.stallTimer);
		job.stallTimer = undefined;
	}
	job.endedAt = Date.now();
	job.exitCode = exitCode;
	job.status = job.killRequested ? "killed" : exitCode === 0 ? "completed" : "failed";

	let completionReady = false;
	const resolveCompletion = () => {
		if (completionReady) return;
		completionReady = true;
		job.completion.resolve();
	};
	if (job.logStream.destroyed || job.logStream.writableFinished || job.logStream.errored) {
		resolveCompletion();
		return;
	}
	job.logStream.once("finish", resolveCompletion);
	job.logStream.once("error", resolveCompletion);
	try {
		job.logStream.end(resolveCompletion);
	} catch {
		resolveCompletion();
	}
}

function startStallWatchdog(job: BashJob): void {
	job.stallTimer = setInterval(async () => {
		if (job.status !== "running") {
			if (job.stallTimer) clearInterval(job.stallTimer);
			job.stallTimer = undefined;
			return;
		}

		if (job.totalBytes > maxLogBytes) {
			job.killedForLogLimit = true;
			job.killRequested = true;
			killProcessGroup(job.pid);
			return;
		}

		if (Date.now() - job.lastOutputAt < STALL_THRESHOLD_MS) {
			return;
		}

		const tail = getTailState(job).text;
		if (!tail || !looksLikePrompt(tail)) {
			return;
		}

		if (!job.interactiveStall) {
			job.interactiveStall = true;
			job.stallSummary = "output appears stalled and the last line looks like an interactive prompt";
		}
	}, STALL_CHECK_INTERVAL_MS);
	job.stallTimer.unref?.();
}

function registerJob(command: string, cwd: string, child: ChildProcess): BashJob {
	const jobId = createJobId();
	const outputPath = createLogPath(jobId);
	const logStream = createWriteStream(outputPath, { flags: "a" });
	let canWriteLog = true;
	const completion = createDeferred<void>();
	const job: BashJob = {
		jobId,
		command,
		cwd,
		pid: child.pid,
		status: "running",
		startedAt: Date.now(),
		outputPath,
		totalBytes: 0,
		lastOutputAt: Date.now(),
		interactiveStall: false,
		killedForLogLimit: false,
		killRequested: false,
		logStream,
		outputListeners: new Set(),
		chunks: [],
		chunksBytes: 0,
		completion,
		finalized: false,
		detached: false,
		completionNotificationSuppressed: false,
		completionNotificationQueued: false,
		completionNotificationSent: false,
	};
	jobs.set(jobId, job);
	logStream.on("error", () => {
		canWriteLog = false;
	});

	const onData = (data: Buffer | string) => {
		const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
		appendChunk(job, chunk);
		if (canWriteLog) {
			logStream.write(chunk);
		}
		for (const listener of job.outputListeners) {
			try {
				listener();
			} catch {
				// Rendering updates are best-effort; never break output capture.
			}
		}
	};

	child.stdout?.on("data", onData);
	child.stderr?.on("data", onData);
	child.once("close", (code, signal) => finalizeJob(job, code, signal));
	child.once("error", () => finalizeJob(job, 1, null));
	startStallWatchdog(job);

	return job;
}

function spawnManagedJob(command: string, cwd: string): BashJob {
	const shell = shellPath();
	const child = spawn(shell, shellArgs(command), {
		cwd,
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
		detached: process.platform !== "win32",
		windowsHide: true,
	});
	return registerJob(command, cwd, child);
}

function getJob(jobId: string): BashJob {
	const job = jobs.get(jobId);
	if (!job) {
		throw new Error(`Unknown bash job: ${jobId}. It may have already finished and been cleaned up. Use bash_jobs to list running jobs and terminal jobs that await retrieval.`);
	}
	return job;
}

function forgetJob(job: BashJob): void {
	jobs.delete(job.jobId);
}

function consumeCompletedJob(
	job: BashJob,
	includeHeader = false,
	forceFullOutputPath = false,
	tail = getTailState(job),
): CompletedJobResult {
	if (job.status === "running") {
		throw new Error(`Cannot consume running bash job: ${job.jobId}`);
	}
	const text = formatCompletedMessage(job, includeHeader, tail);
	const details = buildDetails(job, forceFullOutputPath, tail);
	const status = job.status;
	const exitCode = job.exitCode;
	forgetJob(job);
	return { text, details, status, exitCode };
}

function buildDetails(job: BashJob, forceFullOutputPath = false, tail = getTailState(job)): BashToolDetails | undefined {
	if (!forceFullOutputPath && !tail.truncated) {
		return undefined;
	}
	return {
		fullOutputPath: job.outputPath,
		...(tail.truncated ? { truncation: tail.truncation } : {}),
	};
}

function buildOutputUpdate(job: BashJob, forceFullOutputPath = false, tail = getTailState(job)): BashToolResult {
	return {
		content: [{ type: "text", text: tail.text || "" }],
		details: buildDetails(job, forceFullOutputPath, tail),
	};
}

function attachOutputUpdater(
	job: BashJob,
	onUpdate: ((result: BashToolResult) => void) | undefined,
	options: { forceFullOutputPath?: boolean; emitInitialOutput?: boolean } = {},
): () => void {
	if (!onUpdate) return () => {};

	const forceFullOutputPath = options.forceFullOutputPath ?? false;
	let updateTimer: NodeJS.Timeout | undefined;
	let updateDirty = false;
	let lastUpdateAt = 0;

	const clearUpdateTimer = () => {
		if (updateTimer) {
			clearTimeout(updateTimer);
			updateTimer = undefined;
		}
	};

	const emitOutputUpdate = () => {
		if (!updateDirty) return;
		updateDirty = false;
		lastUpdateAt = Date.now();
		onUpdate(buildOutputUpdate(job, forceFullOutputPath));
	};

	const scheduleOutputUpdate = () => {
		updateDirty = true;
		const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
		if (delay <= 0) {
			clearUpdateTimer();
			emitOutputUpdate();
			return;
		}
		updateTimer ??= setTimeout(() => {
			updateTimer = undefined;
			emitOutputUpdate();
		}, delay);
	};

	job.outputListeners.add(scheduleOutputUpdate);
	if (options.emitInitialOutput) {
		onUpdate(buildOutputUpdate(job, forceFullOutputPath));
	} else {
		onUpdate({ content: [], details: undefined });
	}

	return () => {
		job.outputListeners.delete(scheduleOutputUpdate);
		clearUpdateTimer();
		emitOutputUpdate();
	};
}

function completedJobResponseOrThrow(
	job: BashJob,
	includeHeader = false,
	forceFullOutputPath = false,
	tail = getTailState(job),
): BashToolResult {
	const { text, details, status, exitCode } = consumeCompletedJob(job, includeHeader, forceFullOutputPath, tail);
	if (status === "failed") {
		throw new Error(`${text}\n\nCommand exited with code ${exitCode ?? 1}`);
	}
	if (status === "killed") {
		throw new Error(`${text}\n\nCommand was killed`);
	}
	return {
		content: [{ type: "text", text }],
		details,
	};
}

async function runManagedBash(
	command: string,
	cwd: string,
	timeoutSeconds: number,
	signal: AbortSignal | undefined,
	onUpdate: ((result: BashToolResult) => void) | undefined,
	onDetached: (job: BashJob) => void,
): Promise<BashToolResult> {
	const job = spawnManagedJob(command, cwd);
	dlog("BASH", "runManagedBash_spawned", {
		jobId: job.jobId,
		pid: job.pid,
		command: command.slice(0, 200),
		timeoutSeconds,
		haveSignal: !!signal,
		signalAlreadyAborted: signal?.aborted ?? null,
	});
	const stopUpdating = attachOutputUpdater(job, onUpdate);

	try {
		const result = await new Promise<"completed" | "timed_out">((resolve, reject) => {
			let timeoutHandle: NodeJS.Timeout | undefined;
			let abortHandler: (() => void) | undefined;
			let settled = false;

			const finish = (value: "completed" | "timed_out") => {
				if (settled) return;
				settled = true;
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (abortHandler && signal) signal.removeEventListener("abort", abortHandler);
				dlog("BASH", "runManagedBash_finish", {
					jobId: job.jobId,
					outcome: value,
					signalAborted: signal?.aborted ?? null,
				});
				resolve(value);
			};

			job.completion.promise.then(() => finish("completed"));
			timeoutHandle = setTimeout(() => {
				if (job.finalized) return;
				job.detached = true;
				job.completion.promise.then(() => onDetached(job)).catch(() => {
					// Notification scheduling is best-effort.
				});
				finish("timed_out");
			}, timeoutSeconds * 1000);
			if (timeoutHandle.unref) timeoutHandle.unref();

			abortHandler = () => {
				dlog("BASH", "runManagedBash_abort_fired", {
					jobId: job.jobId,
					settled,
					signalAborted: signal?.aborted ?? null,
				});
				if (settled) return;
				settled = true;
				if (timeoutHandle) clearTimeout(timeoutHandle);
				job.killRequested = true;
				killProcessGroup(job.pid);
				reject(new Error("Command aborted"));
			};
			if (signal) {
				if (signal.aborted) {
					dlog("BASH", "runManagedBash_signal_already_aborted", { jobId: job.jobId });
					abortHandler();
				} else {
					signal.addEventListener("abort", abortHandler, { once: true });
					dlog("BASH", "runManagedBash_listener_attached", { jobId: job.jobId });
				}
			} else {
				dlog("BASH", "runManagedBash_no_signal", { jobId: job.jobId });
			}
		});

		if (result === "timed_out") {
			return {
				content: [{ type: "text", text: formatRunningMessage(job) }],
				details: buildDetails(job),
			};
		}

		return completedJobResponseOrThrow(job);
	} finally {
		stopUpdating();
	}
}

function formatStatus(job: BashJob, tail = getTailState(job)): string {
	const lines = [
		`Job: ${job.jobId}`,
		`Status: ${job.status}`,
		`Command: ${job.command}`,
		`Working directory: ${job.cwd}`,
		`Started: ${new Date(job.startedAt).toISOString()}`,
		`Elapsed: ${formatDuration((job.endedAt ?? Date.now()) - job.startedAt)}`,
		`PID: ${job.pid ?? "unknown"}`,
		`Log file: ${job.outputPath}`,
		`Bytes captured: ${formatSize(job.totalBytes)}`,
	];
	if (job.endedAt) lines.push(`Ended: ${new Date(job.endedAt).toISOString()}`);
	if (job.exitCode !== undefined) lines.push(`Exit code: ${job.exitCode ?? "null"}`);
	if (job.interactiveStall && job.stallSummary) lines.push(`Interactive stall: ${job.stallSummary}`);
	if (job.killedForLogLimit) lines.push(`Killed for log limit: ${formatSize(maxLogBytes)}`);
	lines.push("", "Recent output:", tail.text || "(no output yet)");
	if (tail.truncated) {
		lines.push("", `[Showing recent output tail. Full log: ${job.outputPath}]`);
	}
	return lines.join("\n");
}

function getRunningJobs(): BashJob[] {
	return [...jobs.values()].filter((job) => job.status === "running");
}

function formatJobsList(): string {
	const managedJobs = [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
	if (managedJobs.length === 0) {
		return "No managed bash jobs.";
	}

	const runningJobs = managedJobs.filter((job) => job.status === "running");
	const terminalJobs = managedJobs.filter((job) => job.status !== "running");
	const sections: string[] = [];
	if (runningJobs.length > 0) {
		const lines = runningJobs.map((job) => {
			const runtime = formatDuration(Date.now() - job.startedAt);
			const extra = job.interactiveStall ? " · waiting for input?" : "";
			return `● ${job.jobId} · running · ${runtime}${extra}\n    ${job.command}\n    ${job.outputPath}`;
		});
		sections.push(`Running managed bash jobs (${runningJobs.length}):\n\n${lines.join("\n\n")}`);
	}
	if (terminalJobs.length > 0) {
		const lines = terminalJobs.map((job) => {
			const runtime = formatDuration((job.endedAt ?? Date.now()) - job.startedAt);
			return `● ${job.jobId} · ${job.status} · ${runtime}\n    ${job.command}\n    ${job.outputPath}`;
		});
		sections.push(`Terminal managed bash jobs awaiting retrieval (${terminalJobs.length}):\n\n${lines.join("\n\n")}`);
	}
	return sections.join("\n\n");
}

// Hard deadline for the post-SIGKILL wait in killJob. If the child is
// stuck in kernel D-state (uninterruptible sleep on a hung syscall —
// e.g., ssh / 9p / NFS against a swamped or frozen peer), SIGKILL is
// queued but may never be delivered, so the `close` event never fires
// and job.completion.promise never resolves. We give up after this
// many ms and force-finalize the job so the caller can't hang forever.
const KILL_WAIT_DEADLINE_MS = 5_000;

async function killJob(job: BashJob, signal?: AbortSignal): Promise<void> {
	if (job.status !== "running") return;
	job.killRequested = true;
	killProcessGroup(job.pid);

	await new Promise<void>((resolve, reject) => {
		let settled = false;
		let deadlineHandle: NodeJS.Timeout | undefined;
		let abortHandler: (() => void) | undefined;

		const cleanup = () => {
			if (deadlineHandle) clearTimeout(deadlineHandle);
			if (abortHandler && signal) signal.removeEventListener("abort", abortHandler);
		};

		const finish = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve();
		};

		const fail = (err: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		};

		job.completion.promise.then(finish);

		deadlineHandle = setTimeout(() => {
			// Child didn't close after SIGKILL. Force-finalize so the
			// caller returns; if the kernel eventually reaps the child,
			// finalizeJob is idempotent and the late 'close' event is a
			// no-op.
			finalizeJob(job, null, "SIGKILL");
			finish();
		}, KILL_WAIT_DEADLINE_MS);
		if (deadlineHandle.unref) deadlineHandle.unref();

		abortHandler = () => fail(new Error(`Stopped waiting for bash_kill of ${job.jobId}`));
		if (signal) {
			if (signal.aborted) abortHandler();
			else signal.addEventListener("abort", abortHandler, { once: true });
		}
	});
}

export default function (pi: ExtensionAPI) {
	const bashResultRenderer = createBashToolDefinition(process.cwd()).renderResult;
	const pendingCompletionNotifications = new Set<BashJob>();
	let completionNotificationTimer: NodeJS.Timeout | undefined;
	let sessionShuttingDown = false;

	const flushCompletionNotifications = () => {
		completionNotificationTimer = undefined;
		const terminalJobs = [...pendingCompletionNotifications];
		pendingCompletionNotifications.clear();
		if (sessionShuttingDown) return;
		const eligibleJobs = terminalJobs.filter(
			(job) =>
				job.detached &&
				job.status !== "running" &&
				!job.completionNotificationSuppressed &&
				!job.completionNotificationSent,
		);
		if (eligibleJobs.length === 0) return;
		for (const job of eligibleJobs) {
			job.completionNotificationQueued = false;
			job.completionNotificationSent = true;
		}
		const lines = [
			"Managed bash job completion:",
			...eligibleJobs.map((job) => `- ${job.jobId} · ${job.status} · ${formatCommandPreview(job.command)}`),
			"Use bash_status with a job ID to retrieve its final output.",
		];
		try {
			pi.sendMessage(
				{
					customType: "bash-job-completion",
					content: lines.join("\n"),
					display: true,
					details: {
						jobs: eligibleJobs.map((job) => ({
							jobId: job.jobId,
							status: job.status,
							command: formatCommandPreview(job.command),
						})),
					},
				},
				{ triggerTurn: true, deliverAs: "steer" },
			);
		} catch (error) {
			dlog("BASH", "completion_notification_failed", {
				error: (error as Error)?.message ?? String(error),
				jobIds: eligibleJobs.map((job) => job.jobId),
			});
		}
	};

	const queueCompletionNotification = (job: BashJob) => {
		if (
			!job.detached ||
			job.status === "running" ||
			job.completionNotificationSuppressed ||
			job.completionNotificationQueued ||
			job.completionNotificationSent ||
			sessionShuttingDown
		) {
			return;
		}
		job.completionNotificationQueued = true;
		pendingCompletionNotifications.add(job);
		completionNotificationTimer ??= setTimeout(flushCompletionNotifications, COMPLETION_NOTIFICATION_BATCH_MS);
		completionNotificationTimer.unref?.();
	};

	const suppressCompletionNotification = (job: BashJob) => {
		job.completionNotificationSuppressed = true;
		job.completionNotificationQueued = false;
		pendingCompletionNotifications.delete(job);
		if (pendingCompletionNotifications.size === 0 && completionNotificationTimer) {
			clearTimeout(completionNotificationTimer);
			completionNotificationTimer = undefined;
		}
	};

	pi.on("session_start", () => {
		sessionShuttingDown = false;
		maxLogBytes = loadMaxLogBytes();
	});

	pi.on("session_shutdown", async () => {
		sessionShuttingDown = true;
		if (completionNotificationTimer) {
			clearTimeout(completionNotificationTimer);
			completionNotificationTimer = undefined;
		}
		for (const job of jobs.values()) suppressCompletionNotification(job);
		const runningJobs = getRunningJobs();
		await Promise.all(
			runningJobs.map(async (job) => {
				job.killRequested = true;
				killProcessGroup(job.pid);
				try {
					await Promise.race([
						job.completion.promise,
						new Promise((resolve) => setTimeout(resolve, 1_000)),
					]);
				} catch {
					// Ignore shutdown cleanup errors.
				}
			}),
		);
	});

	pi.registerTool({
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Supports an optional cwd override for this command. Timeout defaults to ${defaultBashTimeoutSeconds} seconds; if the command exceeds it, it stays alive as a managed bash job instead of being killed. Use bash_status, bash_kill, or bash_jobs to manage it.`,
		promptSnippet: `Execute bash commands (ls, grep, find, etc.). Supports an optional cwd override. Timeout defaults to ${defaultBashTimeoutSeconds}s; commands that exceed it continue as managed bash jobs.`,
		promptGuidelines: [
			"Prefer the cwd parameter over prepending commands with cd when you want to run a command in another directory.",
			"When a timed bash command is still running, use bash_status, bash_kill, or bash_jobs instead of rerunning it from scratch.",
			"Use bash_jobs to recover job IDs for running jobs and terminal jobs that await retrieval.",
			`If you omit timeout, bash uses a default soft timeout of ${defaultBashTimeoutSeconds} seconds before the command becomes a managed job.`,
			"Do not use shell backgrounding tricks like &, nohup, or disown to detach work. Instead, let bash create a managed job and then use bash_status, bash_kill, or bash_jobs.",
		],
		parameters: bashSchema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const commandCwd = resolveCommandCwd(ctx.cwd, params.cwd);
			dlog("BASH", "tool_bash_enter", {
				toolCallId: _toolCallId,
				command: typeof params.command === "string" ? params.command.slice(0, 200) : null,
				haveSignal: !!signal,
				signalAlreadyAborted: signal?.aborted ?? null,
			});
			try {
				return await runManagedBash(
					params.command,
					commandCwd,
					params.timeout ?? defaultBashTimeoutSeconds,
					signal,
					onUpdate,
					queueCompletionNotification,
				);
			} catch (err) {
				dlog("BASH", "tool_bash_threw", {
					toolCallId: _toolCallId,
					error: (err as Error)?.message ?? String(err),
					signalAborted: signal?.aborted ?? null,
				});
				throw err;
			} finally {
				dlog("BASH", "tool_bash_exit", {
					toolCallId: _toolCallId,
					signalAborted: signal?.aborted ?? null,
				});
			}
		},
	});

	pi.registerTool({
		name: "bash_status",
		label: "bash_status",
		description: "Inspect the current status of a managed bash job, including elapsed time, log path, and recent output.",
		promptSnippet: "Inspect the status of an existing managed bash job.",
		parameters: jobIdSchema,
		renderResult: bashResultRenderer,
		async execute(_toolCallId, params) {
			const job = getJob(params.jobId);
			if (job.status !== "running") {
				await job.completion.promise;
				suppressCompletionNotification(job);
				const tail = getTailState(job);
				const response = {
					content: [{ type: "text", text: formatStatus(job, tail) }],
					details: buildDetails(job, false, tail),
				};
				forgetJob(job);
				return response;
			}

			const tail = getTailState(job);
			return {
				content: [{ type: "text", text: formatStatus(job, tail) }],
				details: buildDetails(job, false, tail),
			};
		},
	});

	pi.registerTool({
		name: "bash_kill",
		label: "bash_kill",
		description: "Kill a running managed bash job and return its final known output tail.",
		promptSnippet: "Stop a running managed bash job.",
		parameters: jobIdSchema,
		renderResult: bashResultRenderer,
		async execute(_toolCallId, params, signal) {
			dlog("BASH", "tool_bash_kill_enter", {
				toolCallId: _toolCallId,
				jobId: params.jobId,
				signalAlreadyAborted: signal?.aborted ?? null,
			});
			const job = getJob(params.jobId);
			suppressCompletionNotification(job);
			await killJob(job, signal);
			const { text, details } = consumeCompletedJob(job, true);
			dlog("BASH", "tool_bash_kill_exit", {
				toolCallId: _toolCallId,
				jobId: params.jobId,
				signalAborted: signal?.aborted ?? null,
			});
			return {
				content: [{ type: "text", text }],
				details,
			};
		},
	});

	pi.registerTool({
		name: "bash_jobs",
		label: "bash_jobs",
		description: "List running managed bash jobs and terminal jobs that await output retrieval.",
		promptSnippet: "List managed bash jobs so you can recover job ids for active or completed detached commands.",
		parameters: Type.Object({}),
		async execute() {
			return {
				content: [{ type: "text", text: formatJobsList() }],
			};
		},
	});

	pi.registerCommand("bash-jobs", {
		description: "Show managed bash jobs",
		handler: async (_args, ctx) => {
			if (ctx.hasUI) {
				ctx.ui.notify(formatJobsList(), "info");
			}
		},
	});
}
