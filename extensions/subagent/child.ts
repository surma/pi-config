import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const delegatedPrompt = process.env.PI_SUBAGENT_SYSTEM_PROMPT || "";
const promptPath = process.env.PI_SUBAGENT_PROMPT_PATH;
const leaseFilePath = process.env.PI_SUBAGENT_LEASE_PATH;
const leaseOwnerSessionFile = process.env.PI_SUBAGENT_OWNER_SESSION_FILE;
const leaseOwnerSessionId = process.env.PI_SUBAGENT_OWNER_SESSION_ID;
const leaseControllerInstanceId = process.env.PI_SUBAGENT_CONTROLLER_INSTANCE_ID;
const childSessionDir = process.env.PI_SUBAGENT_SESSION_DIR;
const childIncarnation = process.env.PI_SUBAGENT_INCARNATION;
const configuredHealthPath = process.env.PI_SUBAGENT_HEALTH_PATH;
const CHILD_LEASE_CHECK_INTERVAL_MS = 5_000;
const MAX_LEASE_RECORD_BYTES = 4 * 1024;
const MAX_CONSECUTIVE_LEASE_READ_ERRORS = 3;
const DEFAULT_HEALTH_WAIT_TIMEOUT_MS = 5_000;
const DEFAULT_HEALTH_POLL_INTERVAL_MS = 25;
const subagentDepth = Math.max(
	1,
	Number.parseInt(process.env.PI_SUBAGENT_DEPTH || "1", 10) || 1,
);

/** Out-of-band marker written after the child extension registers its hooks. */
export const CHILD_EXTENSION_HEALTH_SIGNAL =
	"pi-subagent-child-extension-ready/v1\n";
export const CHILD_EXTENSION_HEALTH_MAX_BYTES = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface ChildLeaseIdentity {
	ownerSessionFile: string;
	ownerSessionId: string;
	controllerInstanceId: string;
}

export function isValidChildLeaseRecord(
	value: unknown,
	identity: ChildLeaseIdentity,
	at = Date.now(),
): boolean {
	if (!isRecord(value)) return false;
	return (
		value.ownerSessionFile === identity.ownerSessionFile &&
		value.ownerSessionId === identity.ownerSessionId &&
		value.controllerInstanceId === identity.controllerInstanceId &&
		typeof value.expiresAt === "number" &&
		Number.isFinite(value.expiresAt) &&
		at <= value.expiresAt
	);
}

/** Build the unique marker path that belongs to one child incarnation. */
export function childExtensionHealthPath(
	sessionDir: string,
	incarnation: string,
): string {
	return join(sessionDir, `child-extension-health-${incarnation}.marker`);
}

async function readBoundedFile(
	path: string,
	maxBytes: number,
): Promise<Buffer | undefined> {
	let file: Awaited<ReturnType<typeof fs.open>> | undefined;
	try {
		file = await fs.open(path, "r");
		const stat = await file.stat();
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
			const result = await file.read(
				buffer,
				bytesRead,
				buffer.length - bytesRead,
				bytesRead,
			);
			if (result.bytesRead <= 0) break;
			bytesRead += result.bytesRead;
		}
		if (bytesRead > maxBytes) return undefined;
		return buffer.subarray(0, bytesRead);
	} finally {
		await file?.close().catch(() => {});
	}
}

/** Verify one exact, bounded child-extension health marker. */
export async function verifyChildExtensionHealth(path: string): Promise<boolean> {
	if (!path) return false;
	try {
		const content = await readBoundedFile(
			path,
			CHILD_EXTENSION_HEALTH_MAX_BYTES,
		);
		return content?.toString("utf8") === CHILD_EXTENSION_HEALTH_SIGNAL;
	} catch {
		return false;
	}
}

/** Publish the child-extension marker without writing anything to RPC stdout. */
export async function writeChildExtensionHealthSignal(
	path: string,
): Promise<boolean> {
	if (!path) return false;
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
	try {
		await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
		await fs.chmod(dirname(path), 0o700).catch(() => {});
		await fs.writeFile(temporary, CHILD_EXTENSION_HEALTH_SIGNAL, {
			encoding: "utf8",
			mode: 0o600,
		});
		await fs.chmod(temporary, 0o600).catch(() => {});
		await fs.rename(temporary, path);
		await fs.chmod(path, 0o600).catch(() => {});
		return true;
	} catch {
		return false;
	} finally {
		await fs.unlink(temporary).catch(() => {});
	}
}

export interface ChildHealthWaitOptions {
	timeoutMs?: number;
	pollIntervalMs?: number;
}

/** Wait for a marker with bounded polling so startup can reject a missing hook. */
export async function waitForChildExtensionHealth(
	path: string,
	options: ChildHealthWaitOptions = {},
): Promise<boolean> {
	const timeoutMs = Math.max(
		0,
		Math.floor(options.timeoutMs ?? DEFAULT_HEALTH_WAIT_TIMEOUT_MS),
	);
	const pollIntervalMs = Math.max(
		1,
		Math.floor(options.pollIntervalMs ?? DEFAULT_HEALTH_POLL_INTERVAL_MS),
	);
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await verifyChildExtensionHealth(path)) return true;
		const remaining = deadline - Date.now();
		if (remaining <= 0) return false;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, Math.min(pollIntervalMs, remaining));
			timer.unref?.();
		});
	}
}

async function readChildLeaseRecord(path: string): Promise<unknown> {
	const content = await readBoundedFile(path, MAX_LEASE_RECORD_BYTES);
	if (!content) return undefined;
	try {
		return JSON.parse(content.toString("utf8"));
	} catch {
		return undefined;
	}
}

