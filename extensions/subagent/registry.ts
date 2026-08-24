import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
	RunOutcome,
	RunState,
	SettlementStatus,
} from "./lifecycle.js";
import type { OutputStatus } from "./output-store.js";
import type { OwnerIdentity } from "./owner.js";

export interface RegistryEntry {
	childId: string;
	name?: string;
	task: string;
	cwd: string;
	pid?: number;
	exitCode?: number | null;
	exitSignal?: NodeJS.Signals | null;
	sessionDir: string;
	sessionFile?: string;
	promptPath?: string;
	requestedModel: string;
	requestedThinking: string;
	processState: "alive" | "stopped";
	runState: RunState;
	runId?: number;
	runCursor?: number;
	lastSettledRunId?: number;
	runOutcome?: RunOutcome;
	settlementStatus?: SettlementStatus;
	createdAt: number;
	lastActivityAt: number;
	error?: string;
	killRequestedAt?: number;
	osCloseObserved?: boolean;
	forced?: boolean;
	stderrTail?: string;
	diagnostics?: string[];
	outputPath?: string;
	outputStatus?: OutputStatus;
	outputError?: string;
	ownerSessionFile: string;
	ownerSessionId: string;
	incarnation: string;
	resumedFrom?: string;
}

/** Maximum bytes read from one registry snapshot before JSON parsing. */
export const MAX_REGISTRY_FILE_BYTES = 8 * 1024 * 1024;
/** Maximum entries accepted in one registry snapshot. */
export const MAX_REGISTRY_ENTRIES = 256;
/** Maximum serialized size of one registry entry. */
export const MAX_REGISTRY_ENTRY_BYTES = 1 * 1024 * 1024;
/** Maximum serialized size published by one registry save. */
export const MAX_REGISTRY_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_OPERATION_TIMEOUT_MS = 5_000;
const CLEANUP_TIMEOUT_MS = 250;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_REGISTRY_TEXT_BYTES = 64 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;
const MAX_STDERR_TAIL_BYTES = 8 * 1024;
const MAX_DIAGNOSTICS = 20;
const MAX_DIAGNOSTIC_BYTES = 2 * 1024;
const MAX_OUTPUT_ERROR_BYTES = 2 * 1024;
const THINKING_LEVELS = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);
const PROCESS_STATES = new Set(["alive", "stopped"]);
const RUN_STATES = new Set<RunState>([
	"idle",
	"running",
	"retrying",
	"finishing",
]);
const RUN_OUTCOMES = new Set<RunOutcome>([
	"pending",
	"succeeded",
	"failed",
	"aborted",
]);
const SETTLEMENT_STATUSES = new Set<SettlementStatus>([
	"pending",
	"settled",
	"closed_without_settlement",
]);
const OUTPUT_STATUSES = new Set<OutputStatus>([
	"not_requested",
	"pending",
	"written",
	"collision",
	"failed",
]);
const SIGNALS = new Set<string>([
	"SIGABRT",
	"SIGALRM",
	"SIGBUS",
	"SIGCHLD",
	"SIGCONT",
	"SIGFPE",
	"SIGHUP",
	"SIGILL",
	"SIGINT",
	"SIGIO",
	"SIGIOT",
	"SIGKILL",
	"SIGPIPE",
	"SIGPOLL",
	"SIGPROF",
	"SIGPWR",
	"SIGQUIT",
	"SIGSEGV",
	"SIGSTKFLT",
	"SIGSTOP",
	"SIGSYS",
	"SIGUNUSED",
	"SIGTERM",
	"SIGTRAP",
	"SIGTSTP",
	"SIGTTIN",
	"SIGTTOU",
	"SIGURG",
	"SIGUSR1",
	"SIGUSR2",
	"SIGVTALRM",
	"SIGWINCH",
	"SIGXCPU",
	"SIGXFSZ",
	"SIGBREAK",
	"SIGLOST",
	"SIGINFO",
]);

export interface RegistryFileHandle {
	read(
		buffer: Buffer,
		offset: number,
		length: number,
		position: number,
	): Promise<{ bytesRead: number }>;
	stat(): Promise<{ size: number }>;
	close(): Promise<void>;
}

export interface RegistryFileSystem {
	open(path: string, flags: string): Promise<RegistryFileHandle>;
	mkdir(path: string, options: { recursive: boolean; mode: number }): Promise<void>;
	chmod(path: string, mode: number): Promise<void>;
	writeFile(
		path: string,
		data: string,
		options: { encoding: "utf8"; mode: number },
	): Promise<void>;
	rename(oldPath: string, newPath: string): Promise<void>;
	unlink(path: string): Promise<void>;
}

