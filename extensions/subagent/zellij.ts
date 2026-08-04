import { spawn } from "node:child_process";
import { resolve } from "node:path";

export interface PaneInfo {
	id: number;
	tab_id: number;
	is_plugin: boolean;
	exited: boolean;
	exit_status?: number | null;
	pane_command?: string;
	terminal_command?: string;
	pane_cwd?: string;
	is_focused?: boolean;
}
export interface ZellijSessionSnapshot {
	name: string;
	panes: PaneInfo[];
}
export interface TabInfo {
	tab_id: number;
	name?: string;
}
export interface SubagentPaneIdentity {
	childId: string;
	socketPath: string;
	ownerSessionFile: string;
	ownerSessionId: string;
	controllerInstanceId: string;
	incarnation: string;
}

let managedSessionName: string | undefined;
let targetSessionName: string | undefined;

function paneRunsPi(pane: PaneInfo): boolean {
	const command = `${pane.pane_command || ""} ${pane.terminal_command || ""}`;
	return /(^|[/\s])pi([\s.]|$)|coding-agent/.test(command.toLowerCase());
}

export function selectZellijSessionForPane(
	snapshots: ZellijSessionSnapshot[],
	paneId: number,
	cwd: string,
): string {
	const liveCandidates = snapshots.filter((snapshot) =>
		snapshot.panes.some(
			(pane) =>
				pane.id === paneId &&
				!pane.is_plugin &&
				!pane.exited &&
				paneRunsPi(pane),
		),
	);
	const cwdCandidates = liveCandidates.filter((snapshot) =>
		snapshot.panes.some(
			(pane) =>
				pane.id === paneId &&
				!pane.is_plugin &&
				!pane.exited &&
				paneRunsPi(pane) &&
				typeof pane.pane_cwd === "string" &&
				resolve(pane.pane_cwd) === resolve(cwd),
		),
	);
	const candidates = cwdCandidates.length ? cwdCandidates : liveCandidates;
	if (candidates.length === 1) return candidates[0]!.name;
	throw new Error(
		`Could not uniquely identify the current Zellij session for pane ${paneId} at ${cwd}. ` +
		"Open Pi in a fresh Zellij pane, then retry delegation.",
	);
}

function zellijBinary(): string {
	return process.env.PI_SUBAGENT_ZELLIJ_BIN || "zellij";
}

/**
 * @deprecated Use ensureZellij() instead.
 */
export function requireZellij(): void {
	if (!process.env.ZELLIJ_SESSION_NAME)
		throw new Error(
			"Subagent delegation requires running inside a Zellij session. Start pi inside zellij first.",
		);
}

/**
 * Resolve the current Zellij session from the parent pane identity. The
 * resolver checks every action so a session rename cannot stale the target.
 * Outside Zellij, start and retain a detached session.
 */
export async function ensureZellij(cwd = process.cwd()): Promise<string> {
	const binary = zellijBinary();
	const paneId = Number.parseInt(process.env.ZELLIJ_PANE_ID || "", 10);
	const isInsideZellij =
		process.env.ZELLIJ !== undefined || process.env.ZELLIJ_PANE_ID !== undefined;
	if (isInsideZellij) {
		if (!Number.isFinite(paneId) || paneId < 0)
			throw new Error(
				"Could not identify the current Zellij pane. Open Pi in a fresh Zellij pane, then retry delegation.",
			);
		const sessions = await listSessionNames(binary);
		const snapshots = await Promise.all(
			sessions.map(async (name) => ({
				name,
				panes: await listPanesInSession(binary, name),
			})),
		);
		targetSessionName = selectZellijSessionForPane(snapshots, paneId, cwd);
		return targetSessionName;
	}
	if (targetSessionName) return targetSessionName;

	// A caller outside Zellij can provide an explicit target. This path also
	// keeps fake Zellij implementations deterministic in unit tests.
	if (process.env.ZELLIJ_SESSION_NAME) {
		targetSessionName = process.env.ZELLIJ_SESSION_NAME;
		return targetSessionName;
	}
	if (managedSessionName) {
		targetSessionName = managedSessionName;
		return targetSessionName;
	}

	const sessionName = `pi-subagent-${process.pid}`;

	// Start a zellij session. The server process starts independently of the
	// client. Without a real terminal the client exits immediately, but the
	// server persists and accepts `zellij action` commands.
	await new Promise<void>((resolveSpawn) => {
		const proc = spawn(binary, ["-s", sessionName], {
			stdio: "ignore",
			detached: true,
			shell: false,
		});
		proc.unref();
		proc.on("error", () => resolveSpawn());
		proc.on("close", () => resolveSpawn());
		// Server may need a moment to bind its socket.
		setTimeout(resolveSpawn, 1000);
	});

	// Verify the session exists.
	const sessions = await listSessionNames(binary);
	if (!sessions.includes(sessionName)) {
		throw new Error(
			`Failed to start a detached Zellij session ("${sessionName}"). ` +
			"Make sure zellij is installed and on PATH " +
			"(or set PI_SUBAGENT_ZELLIJ_BIN).",
		);
	}

	managedSessionName = sessionName;
	targetSessionName = sessionName;
	return targetSessionName;
}

