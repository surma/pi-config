import { spawn } from "node:child_process";
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
export interface TabInfo { tab_id: number; name?: string }
export interface SubagentPaneIdentity {
	childId: string;
	socketPath: string;
	ownerSessionFile: string;
	ownerSessionId: string;
	controllerInstanceId: string;
	incarnation: string;
}
export interface ZellijClientResult {
	stdout: string;
	stderr: string;
	code: number | null;
	timedOut: boolean;
}

function zellijBinary(): string { return process.env.PI_SUBAGENT_ZELLIJ_BIN || "zellij"; }

/**
 * The promise settles only after the client closes. Timeout means command
 * completion is uncertain, not that its process was left behind.
 */
export function runBoundedZellijClient(binary: string, args: string[]): Promise<ZellijClientResult> {
	return new Promise((resolveResult, reject) => {
		let proc;
		try {
			proc = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
		} catch (error) {
			reject(error);
			return;
		}
		let stdout = "";
		let stderr = "";
		let closed = false;
		let timedOut = false;
		let spawnError: Error | undefined;
		let killTimer: NodeJS.Timeout | undefined;
		const timeout = setTimeout(() => {
			if (closed) return;
			timedOut = true;
			proc.kill("SIGTERM");
			killTimer = setTimeout(() => {
				if (!closed) proc.kill("SIGKILL");
			}, ZELLIJ_ACTION_KILL_GRACE_MS);
			killTimer.unref();
		}, ZELLIJ_ACTION_TIMEOUT_MS);
		timeout.unref();
		proc.stdout.setEncoding("utf8");
		proc.stderr.setEncoding("utf8");
		proc.stdout.on("data", (chunk: string) => { stdout += chunk; });
		proc.stderr.on("data", (chunk: string) => { stderr += chunk; });
		proc.on("error", (error) => { spawnError = error; });
		proc.on("close", (code) => {
			closed = true;
			clearTimeout(timeout);
			if (killTimer) clearTimeout(killTimer);
			if (timedOut) {
				reject(new Error(`zellij ${args[0] || "client"} timed out after ${ZELLIJ_ACTION_TIMEOUT_MS}ms; command completion is uncertain.`));
				return;
			}
			if (spawnError) { reject(spawnError); return; }
			resolveResult({ stdout, stderr, code, timedOut: false });
		});
	});
}

function errorFor(result: ZellijClientResult, description: string): Error {
	const output = [
		result.stdout.trim() ? `stdout: ${JSON.stringify(result.stdout.trim())}` : undefined,
		result.stderr.trim() ? `stderr: ${JSON.stringify(result.stderr.trim())}` : undefined,
	].filter(Boolean).join("; ");
	return new Error(`${description} (${result.code ?? "unknown"}): ${output || "no output"}`);
}

export async function actionInSession(binary: string, sessionName: string, args: string[]): Promise<string> {
	const result = await runBoundedZellijClient(binary, ["--session", sessionName, "action", ...args]);
	if (result.code !== 0) throw errorFor(result, `zellij action ${args[0] || "client"} failed for session ${sessionName}`);
	return result.stdout;
}

function isNoActiveSessionsResult(result: ZellijClientResult): boolean {
	return result.code === 1 &&
		result.stdout.trim() === "" &&
		result.stderr.trim() === "No active zellij sessions found.";
}

export async function listSessionNames(binary = zellijBinary()): Promise<string[]> {
	const result = await runBoundedZellijClient(binary, ["list-sessions", "--short", "--no-formatting"]);
	if (isNoActiveSessionsResult(result)) return [];
	if (result.code !== 0) throw errorFor(result, "zellij list-sessions failed");
	return result.stdout.split("\n").map((name) => name.trim()).filter(Boolean);
}

export async function sessionExists(sessionName: string, binary = zellijBinary()): Promise<boolean> {
	return (await listSessionNames(binary)).includes(sessionName);
}

/** Create exactly the session supplied by the lifecycle record. */
export async function createDedicatedSession(sessionName: string, binary = zellijBinary()): Promise<void> {
	const result = await runBoundedZellijClient(binary, ["attach", "--create-background", sessionName]);
	if (result.code !== 0) throw errorFor(result, `zellij create session ${sessionName} failed`);
	if (!(await sessionExists(sessionName, binary)))
		throw new Error(`Zellij did not create the exact dedicated session ${sessionName}.`);
}