export interface ChildLeaseMonitorOptions {
	leasePath: string;
	identity: ChildLeaseIdentity;
	intervalMs?: number;
	maxReadErrors?: number;
	readLease?: (path: string) => Promise<unknown>;
	now?: () => number;
	onDiagnostic?: (message: string) => void;
	terminate?: () => void;
}

export interface ChildLeaseMonitor {
	start(): void;
	stop(): void;
	checkNow(): Promise<void>;
}

/**
 * Monitor one lease with serialized, generation-fenced checks.
 *
 * A bounded read that returns invalid data fences the child immediately.
 * Temporary read errors get three consecutive retries, which tolerates an
 * atomic lease rename without allowing a permanent storage failure to linger.
 */
export function createChildLeaseMonitor(
	options: ChildLeaseMonitorOptions,
): ChildLeaseMonitor {
	const intervalMs = Math.max(
		1,
		Math.floor(options.intervalMs ?? CHILD_LEASE_CHECK_INTERVAL_MS),
	);
	const maxReadErrors = Math.max(
		1,
		Math.floor(options.maxReadErrors ?? MAX_CONSECUTIVE_LEASE_READ_ERRORS),
	);
	const readLease = options.readLease || readChildLeaseRecord;
	const now = options.now || (() => Date.now());
	const diagnostic = (message: string) => {
		try {
			options.onDiagnostic?.(message);
		} catch {
			// Diagnostics must not break the lease fence.
		}
	};
	let timer: NodeJS.Timeout | undefined;
	let generation = 0;
	let active = false;
	let inFlight: Promise<void> | undefined;
	let queued = false;
	let consecutiveReadErrors = 0;

	const current = (candidate: number) => active && candidate === generation;
	const stop = () => {
		active = false;
		generation++;
		queued = false;
		consecutiveReadErrors = 0;
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	};
	const fence = (candidate: number, reason: string) => {
		if (!current(candidate)) return;
		stop();
		diagnostic(reason);
		try {
			(options.terminate || (() => process.kill(process.pid, "SIGTERM")))();
		} catch {
			// The process can exit between validation and the self-fence signal.
		}
	};
	const check = async (candidate: number): Promise<void> => {
		if (!current(candidate)) return;
		let record: unknown;
		try {
			record = await readLease(options.leasePath);
			consecutiveReadErrors = 0;
		} catch (error) {
			if (!current(candidate)) return;
			consecutiveReadErrors++;
			diagnostic(
				`Child lease read failed (${consecutiveReadErrors}/${maxReadErrors}); retrying: ${error instanceof Error ? error.message : String(error)}`,
			);
			if (consecutiveReadErrors >= maxReadErrors)
				fence(candidate, "Child lease read failed repeatedly; terminating.");
			return;
		}
		if (!current(candidate)) return;
		if (isValidChildLeaseRecord(record, options.identity, now())) return;
		fence(
			candidate,
			"Child lease record is missing, invalid, expired, or replaced.",
		);
	};
	const checkNow = (): Promise<void> => {
		if (!active) return Promise.resolve();
		if (inFlight) {
			queued = true;
			return inFlight;
		}
		const candidate = generation;
		const promise = check(candidate).finally(() => {
			if (inFlight !== promise) return;
			inFlight = undefined;
			if (active && queued) {
				queued = false;
				void checkNow();
			}
		});
		inFlight = promise;
		return promise;
	};
	const start = () => {
		stop();
		active = true;
		void checkNow();
		timer = setInterval(() => void checkNow(), intervalMs);
		timer.unref?.();
	};

	return { start, stop, checkNow };
}

const childLeaseIdentity =
	leaseFilePath &&
	leaseOwnerSessionFile &&
	leaseOwnerSessionId &&
	leaseControllerInstanceId
		? {
				ownerSessionFile: leaseOwnerSessionFile,
				ownerSessionId: leaseOwnerSessionId,
				controllerInstanceId: leaseControllerInstanceId,
			}
		: undefined;
const childHealthPath =
	configuredHealthPath ||
	(childSessionDir && childIncarnation
		? childExtensionHealthPath(childSessionDir, childIncarnation)
		: undefined);
const childLeaseMonitor =
	leaseFilePath && childLeaseIdentity
		? createChildLeaseMonitor({
				leasePath: leaseFilePath,
				identity: childLeaseIdentity,
			})
		: undefined;

function startLeaseMonitor(): void {
	childLeaseMonitor?.start();
}

function stopLeaseMonitor(): void {
	childLeaseMonitor?.stop();
}

async function publishHealthSignal(): Promise<void> {
	if (!childHealthPath) return;
	if (await writeChildExtensionHealthSignal(childHealthPath)) return;
	process.stderr.write(
		`Failed to publish child extension health signal at ${childHealthPath}.\n`,
	);
}

async function captureEffectivePrompt(prompt: string): Promise<void> {
	if (!promptPath) return;
	try {
		await fs.mkdir(dirname(promptPath), { recursive: true, mode: 0o700 });
		await fs.chmod(dirname(promptPath), 0o700).catch(() => {});
		await fs.writeFile(promptPath, prompt, { encoding: "utf8", mode: 0o600 });
		await fs.chmod(promptPath, 0o600).catch(() => {});
	} catch (error) {
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
		await publishHealthSignal();
		startLeaseMonitor();
		await captureEffectivePrompt(ctx.getSystemPrompt());
	});

	pi.on("session_shutdown", async () => {
		stopLeaseMonitor();
	});

	pi.on("agent_start", async (_event, ctx) => {
		await captureEffectivePrompt(ctx.getSystemPrompt());
	});

	pi.on("before_agent_start", async (event) => {
		const systemPrompt = delegatedSystemPrompt(event.systemPrompt);
		await captureEffectivePrompt(systemPrompt);
		return { systemPrompt };
	});
}
