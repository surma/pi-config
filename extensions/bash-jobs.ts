import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateTail,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const LOG_DIR = join(tmpdir(), "pi-bash-jobs");
const MAX_TAIL_BUFFER_BYTES = DEFAULT_MAX_BYTES * 2;
const DEFAULT_MAX_LOG_BYTES = 4 * 1024 * 1024 * 1024;
const FALLBACK_BASH_TIMEOUT_SECONDS = 10;
const STALL_CHECK_INTERVAL_MS = 5_000;
const STALL_THRESHOLD_MS = 45_000;

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
	chunks: Buffer[];
	chunksBytes: number;
	completion: Deferred<void>;
	stallTimer?: NodeJS.Timeout;
	finalized: boolean;
};

type TailState = {
	text: string;
	truncated: boolean;
	truncation: ReturnType<typeof truncateTail>;
};

type BashToolDetails = {
	truncation?: unknown;
	fullOutputPath?: string;
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

const waitSchema = Type.Object({
	jobId: Type.String({ description: "Managed bash job id" }),
	timeout: Type.Optional(Type.Number({ minimum: 1, description: "Additional time to wait in seconds (optional, no default timeout)" })),
});

const jobs = new Map<string, BashJob>();
let maxLogBytes = DEFAULT_MAX_LOG_BYTES;
let remindedRunningJobsSignature: string | undefined;

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
		`Started: ${formatStartedAt(job.startedAt)} (${formatDuration(Date.now() - job.startedAt)} elapsed)`,
		`PID: ${job.pid ?? "unknown"}`,
		`Log file: ${job.outputPath}`,
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
	lines.push(
		"",
		`Use bash_wait with jobId \"${job.jobId}\" to wait longer, bash_status to inspect it, bash_kill to stop it, or bash_jobs to list jobs.`,
	);

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
		lines.push(summary, `Runtime: ${formatDuration((job.endedAt ?? Date.now()) - job.startedAt)}`);
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
	if (!job.logStream.destroyed) {
		job.logStream.end();
	}
	job.endedAt = Date.now();
	job.exitCode = exitCode;
	job.status = job.killRequested ? "killed" : exitCode === 0 ? "completed" : "failed";
	job.completion.resolve();
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
		chunks: [],
		chunksBytes: 0,
		completion,
		finalized: false,
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
		throw new Error(`Unknown bash job: ${jobId}. It may have already finished and been cleaned up. Use bash_jobs to see running jobs.`);
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
): Promise<BashToolResult> {
	const job = spawnManagedJob(command, cwd);

	const result = await new Promise<"completed" | "timed_out">((resolve, reject) => {
			let timeoutHandle: NodeJS.Timeout | undefined;
			let abortHandler: (() => void) | undefined;
			let settled = false;

			const finish = (value: "completed" | "timed_out") => {
				if (settled) return;
				settled = true;
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (abortHandler && signal) signal.removeEventListener("abort", abortHandler);
				resolve(value);
			};

			job.completion.promise.then(() => finish("completed"));
			timeoutHandle = setTimeout(() => finish("timed_out"), timeoutSeconds * 1000);
			if (timeoutHandle.unref) timeoutHandle.unref();

			abortHandler = () => {
				if (settled) return;
				settled = true;
				if (timeoutHandle) clearTimeout(timeoutHandle);
				job.killRequested = true;
				killProcessGroup(job.pid);
				reject(new Error("Command aborted"));
			};
			if (signal) {
				if (signal.aborted) abortHandler();
				else signal.addEventListener("abort", abortHandler, { once: true });
			}
		});

	if (result === "timed_out") {
		return {
			content: [{ type: "text", text: formatRunningMessage(job) }],
			details: buildDetails(job, true),
		};
	}

	return completedJobResponseOrThrow(job);
}