/** Delete exactly this name and independently prove that it is absent. */
export async function deleteDedicatedSession(sessionName: string, binary = zellijBinary()): Promise<void> {
	const result = await runBoundedZellijClient(binary, ["delete-session", "--force", sessionName]);
	if (result.code !== 0 && await sessionExists(sessionName, binary))
		throw errorFor(result, `zellij delete session ${sessionName} failed`);
	if (await sessionExists(sessionName, binary))
		throw new Error(`Zellij session ${sessionName} remains after deletion.`);
}

export function buildNewTabArgs(name: string, cwd: string, cmd: string[], env: Record<string, string>): string[] {
	const envArgs = Object.entries(env).map(([key, value]) => `${key}=${value}`);
	return ["new-tab", "-n", name, "-c", cwd, "--", "env", ...envArgs, ...cmd];
}

export async function newTabInSession(sessionName: string, name: string, cwd: string, cmd: string[], env: Record<string, string>): Promise<{ tabId: number; sessionName: string }> {
	const stdout = await actionInSession(zellijBinary(), sessionName, buildNewTabArgs(name, cwd, cmd, env));
	const tabId = Number.parseInt(stdout.trim(), 10);
	if (!Number.isFinite(tabId) || tabId <= 0) throw new Error(`zellij new-tab returned an invalid tab id: ${JSON.stringify(stdout.trim())}`);
	return { tabId, sessionName };
}

function paneRunsPi(pane: PaneInfo): boolean {
	const command = `${pane.pane_command || ""} ${pane.terminal_command || ""}`;
	return /(^|[/\s])pi([\s.]|$)|coding-agent/.test(command.toLowerCase());
}
function parsePanes(stdout: string): PaneInfo[] {
	const parsed: unknown = JSON.parse(stdout);
	if (!Array.isArray(parsed)) throw new Error("zellij list-panes returned non-array JSON.");
	return parsed.filter((value): value is PaneInfo => !!value && typeof value === "object" && typeof (value as PaneInfo).id === "number" && typeof (value as PaneInfo).tab_id === "number" && (value as PaneInfo).is_plugin === false);
}
export async function listPanesInSession(sessionName: string): Promise<PaneInfo[]> {
	return parsePanes(await actionInSession(zellijBinary(), sessionName, ["list-panes", "--json", "-a"]));
}
function paneMatchesLaunchIdentity(pane: PaneInfo, tabId: number, identity: SubagentPaneIdentity): boolean {
	if (pane.tab_id !== tabId || pane.is_plugin || pane.exited || !paneRunsPi(pane)) return false;
	const command = `${pane.pane_command || ""} ${pane.terminal_command || ""}`;
	return command.includes(`PI_SUBAGENT_CHILD_ID=${identity.childId}`) && command.includes(`BRIDGE_SOCKET_PATH=${identity.socketPath}`) && command.includes(`PI_SUBAGENT_OWNER_SESSION_FILE=${identity.ownerSessionFile}`) && command.includes(`PI_SUBAGENT_OWNER_SESSION_ID=${identity.ownerSessionId}`) && command.includes(`PI_SUBAGENT_CONTROLLER_INSTANCE_ID=${identity.controllerInstanceId}`) && command.includes(`PI_SUBAGENT_INCARNATION=${identity.incarnation}`);
}
export async function discoverPaneIdInSession(sessionName: string, tabId: number, identity: SubagentPaneIdentity, timeoutMs = 3000): Promise<number> {
	const deadline = Date.now() + timeoutMs;
	do {
		const pane = (await listPanesInSession(sessionName)).find((candidate) => paneMatchesLaunchIdentity(candidate, tabId, identity));
		if (pane) return pane.id;
		await new Promise((resolve) => setTimeout(resolve, 50));
	} while (Date.now() < deadline);
	throw new Error(`Could not discover a live Pi pane with the expected identity for Zellij tab ${tabId}.`);
}
export async function sendKeysInSession(sessionName: string, paneId: number, key: string): Promise<void> {
	await actionInSession(zellijBinary(), sessionName, ["send-keys", "-p", String(paneId), key]);
}
export async function closePaneInSession(sessionName: string, paneId: number): Promise<void> {
	await actionInSession(zellijBinary(), sessionName, ["close-pane", "--pane-id", `terminal_${paneId}`]);
}
