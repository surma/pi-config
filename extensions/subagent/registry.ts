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

export function registryPath(
	agentDir = process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent"),
): string {
	return join(agentDir, "sessions", "subagents", "registry.json");
}

export async function loadRegistry(path = registryPath()): Promise<RegistryEntry[]> {
	try {
		const parsed: unknown = JSON.parse(await fs.readFile(path, "utf8"));
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(entry): entry is RegistryEntry =>
				!!entry &&
				typeof entry === "object" &&
				typeof (entry as RegistryEntry).childId === "string" &&
				typeof (entry as RegistryEntry).sessionDir === "string",
		);
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