export interface RegistryOperationOptions {
	/** Total deadline for the registry operation and its filesystem calls. */
	timeoutMs?: number;
	signal?: AbortSignal;
	maxFileBytes?: number;
	maxEntries?: number;
	maxOutputBytes?: number;
	io?: Partial<RegistryFileSystem>;
}

const defaultIo: RegistryFileSystem = {
	open: (path, flags) => fs.open(path, flags),
	mkdir: async (path, options) => {
		await fs.mkdir(path, options);
	},
	chmod: (path, mode) => fs.chmod(path, mode),
	writeFile: (path, data, options) => fs.writeFile(path, data, options),
	rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
	unlink: (path) => fs.unlink(path),
};

function mergedIo(options: RegistryOperationOptions): RegistryFileSystem {
	return { ...defaultIo, ...options.io };
}

function positiveLimit(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: fallback;
}

function timeoutError(description: string): Error {
	const error = new Error(description);
	error.name = "TimeoutError";
	return error;
}

function abortError(reason: unknown): Error {
	const error = new Error(
		reason instanceof Error
			? reason.message
			: reason === undefined
				? "The operation was aborted."
				: String(reason),
	);
	error.name = "AbortError";
	return error;
}

function bounded<T>(
	operation: Promise<T> | (() => Promise<T>),
	deadline: number,
	signal?: AbortSignal,
	description = "Registry filesystem operation",
): Promise<T> {
	return new Promise((resolve, reject) => {
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
		const onAbort = () => finish(() => reject(abortError(signal?.reason)));
		if (signal) {
			if (signal.aborted) return onAbort();
			signal.addEventListener("abort", onAbort, { once: true });
		}
		if (deadline <= Date.now()) return finish(() => reject(timeoutError(description)));
		const remaining = Math.max(1, Math.ceil(deadline - Date.now()));
		timer = setTimeout(
			() => finish(() => reject(timeoutError(`${description} timed out.`))),
			remaining,
		);
		timer.unref?.();
		let promise: Promise<T>;
		try {
			promise = typeof operation === "function" ? operation() : operation;
		} catch (error) {
			return finish(() => reject(error instanceof Error ? error : new Error(String(error))));
		}
		void promise.then(
			(value) => finish(() => resolve(value)),
			(error) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))),
		);
	});
}

function cleanupBounded(operation: () => Promise<void>): Promise<void> {
	try {
		return bounded(operation, Date.now() + CLEANUP_TIMEOUT_MS).catch(() => {});
	} catch {
		return Promise.resolve();
	}
}

function boundedString(value: unknown, maxBytes: number, nonempty = false): value is string {
	return (
		typeof value === "string" &&
		(!nonempty || value.length > 0) &&
		Buffer.byteLength(value, "utf8") <= maxBytes
	);
}

function safeTimestamp(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0;
}

function safeCursor(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0;
}

function optional(
	entry: Record<string, unknown>,
	key: string,
	valid: (value: unknown) => boolean,
): boolean {
	return !(key in entry) || entry[key] === undefined || valid(entry[key]);
}

