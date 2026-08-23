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
	return !(key in entry) || valid(entry[key]);
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

export function registryPath(
	agentDir = process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent"),
): string {
	return join(agentDir, "sessions", "subagents", "registry.json");
}

export async function loadRegistry(path = registryPath()): Promise<RegistryEntry[]> {
	try {
		const parsed: unknown = JSON.parse(await fs.readFile(path, "utf8"));
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(validRegistryEntry);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

export async function saveRegistry(
	entries: RegistryEntry[],
	path = registryPath(),
): Promise<void> {
	await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await fs.chmod(dirname(path), 0o700).catch(() => {});
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
	try {
		await fs.writeFile(temporary, `${JSON.stringify(entries, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		await fs.chmod(temporary, 0o600).catch(() => {});
		await fs.rename(temporary, path);
		await fs.chmod(path, 0o600).catch(() => {});
	} finally {
		await fs.unlink(temporary).catch(() => {});
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