async function listSessionNames(binary: string): Promise<string[]> {
	return new Promise((resolve) => {
		const proc = spawn(binary, ["list-sessions", "--short", "--no-formatting"], {
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
		});
		let stdout = "";
		proc.stdout.setEncoding("utf8");
		proc.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		proc.on("error", () => resolve([]));
		proc.on("close", () =>
			resolve(stdout.trim().split("\n").filter(Boolean)),
		);
	});
}

/**
 * Kill a managed Zellij session that was auto-started by ensureZellij().
 * Safe to call multiple times or when no managed session exists.
 */
export async function cleanupManagedSession(): Promise<void> {
	if (!managedSessionName) return;
	const name = managedSessionName;
	managedSessionName = undefined;
	if (targetSessionName === name) targetSessionName = undefined;
	const binary = zellijBinary();
	await new Promise<void>((resolve) => {
		const proc = spawn(binary, ["kill-session", name], {
			stdio: "ignore",
			shell: false,
		});
		proc.on("error", () => resolve());
		proc.on("close", () => resolve());
	});
}

async function actionInSession(
	binary: string,
	sessionName: string,
	args: string[],
): Promise<string> {
	return new Promise((resolveOutput, reject) => {
		const proc = spawn(
			binary,
			["--session", sessionName, "action", ...args],
			{
				env: process.env,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		proc.stdout.setEncoding("utf8");
		proc.stderr.setEncoding("utf8");
		proc.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		proc.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		proc.on("error", reject);
		proc.on("close", (code) =>
			code === 0
				? resolveOutput(stdout)
				: reject(
						new Error(
							`zellij action ${args[0]} failed for session ${sessionName} (${code ?? "unknown"}): ${stderr.trim() || stdout.trim()}`,
						),
					),
		);
	});
}

async function action(args: string[]): Promise<string> {
	const sessionName = await ensureZellij();
	return actionInSession(zellijBinary(), sessionName, args);
}

export function buildNewTabArgs(
	name: string,
	cwd: string,
	cmd: string[],
	env: Record<string, string>,
): string[] {
	const envArgs = Object.entries(env).map(([key, value]) => `${key}=${value}`);
	return ["new-tab", "-n", name, "-c", cwd, "--", "env", ...envArgs, ...cmd];
}

export async function newTab(
	name: string,
	cwd: string,
	cmd: string[],
	env: Record<string, string>,
): Promise<number> {
	const stdout = await action(buildNewTabArgs(name, cwd, cmd, env));
	const tabId = Number.parseInt(stdout.trim(), 10);
	if (!Number.isFinite(tabId) || tabId <= 0)
		throw new Error(
			`zellij new-tab returned an invalid tab id: ${JSON.stringify(stdout.trim())}`,
		);
	return tabId;
}

function parsePanes(stdout: string): PaneInfo[] {
	const parsed: unknown = JSON.parse(stdout);
	if (!Array.isArray(parsed))
		throw new Error("zellij list-panes returned non-array JSON.");
	return parsed.filter(
		(value): value is PaneInfo =>
			!!value &&
			typeof value === "object" &&
			typeof (value as PaneInfo).id === "number" &&
			typeof (value as PaneInfo).tab_id === "number" &&
			(value as PaneInfo).is_plugin === false,
	);
}

async function listPanesInSession(
	binary: string,
	sessionName: string,
): Promise<PaneInfo[]> {
	return parsePanes(
		await actionInSession(binary, sessionName, ["list-panes", "--json", "-a"]),
	);
}

export async function listPanes(): Promise<PaneInfo[]> {
	const sessionName = await ensureZellij();
	return listPanesInSession(zellijBinary(), sessionName);
}

export async function listTabs(): Promise<TabInfo[]> {
	const parsed: unknown = JSON.parse(
		await action(["list-tabs", "--json", "-a"]),
	);
	if (!Array.isArray(parsed))
		throw new Error("zellij list-tabs returned non-array JSON.");
	return parsed.filter(
		(value): value is TabInfo =>
			!!value &&
			typeof value === "object" &&
			typeof (value as TabInfo).tab_id === "number",
	);
}

export async function discoverPaneId(
	tabId: number,
	timeoutMs = 3000,
): Promise<number> {
	const deadline = Date.now() + timeoutMs;
	do {
		const pane = (await listPanes()).find(
			(candidate) => candidate.tab_id === tabId && !candidate.exited,
		);
		if (pane) return pane.id;
		await new Promise((resolve) => setTimeout(resolve, 50));
	} while (Date.now() < deadline);
	throw new Error(`Could not discover a live pane for Zellij tab ${tabId}.`);
}

function paneMatchesIdentity(
	pane: PaneInfo,
	tabId: number,
	paneId: number,
	identity: SubagentPaneIdentity | undefined,
	allowExited: boolean,
): boolean {
	if (
		pane.id !== paneId ||
		pane.tab_id !== tabId ||
		pane.is_plugin ||
		(!allowExited && pane.exited)
	)
		return false;
	const command = `${pane.pane_command || ""} ${pane.terminal_command || ""}`;
	if (!paneRunsPi(pane)) return false;
	if (!identity) return true;
	return (
		command.includes(`PI_SUBAGENT_CHILD_ID=${identity.childId}`) &&
		command.includes(`BRIDGE_SOCKET_PATH=${identity.socketPath}`) &&
		command.includes(
			`PI_SUBAGENT_OWNER_SESSION_FILE=${identity.ownerSessionFile}`,
		) &&
		command.includes(
			`PI_SUBAGENT_OWNER_SESSION_ID=${identity.ownerSessionId}`,
		) &&
		command.includes(
			`PI_SUBAGENT_CONTROLLER_INSTANCE_ID=${identity.controllerInstanceId}`,
		) &&
		command.includes(`PI_SUBAGENT_INCARNATION=${identity.incarnation}`)
	);
}

export function paneMatchesSubagent(
	pane: PaneInfo,
	tabId: number,
	paneId: number,
	identity?: SubagentPaneIdentity,
): boolean {
	return paneMatchesIdentity(pane, tabId, paneId, identity, false);
}

export async function revalidatePane(
	tabId: number,
	paneId: number,
	identity?: SubagentPaneIdentity,
): Promise<boolean> {
	const pane = (await listPanes()).find(
		(candidate) => candidate.id === paneId && candidate.tab_id === tabId,
	);
	return pane ? paneMatchesSubagent(pane, tabId, paneId, identity) : false;
}

export async function sendKeys(paneId: number, key: string): Promise<void> {
	await action(["send-keys", "-p", String(paneId), key]);
}
export async function closeTab(tabId: number): Promise<void> {
	await action(["close-tab-by-id", String(tabId)]);
}

export async function closeValidatedSubagentTab(
	tabId: number,
	paneId: number,
	identity: SubagentPaneIdentity,
): Promise<boolean> {
	const pane = (await listPanes()).find(
		(candidate) => candidate.id === paneId && candidate.tab_id === tabId,
	);
	if (!pane || !paneMatchesIdentity(pane, tabId, paneId, identity, true))
		return false;
	await closeTab(tabId);
	return true;
}