function validRegistryEntry(value: unknown): value is RegistryEntry {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const entry = value as Record<string, unknown>;
	if (
		!boundedString(entry.childId, MAX_REGISTRY_TEXT_BYTES, true) ||
		!boundedString(entry.task, MAX_REGISTRY_TEXT_BYTES, true) ||
		!boundedString(entry.cwd, MAX_REGISTRY_TEXT_BYTES, true) ||
		!boundedString(entry.sessionDir, MAX_REGISTRY_TEXT_BYTES, true) ||
		!boundedString(entry.requestedModel, MAX_REGISTRY_TEXT_BYTES, true) ||
		!boundedString(entry.requestedThinking, MAX_REGISTRY_TEXT_BYTES, true) ||
		!boundedString(entry.ownerSessionFile, MAX_REGISTRY_TEXT_BYTES, true) ||
		!boundedString(entry.ownerSessionId, MAX_REGISTRY_TEXT_BYTES, true) ||
		!boundedString(entry.incarnation, MAX_REGISTRY_TEXT_BYTES, true) ||
		!THINKING_LEVELS.has(entry.requestedThinking) ||
		!PROCESS_STATES.has(entry.processState as string) ||
		!RUN_STATES.has(entry.runState as RunState) ||
		!safeTimestamp(entry.createdAt) ||
		!safeTimestamp(entry.lastActivityAt)
	)
		return false;
	if (
		!optional(entry, "name", (value) =>
			boundedString(value, MAX_REGISTRY_TEXT_BYTES),
		) ||
		!optional(entry, "pid", (value) =>
			Number.isSafeInteger(value) && Number(value) > 0,
		) ||
		!optional(entry, "exitCode", (value) =>
			value === null || (Number.isSafeInteger(value) && Number(value) >= 0),
		) ||
		!optional(entry, "exitSignal", (value) =>
			value === null || (typeof value === "string" && SIGNALS.has(value)),
		) ||
		!optional(entry, "sessionFile", (value) =>
			boundedString(value, MAX_REGISTRY_TEXT_BYTES),
		) ||
		!optional(entry, "promptPath", (value) =>
			boundedString(value, MAX_REGISTRY_TEXT_BYTES),
		) ||
		!optional(entry, "runId", safeCursor) ||
		!optional(entry, "runCursor", safeCursor) ||
		!optional(entry, "lastSettledRunId", safeCursor) ||
		!optional(entry, "runOutcome", (value) =>
			typeof value === "string" && RUN_OUTCOMES.has(value as RunOutcome),
		) ||
		!optional(entry, "settlementStatus", (value) =>
			typeof value === "string" &&
				SETTLEMENT_STATUSES.has(value as SettlementStatus),
		) ||
		!optional(entry, "error", (value) => boundedString(value, MAX_ERROR_BYTES)) ||
		!optional(entry, "killRequestedAt", safeTimestamp) ||
		!optional(entry, "osCloseObserved", (value) => typeof value === "boolean") ||
		!optional(entry, "forced", (value) => typeof value === "boolean") ||
		!optional(entry, "stderrTail", (value) =>
			boundedString(value, MAX_STDERR_TAIL_BYTES),
		) ||
		!optional(entry, "diagnostics", (value) =>
			Array.isArray(value) &&
			value.length <= MAX_DIAGNOSTICS &&
			value.every((item) => boundedString(item, MAX_DIAGNOSTIC_BYTES)),
		) ||
		!optional(entry, "outputPath", (value) =>
			boundedString(value, MAX_REGISTRY_TEXT_BYTES, true),
		) ||
		!optional(entry, "outputStatus", (value) =>
			typeof value === "string" && OUTPUT_STATUSES.has(value as OutputStatus),
		) ||
		!optional(entry, "outputError", (value) =>
			boundedString(value, MAX_OUTPUT_ERROR_BYTES),
		) ||
		!optional(entry, "resumedFrom", (value) =>
			boundedString(value, MAX_REGISTRY_TEXT_BYTES, true),
		)
	)
		return false;
	return true;
}

const REGISTRY_KEYS: readonly (keyof RegistryEntry)[] = [
	"childId",
	"name",
	"task",
	"cwd",
	"pid",
	"exitCode",
	"exitSignal",
	"sessionDir",
	"sessionFile",
	"promptPath",
	"requestedModel",
	"requestedThinking",
	"processState",
	"runState",
	"runId",
	"runCursor",
	"lastSettledRunId",
	"runOutcome",
	"settlementStatus",
	"createdAt",
	"lastActivityAt",
	"error",
	"killRequestedAt",
	"osCloseObserved",
	"forced",
	"stderrTail",
	"diagnostics",
	"outputPath",
	"outputStatus",
	"outputError",
	"ownerSessionFile",
	"ownerSessionId",
	"incarnation",
	"resumedFrom",
];

function serializableEntry(entry: RegistryEntry): RegistryEntry {
	const copy = {} as RegistryEntry;
	for (const key of REGISTRY_KEYS) {
		if (entry[key] !== undefined)
			(copy as unknown as Record<string, unknown>)[key] = entry[key];
	}
	return copy;
}

export function registryPath(
	agentDir = process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent"),
): string {
	return join(agentDir, "sessions", "subagents", "registry.json");
}

async function readRegistrySnapshot(
	file: RegistryFileHandle,
	size: number,
	deadline: number,
	signal: AbortSignal | undefined,
): Promise<string> {
	const chunks: Buffer[] = [];
	const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, Math.max(1, size)));
	let position = 0;
	while (position < size) {
		const length = Math.min(buffer.length, size - position);
		const result = await bounded(
			() => file.read(buffer, 0, length, position),
			deadline,
			signal,
			"Registry read",
		);
		if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead <= 0)
			throw new Error("Registry file changed while it was read.");
		if (result.bytesRead > length)
			throw new Error("Registry file returned an invalid read length.");
		chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)));
		position += result.bytesRead;
	}
	return Buffer.concat(chunks, size).toString("utf8");
}