async function waitForJob(
	job: BashJob,
	timeoutSeconds: number | undefined,
	signal: AbortSignal | undefined,
): Promise<void> {
	if (job.status !== "running") return;

	await new Promise<void>((resolve, reject) => {
			let timeoutHandle: NodeJS.Timeout | undefined;
			let abortHandler: (() => void) | undefined;
			let settled = false;

			const finish = () => {
				if (settled) return;
				settled = true;
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (abortHandler && signal) signal.removeEventListener("abort", abortHandler);
				resolve();
			};

			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (abortHandler && signal) signal.removeEventListener("abort", abortHandler);
				reject(error);
			};

			job.completion.promise.then(() => finish());
			if (timeoutSeconds !== undefined && timeoutSeconds > 0) {
				timeoutHandle = setTimeout(finish, timeoutSeconds * 1000);
				if (timeoutHandle.unref) timeoutHandle.unref();
			}

		abortHandler = () => fail(new Error(`Stopped waiting for job ${job.jobId}`));
		if (signal) {
			if (signal.aborted) abortHandler();
			else signal.addEventListener("abort", abortHandler, { once: true });
		}
	});
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

function getRunningJobsSignature(runningJobs: BashJob[]): string | undefined {
	if (runningJobs.length === 0) return undefined;
	return runningJobs
		.map((job) => `${job.jobId}:${job.command}`)
		.sort()
		.join("|");
}

function formatRunningJobsReminder(runningJobs: BashJob[]): string {
	const lines = runningJobs
		.sort((a, b) => a.startedAt - b.startedAt)
		.map((job) => `- ${job.jobId} — ${job.command}`);
	return [
		"You still have managed bash jobs running:",
		...lines,
		"",
		"Before you stop, either use bash_wait to wait for them, use bash_kill to stop them, or explicitly tell the user why they should remain running.",
		"Do not use shell backgrounding operators like &, nohup, or disown for this. Prefer managed bash jobs via timeout plus bash_wait/bash_status/bash_kill/bash_jobs.",
	].join("\n");
}

function formatJobsList(): string {
	const runningJobs = getRunningJobs();
	if (runningJobs.length === 0) {
		return "No running managed bash jobs.";
	}

	const sorted = runningJobs.sort((a, b) => b.startedAt - a.startedAt);
	const lines = sorted.map((job) => {
		const runtime = formatDuration(Date.now() - job.startedAt);
		const extra = job.interactiveStall ? " · waiting for input?" : "";
		return `● ${job.jobId} · running · ${runtime}${extra}\n    ${job.command}\n    ${job.outputPath}`;
	});
	return `Running managed bash jobs (${runningJobs.length}):\n\n${lines.join("\n\n")}`;
}

