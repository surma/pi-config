import { spawn } from "node:child_process";
import { resolve } from "node:path";
import {
	ZELLIJ_ACTION_KILL_GRACE_MS,
	ZELLIJ_ACTION_TIMEOUT_MS,
} from "./liveness.js";

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
const MANAGED_SESSION_STARTUP_TIMEOUT_MS = 1_000;
let managedSessionName: string | undefined;
let targetSessionName: string | undefined;

export function invalidateSessionCache(): void {
	targetSessionName = undefined;
}

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
 * Resolve and cache the current Zellij session from the parent pane identity.
 * Missing-session failures invalidate the cache. Outside Zellij, start and
 * retain a detached session.
 */
export async function ensureZellij(cwd = process.cwd()): Promise<string> {
	if (targetSessionName) return targetSessionName;
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
		let clientClosed = false;
		let released = false;
		let killTimer: NodeJS.Timeout | undefined;
		const release = () => {
			if (released) return;
			released = true;
			clearTimeout(startupTimer);
			resolveSpawn();
		};
		const clientFinished = () => {
			clientClosed = true;
			if (killTimer) clearTimeout(killTimer);
			release();
		};
		const startupTimer = setTimeout(() => {
			if (!clientClosed) {
				proc.kill("SIGTERM");
				killTimer = setTimeout(() => {
					if (!clientClosed) proc.kill("SIGKILL");
				}, ZELLIJ_ACTION_KILL_GRACE_MS);
				killTimer.unref();
			}
			release();
		}, MANAGED_SESSION_STARTUP_TIMEOUT_MS);
		startupTimer.unref();
		proc.on("error", clientFinished);
		proc.on("close", clientFinished);
		proc.unref();
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

interface ZellijClientResult {
	stdout: string;
	stderr: string;
	code: number | null;
}

function runBoundedZellijClient(
	binary: string,
	args: string[],
): Promise<ZellijClientResult> {
	return new Promise((resolveResult, reject) => {
		const proc = spawn(binary, args, {
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		let killTimer: NodeJS.Timeout | undefined;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			proc.kill("SIGTERM");
			killTimer = setTimeout(
				() => proc.kill("SIGKILL"),
				ZELLIJ_ACTION_KILL_GRACE_MS,
			);
			killTimer.unref();
			reject(
				new Error(
					`zellij ${args[0] || "client"} timed out after ${ZELLIJ_ACTION_TIMEOUT_MS}ms`,
				),
			);
		}, ZELLIJ_ACTION_TIMEOUT_MS);
		timeout.unref();
		const settle = (result: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (killTimer) clearTimeout(killTimer);
			result();
		};
		proc.stdout.setEncoding("utf8");
		proc.stderr.setEncoding("utf8");
		proc.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		proc.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		proc.on("error", (error) => settle(() => reject(error)));
		proc.on("close", (code) => {
			if (killTimer) clearTimeout(killTimer);
			settle(() => resolveResult({ stdout, stderr, code }));
		});
	});
}

async function listSessionNames(binary: string): Promise<string[]> {
	try {
		const { stdout } = await runBoundedZellijClient(binary, [
			"list-sessions",
			"--short",
			"--no-formatting",
		]);
		return stdout.trim().split("\n").filter(Boolean);
	} catch {
		return [];
	}
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
	await runBoundedZellijClient(binary, ["kill-session", name]).catch(() => {});
}

export async function actionInSession(
	binary: string,
	sessionName: string,
	args: string[],
): Promise<string> {
	return new Promise((resolveOutput, reject) => {
		const proc = spawn(binary, ["--session", sessionName, "action", ...args], {
			env: process.env,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		let killTimer: NodeJS.Timeout | undefined;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			proc.kill("SIGTERM");
			killTimer = setTimeout(() => proc.kill("SIGKILL"), ZELLIJ_ACTION_KILL_GRACE_MS);
			killTimer.unref();
			reject(
				new Error(
					`zellij action ${args[0]} timed out after ${ZELLIJ_ACTION_TIMEOUT_MS}ms for session ${sessionName}`,
				),
			);
		}, ZELLIJ_ACTION_TIMEOUT_MS);
		timeout.unref();
		const settle = (result: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (killTimer) clearTimeout(killTimer);
			result();
		};
		proc.stdout.setEncoding("utf8");
		proc.stderr.setEncoding("utf8");
		proc.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		proc.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		proc.on("error", (error) => settle(() => reject(error)));
		proc.on("close", (code) => {
			if (killTimer) clearTimeout(killTimer);
			settle(() => {
				if (code === 0) {
					resolveOutput(stdout);
					return;
				}
				const output = [
					stdout.trim() ? `stdout: ${JSON.stringify(stdout.trim())}` : undefined,
					stderr.trim() ? `stderr: ${JSON.stringify(stderr.trim())}` : undefined,
				]
					.filter(Boolean)
					.join("; ");
				reject(
					new Error(
						`zellij action ${args[0]} failed for session ${sessionName} (${code ?? "unknown"}): ${output || "no output"}`,
					),
				);
			});
		});
	});
}

function isSessionTargetError(error: unknown): boolean {
	return /session.*(not found|does not exist)|no such session/i.test(String(error));
}

async function action(args: string[]): Promise<string> {
	const sessionName = await ensureZellij();
	try {
		return await actionInSession(zellijBinary(), sessionName, args);
	} catch (error) {
		if (targetSessionName === sessionName && isSessionTargetError(error))
			targetSessionName = undefined;
		throw error;
	}
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
): Promise<{ tabId: number; sessionName: string }> {
	const sessionName = await ensureZellij();
	let stdout: string;
	try {
		stdout = await actionInSession(
			zellijBinary(),
			sessionName,
			buildNewTabArgs(name, cwd, cmd, env),
		);
	} catch (error) {
		if (targetSessionName === sessionName && isSessionTargetError(error))
			targetSessionName = undefined;
		throw error;
	}
	const tabId = Number.parseInt(stdout.trim(), 10);
	if (!Number.isFinite(tabId) || tabId <= 0)
		throw new Error(
			`zellij new-tab returned an invalid tab id: ${JSON.stringify(stdout.trim())}`,
		);
	return { tabId, sessionName };
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

function paneMatchesLaunchIdentity(
	pane: PaneInfo,
	tabId: number,
	identity: SubagentPaneIdentity,
): boolean {
	if (pane.tab_id !== tabId || pane.is_plugin || pane.exited || !paneRunsPi(pane))
		return false;
	const command = `${pane.pane_command || ""} ${pane.terminal_command || ""}`;
	return (
		command.includes(`PI_SUBAGENT_CHILD_ID=${identity.childId}`) &&
		command.includes(`BRIDGE_SOCKET_PATH=${identity.socketPath}`) &&
		command.includes(
			`PI_SUBAGENT_OWNER_SESSION_FILE=${identity.ownerSessionFile}`,
		) &&
		command.includes(`PI_SUBAGENT_OWNER_SESSION_ID=${identity.ownerSessionId}`) &&
		command.includes(
			`PI_SUBAGENT_CONTROLLER_INSTANCE_ID=${identity.controllerInstanceId}`,
		) &&
		command.includes(`PI_SUBAGENT_INCARNATION=${identity.incarnation}`)
	);
}

export async function discoverPaneId(
	tabId: number,
	identity: SubagentPaneIdentity,
	timeoutMs = 3000,
): Promise<number> {
	const deadline = Date.now() + timeoutMs;
	do {
		const pane = (await listPanes()).find((candidate) =>
			paneMatchesLaunchIdentity(candidate, tabId, identity),
		);
		if (pane) return pane.id;
		await new Promise((resolve) => setTimeout(resolve, 50));
	} while (Date.now() < deadline);
	throw new Error(
		`Could not discover a live Pi pane with the expected identity for Zellij tab ${tabId}.`,
	);
}

export async function sendKeysInSession(
	sessionName: string,
	paneId: number,
	key: string,
): Promise<void> {
	await actionInSession(zellijBinary(), sessionName, [
		"send-keys",
		"-p",
		String(paneId),
		key,
	]);
}

export async function closePaneInSession(
	sessionName: string,
	paneId: number,
): Promise<void> {
	await actionInSession(zellijBinary(), sessionName, [
		"close-pane",
		"--pane-id",
		`terminal_${paneId}`,
	]);
}
