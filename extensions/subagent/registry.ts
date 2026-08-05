import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RunState } from "./lifecycle.js";
import type { OwnerIdentity } from "./owner.js";

export interface RegistryEntry {
	childId: string;
	name?: string;
	task: string;
	cwd: string;
	tabId?: number;
	paneId?: number;
	zellijSessionName?: string;
	terminalCleanupPending?: boolean;
	terminalCleanupError?: string;
	sessionDir: string;
	socketPath: string;
	sessionFile?: string;
	promptPath?: string;
	requestedModel: string;
	requestedThinking: string;
	processState: "alive" | "stopped";
	runState: RunState;
	runId?: number;
	lastSettledRunId?: number;
	createdAt: number;
	lastActivityAt: number;
	detached?: boolean;
	ownerSessionFile: string;
	ownerSessionId: string;
	controllerInstanceId: string;
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

export async function saveRegistry(entries: RegistryEntry[], path = registryPath()): Promise<void> {
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

export function helloMatchesRegistryChild(expectedChildId: string, helloChildId: unknown): boolean {
	return typeof helloChildId === "string" && helloChildId === expectedChildId;
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