async function killJob(job: BashJob): Promise<void> {
	if (job.status !== "running") return;
	job.killRequested = true;
	killProcessGroup(job.pid);
	await job.completion.promise;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", () => {
		maxLogBytes = loadMaxLogBytes();
	});

	pi.on("turn_end", async (event, ctx) => {
		if (event.message.stopReason !== "stop") return;
		if (event.toolResults.length > 0) return;
		if (ctx.hasPendingMessages()) return;

		const runningJobs = getRunningJobs();
		const signature = getRunningJobsSignature(runningJobs);
		if (!signature) {
			remindedRunningJobsSignature = undefined;
			return;
		}
		if (signature === remindedRunningJobsSignature) {
			return;
		}
		remindedRunningJobsSignature = signature;
		pi.sendMessage(
			{
				customType: "bash-jobs-reminder",
				content: formatRunningJobsReminder(runningJobs),
				display: false,
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	});

	pi.on("session_shutdown", async () => {
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
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Supports an optional cwd override for this command. Timeout defaults to ${defaultBashTimeoutSeconds} seconds; if the command exceeds it, it stays alive as a managed bash job instead of being killed. Use bash_wait, bash_status, bash_kill, or bash_jobs to manage it.`,
		promptSnippet: `Execute bash commands (ls, grep, find, etc.). Supports an optional cwd override. Timeout defaults to ${defaultBashTimeoutSeconds}s; commands that exceed it continue as managed bash jobs.`,
		promptGuidelines: [
			"Prefer the cwd parameter over prepending commands with cd when you want to run a command in another directory.",
			"When a timed bash command is still running, use bash_wait, bash_status, bash_kill, or bash_jobs instead of rerunning it from scratch.",
			"Use bash_jobs when you need to recover a job id for a still-running managed bash job.",
			`If you omit timeout, bash uses a default soft timeout of ${defaultBashTimeoutSeconds} seconds before the command becomes a managed job.`,
			"Do not use shell backgrounding tricks like &, nohup, or disown to detach work. Instead, let bash create a managed job and then use bash_wait, bash_status, bash_kill, or bash_jobs.",
		],
		parameters: bashSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const commandCwd = resolveCommandCwd(ctx.cwd, params.cwd);
			return runManagedBash(params.command, commandCwd, params.timeout ?? defaultBashTimeoutSeconds, signal);
		},
	});

	pi.registerTool({
		name: "bash_wait",
		label: "bash_wait",
		description: "Wait for a managed bash job to finish, or for additional time to elapse. Returns updated output and status without rerunning the command.",
		promptSnippet: "Wait for an existing managed bash job to finish or produce more output.",
		promptGuidelines: ["Use this after bash returns a running managed job and you want to wait longer without restarting the command."],
		parameters: waitSchema,
		renderCall(args, theme) {
			const timeoutSuffix = args.timeout ? theme.fg("muted", ` (timeout ${args.timeout}s)`) : "";
			return new Text(theme.fg("toolTitle", theme.bold(`bash_wait ${args.jobId}`)) + timeoutSuffix, 0, 0);
		},
		async execute(_toolCallId, params, signal) {
			const job = getJob(params.jobId);
			await waitForJob(job, params.timeout, signal);
			if (job.status === "running") {
				return {
					content: [{ type: "text", text: formatRunningMessage(job) }],
					details: buildDetails(job, true),
				};
			}
			return completedJobResponseOrThrow(job, true);
		},
	});

	pi.registerTool({
		name: "bash_status",
		label: "bash_status",
		description: "Inspect the current status of a managed bash job, including elapsed time, log path, and recent output.",
		promptSnippet: "Inspect the status of an existing managed bash job.",
		parameters: jobIdSchema,
		async execute(_toolCallId, params) {
			const job = getJob(params.jobId);
			const tail = getTailState(job);
			const response = {
				content: [{ type: "text", text: formatStatus(job, tail) }],
				details: buildDetails(job, true, tail),
			};
			if (job.status !== "running") {
				forgetJob(job);
			}
			return response;
		},
	});

	pi.registerTool({
		name: "bash_kill",
		label: "bash_kill",
		description: "Kill a running managed bash job and return its final known output tail.",
		promptSnippet: "Stop a running managed bash job.",
		parameters: jobIdSchema,
		async execute(_toolCallId, params) {
			const job = getJob(params.jobId);
			await killJob(job);
			const { text, details } = consumeCompletedJob(job, true, true);
			return {
				content: [{ type: "text", text }],
				details,
			};
		},
	});

	pi.registerTool({
		name: "bash_jobs",
		label: "bash_jobs",
		description: "List currently running managed bash jobs.",
		promptSnippet: "List running managed bash jobs so you can recover job ids for active backgrounded commands.",
		parameters: Type.Object({}),
		async execute() {
			return {
				content: [{ type: "text", text: formatJobsList() }],
			};
		},
	});

	pi.registerCommand("bash-jobs", {
		description: "Show running managed bash jobs",
		handler: async (_args, ctx) => {
			if (ctx.hasUI) {
				ctx.ui.notify(formatJobsList(), "info");
			}
		},
	});
}