export async function loadRegistry(
	path = registryPath(),
	options: RegistryOperationOptions = {},
): Promise<RegistryEntry[]> {
	const io = mergedIo(options);
	const maxFileBytes = Math.min(
		MAX_REGISTRY_FILE_BYTES,
		positiveLimit(options.maxFileBytes, MAX_REGISTRY_FILE_BYTES),
	);
	const maxEntries = Math.min(
		MAX_REGISTRY_ENTRIES,
		positiveLimit(options.maxEntries, MAX_REGISTRY_ENTRIES),
	);
	const deadline = Date.now() + positiveLimit(options.timeoutMs, DEFAULT_OPERATION_TIMEOUT_MS);
	let file: RegistryFileHandle | undefined;
	try {
		file = await bounded(() => io.open(path, "r"), deadline, options.signal, "Registry open");
		const fileStat = await bounded(() => file!.stat(), deadline, options.signal, "Registry stat");
		if (!Number.isSafeInteger(fileStat.size) || fileStat.size < 0)
			throw new Error("Registry file has an invalid size.");
		if (fileStat.size > maxFileBytes)
			throw new Error(`Registry file exceeds ${maxFileBytes} bytes.`);
		const raw = await readRegistrySnapshot(file, fileStat.size, deadline, options.signal);
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		if (parsed.length > maxEntries)
			throw new Error(`Registry contains more than ${maxEntries} entries.`);
		return parsed.filter(validRegistryEntry);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	} finally {
		if (file) await cleanupBounded(() => file!.close());
	}
}

export async function saveRegistry(
	entries: RegistryEntry[],
	path = registryPath(),
	options: RegistryOperationOptions = {},
): Promise<void> {
	const maxEntries = Math.min(
		MAX_REGISTRY_ENTRIES,
		positiveLimit(options.maxEntries, MAX_REGISTRY_ENTRIES),
	);
	const maxOutputBytes = Math.min(
		MAX_REGISTRY_OUTPUT_BYTES,
		positiveLimit(options.maxOutputBytes, MAX_REGISTRY_OUTPUT_BYTES),
	);
	if (entries.length > maxEntries)
		throw new Error(`Registry contains more than ${maxEntries} entries.`);
	const normalized = entries.map((entry) => {
		if (!validRegistryEntry(entry)) throw new Error("Registry contains an invalid entry.");
		const copy = serializableEntry(entry);
		const compact = JSON.stringify(copy);
		if (Buffer.byteLength(compact, "utf8") > MAX_REGISTRY_ENTRY_BYTES)
			throw new Error(`Registry entry exceeds ${MAX_REGISTRY_ENTRY_BYTES} bytes.`);
		return copy;
	});
	const estimatedBytes = normalized.reduce(
		(total, entry) => total + Buffer.byteLength(JSON.stringify(entry), "utf8") + 4,
		2,
	);
	if (estimatedBytes > maxOutputBytes)
		throw new Error(`Registry output exceeds ${maxOutputBytes} bytes.`);
	let serialized: string;
	try {
		serialized = `${JSON.stringify(normalized, null, 2)}\n`;
	} catch (error) {
		throw error instanceof Error ? error : new Error(String(error));
	}
	if (Buffer.byteLength(serialized, "utf8") > maxOutputBytes)
		throw new Error(`Registry output exceeds ${maxOutputBytes} bytes.`);
	const io = mergedIo(options);
	const deadline = Date.now() + positiveLimit(options.timeoutMs, DEFAULT_OPERATION_TIMEOUT_MS);
	await bounded(
		() => io.mkdir(dirname(path), { recursive: true, mode: 0o700 }),
		deadline,
		options.signal,
		"Registry directory creation",
	);
	await bounded(() => io.chmod(dirname(path), 0o700), deadline, options.signal, "Registry directory permissions");
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${randomBytes(8).toString("hex")}`;
	try {
		await bounded(
			() => io.writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 }),
			deadline,
			options.signal,
			"Registry write",
		);
		await bounded(() => io.chmod(temporary, 0o600), deadline, options.signal, "Registry temporary permissions");
		await bounded(() => io.rename(temporary, path), deadline, options.signal, "Registry publication");
		await bounded(() => io.chmod(path, 0o600), deadline, options.signal, "Registry permissions");
	} finally {
		await cleanupBounded(() => io.unlink(temporary));
	}
}

export function registryEntriesForOwner(
	entries: RegistryEntry[],
	owner: OwnerIdentity,
): RegistryEntry[] {
	return entries
		.filter(
			(entry) =>
				entry.ownerSessionFile === owner.ownerSessionFile &&
				entry.ownerSessionId === owner.ownerSessionId &&
				!!entry.incarnation,
		)
		.map((entry) => ({ ...entry }));
}
