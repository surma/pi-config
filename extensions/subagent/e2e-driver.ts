import assert from "node:assert/strict";
import { watch } from "node:fs";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	stat,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import subagentExtension from "./index.ts";
import { RpcChildTransport } from "./rpc.ts";
import { ownerRegistryPath } from "./owner.ts";

type TestResult = {
	content: { type?: string; text: string }[];
	details: Record<string, any>;
};

type TestTool = {
	name: string;
	execute(...args: any[]): Promise<TestResult>;
};
type TestHandler = (...args: any[]) => unknown;

type UiState = {
	throwNextWidget: boolean;
};

type DriverRuntime = {
	root: string;
	agentDirectory: string;
	parentSession?: string;
	logPath: string;
	markerPath: string;
	controlPath: string;
	ctx: ExtensionContext;
	handlers: Map<string, TestHandler>;
	tools: Map<string, TestTool>;
	sent: any[];
	uiState: UiState;
};

const scenario = process.argv[2] || "";
const fakePi = process.env.E2E_FAKE_PI;
if (!fakePi) throw new Error("E2E_FAKE_PI is not set.");

let uncaughtException: string | undefined;
let unhandledRejection: string | undefined;
process.on("uncaughtException", (error) => {
	uncaughtException ||= error instanceof Error ? error.message : String(error);
});
process.on("unhandledRejection", (reason) => {
	unhandledRejection ||= reason instanceof Error ? reason.message : String(reason);
});

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout<T>(
	promise: Promise<T>,
	milliseconds: number,
	label: string,
): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`${label} timed out after ${milliseconds} ms.`)),
					milliseconds,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	milliseconds = 2_000,
	label = "condition",
): Promise<void> {
	const deadline = Date.now() + milliseconds;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await delay(10);
	}
	if (await predicate()) return;
	throw new Error(`${label} timed out after ${milliseconds} ms.`);
}

async function fileContains(path: string, value: string): Promise<boolean> {
	try {
		return (await readFile(path, "utf8")).includes(value);
	} catch {
		return false;
	}
}

async function waitForMarker(
	runtime: DriverRuntime,
	value: string,
	milliseconds = 3_000,
): Promise<void> {
	await waitFor(
		() => fileContains(runtime.markerPath, value),
		milliseconds,
		`marker ${value}`,
	);
}

function context(
	runtime: DriverRuntime,
	mode: "json" | "tui",
	persistent: boolean,
): ExtensionContext {
	const ui = {
		setStatus: () => {},
		setWidget: () => {
			if (runtime.uiState.throwNextWidget) {
				runtime.uiState.throwNextWidget = false;
				throw new Error("E2E close callback UI failure");
			}
		},
		notify: () => {},
	};
	return {
		mode,
		cwd: runtime.root,
		ui,
		sessionManager: {
			getSessionFile: () =>
				persistent ? runtime.parentSession : undefined,
			getSessionId: () => (persistent ? "e2e-parent" : undefined),
		},
		model: { provider: "provider", id: "model" },
		modelRegistry: {
			getAll: () => [{ provider: "provider", id: "model" }],
			getAvailable: () => [{ provider: "provider", id: "model" }],
		},
	} as unknown as ExtensionContext;
}

function installExtension(
	runtime: DriverRuntime,
	mode: "json" | "tui",
	persistent: boolean,
): void {
	const handlers = new Map<string, TestHandler>();
	const tools = new Map<string, TestTool>();
	const api = {
		on: (name: string, handler: TestHandler) => handlers.set(name, handler),
		registerTool: (value: unknown) => {
			const tool = value as TestTool;
			tools.set(tool.name, tool);
		},
		registerCommand: () => {},
		getActiveTools: () => ["read"],
		getThinkingLevel: () => "off",
		sendMessage: (message: unknown, options: unknown) =>
			runtime.sent.push({ message, options }),
	};
	subagentExtension(api as unknown as ExtensionAPI);
	runtime.handlers = handlers;
	runtime.tools = tools;
	runtime.ctx = context(runtime, mode, persistent);
}

async function createRuntime(options: {
	mode: string;
	contextMode?: "json" | "tui";
	persistent?: boolean;
	floodCount?: number;
	reloadQueueCount?: number;
	abortResponseDelay?: number;
	deferSessionStart?: boolean;
}): Promise<DriverRuntime> {
	const root = await mkdtemp(join(tmpdir(), "pi-subagent-e2e-"));
	const agentDirectory = join(root, "agent");
	const parentSession = join(root, "parent.jsonl");
	const logPath = join(root, "fake-pi.log");
	const markerPath = join(root, "markers.log");
	const controlPath = join(root, "control");
	await mkdir(agentDirectory, { recursive: true });
	await writeFile(logPath, "");
	await writeFile(markerPath, "");
	await writeFile(controlPath, "");
	if (options.persistent !== false) await writeFile(parentSession, "parent\n");
	await chmod(fakePi, 0o755);

	for (const key of Object.keys(process.env)) {
		if (key.startsWith("PI_SUBAGENT_")) delete process.env[key];
	}
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	process.env.PI_SUBAGENT_PI_BIN = fakePi;
	process.env.E2E_FAKE_MODE = options.mode;
	process.env.E2E_LOG_PATH = logPath;
	process.env.E2E_MARKER_PATH = markerPath;
	process.env.E2E_CONTROL_PATH = controlPath;
	process.env.E2E_FLOOD_COUNT = String(options.floodCount ?? 600);
	process.env.E2E_RELOAD_QUEUE_COUNT = String(options.reloadQueueCount ?? options.floodCount ?? 600);
	process.env.E2E_ABORT_RESPONSE_DELAY = String(options.abortResponseDelay ?? 40);

	const runtime = {
		root,
		agentDirectory,
		parentSession: options.persistent === false ? undefined : parentSession,
		logPath,
		markerPath,
		controlPath,
		ctx: undefined as unknown as ExtensionContext,
		handlers: new Map<string, TestHandler>(),
		tools: new Map<string, TestTool>(),
		sent: [],
		uiState: { throwNextWidget: false },
	} as DriverRuntime;
	installExtension(runtime, options.contextMode ?? "json", options.persistent !== false);
	if (!options.deferSessionStart)
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
	return runtime;
}

function tool(runtime: DriverRuntime, name: string): TestTool {
	const value = runtime.tools.get(name);
	if (!value) throw new Error(`Missing tool ${name}.`);
	return value;
}

function call(
	runtime: DriverRuntime,
	name: string,
	params: unknown,
	signal?: AbortSignal,
): Promise<TestResult> {
	return tool(runtime, name).execute("e2e", params, signal, undefined, runtime.ctx);
}

function handleId(result: TestResult): string {
	const id = result.details?.handle?.id;
	if (typeof id !== "string" || !id) throw new Error("Tool did not return a child handle.");
	return id;
}

async function startChild(runtime: DriverRuntime): Promise<{ id: string; result: TestResult }> {
	const result = await call(runtime, "subagent_start", {
		task: "e2e task",
		model: "provider/model",
		thinking: "off",
	});
	return { id: handleId(result), result };
}

async function status(runtime: DriverRuntime, id: string, signal?: AbortSignal): Promise<TestResult> {
	return call(runtime, "subagent_status", { id }, signal);
}

async function killChild(runtime: DriverRuntime, id: string): Promise<void> {
	await withTimeout(call(runtime, "subagent_kill", { id }), 2_000, "child kill").catch(() => {});
}

async function pidAlive(pid: number): Promise<boolean> {
	try {
		process.kill(pid, 0);
		try {
			const stat = await readFile(`/proc/${pid}/stat`, "utf8");
			const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
			if (state === "Z") return false;
		} catch {
			// Non-Linux hosts can use the signal probe alone.
		}
		return true;
	} catch {
		return false;
	}
}

async function waitForLoggedProcessesToClose(
	runtime: DriverRuntime,
	milliseconds = 2_000,
): Promise<void> {
	const pids = await loggedPids(runtime);
	await Promise.all(
		pids.map((pid) =>
			waitFor(
				async () => !(await pidAlive(pid)),
				milliseconds,
				`fake child ${pid} close`,
			),
		),
	);
}

type AbortObservation = { value?: unknown; error?: unknown };

function hasExplicitAbortEvidence(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { details?: Record<string, any>; content?: { text?: string }[] };
	return (
		candidate.details?.interrupted === true ||
		candidate.details?.runOutcome === "aborted" ||
		candidate.details?.handle?.runOutcome === "aborted" ||
		candidate.content?.some((item) => /abort/i.test(String(item?.text || ""))) === true
	);
}

async function assertAbortSettles(
	name: string,
	operation: (signal: AbortSignal) => Promise<unknown>,
): Promise<AbortObservation> {
	const controller = new AbortController();
	let settled = false;
	let observation: AbortObservation = {};
	const promise = Promise.resolve().then(() => operation(controller.signal)).then(
		(value) => {
			settled = true;
			observation = { value };
		},
		(error) => {
			settled = true;
			observation = { error };
		},
	);
	try {
		await delay(50);
		const settledBeforeCancellation = settled;
		if (!settled) controller.abort();
		if (!settled)
			await withTimeout(promise, 800, `${name} after cancellation`);
		assert.equal(settled, true, `${name} did not settle after cancellation.`);
		const error = observation.error;
		const explicitAbort = hasExplicitAbortEvidence(observation.value);
		const causalAbort = error instanceof Error && error.name === "AbortError";
		assert.ok(
			causalAbort || explicitAbort,
			`${name} settled without AbortError or explicit abort evidence: ${String(error)}`,
		);
		if (settledBeforeCancellation)
			assert.ok(explicitAbort, `${name} settled before cancellation without abort evidence.`);
		return observation;
	} finally {
		controller.abort();
	}
}

async function logRecords(runtime: DriverRuntime): Promise<Record<string, any>[]> {
	const text = await readFile(runtime.logPath, "utf8");
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, any>);
}

async function loggedPids(runtime: DriverRuntime): Promise<number[]> {
	return (await logRecords(runtime))
		.filter((record) => record.event === "start" && Number.isInteger(record.pid))
		.map((record) => Number(record.pid));
}

async function registryEntry(runtime: DriverRuntime, childId: string): Promise<Record<string, any> | undefined> {
	if (!runtime.parentSession) return undefined;
	const path = ownerRegistryPath(runtime.agentDirectory, {
		ownerSessionFile: runtime.parentSession,
		ownerSessionId: "e2e-parent",
	});
	try {
		const entries = JSON.parse(await readFile(path, "utf8")) as unknown;
		return Array.isArray(entries)
			? (entries.find((entry) => entry && entry.childId === childId) as Record<string, any> | undefined)
			: undefined;
	} catch {
		return undefined;
	}
}

async function killLoggedProcesses(runtime: DriverRuntime): Promise<number[]> {
	const pids = await loggedPids(runtime);
	for (const pid of pids) {
		if (pid === process.pid) continue;
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// The normal shutdown path already closed this child.
		}
	}
	return pids;
}

async function cleanup(runtime: DriverRuntime | undefined): Promise<void> {
	if (!runtime) return;
	runtime.uiState.throwNextWidget = false;
	const handler = runtime.handlers.get("session_shutdown");
	if (handler) {
		await withTimeout(
			Promise.resolve(handler({ reason: "quit" }, runtime.ctx)),
			500,
			"session shutdown",
		).catch(() => {});
	}
	const pids = await killLoggedProcesses(runtime);
	await Promise.allSettled(
		pids.map((pid) =>
			waitFor(
				async () => !(await pidAlive(pid)),
				2_000,
				`fake child ${pid} close`,
			),
		),
	);
	await rm(runtime.root, { recursive: true, force: true }).catch(() => {});
}

async function scenarioCancellation(toolName: string): Promise<Record<string, unknown>> {
	let runtime: DriverRuntime | undefined;
	let childId: string | undefined;
	try {
		if (toolName === "subagent_start") {
			runtime = await createRuntime({ mode: "hang-get-state" });
			await assertAbortSettles(toolName, (signal) =>
				call(runtime!, toolName, {
					task: "blocked start",
					model: "provider/model",
					thinking: "off",
				}, signal),
			);
		} else if (toolName === "subagent_list" || toolName === "subagent_status") {
			runtime = await createRuntime({ mode: "success" });
			const child = await startChild(runtime);
			childId = child.id;
			const sessionPath = child.result.details.handle.sessionPath as string;
			await rm(sessionPath, { force: true });
			const fifo = spawnSync("mkfifo", [sessionPath], {
				stdio: "ignore",
				timeout: 1_000,
			});
			if (fifo.error || fifo.status !== 0)
				throw new Error(`Could not create stalled transcript FIFO: ${String(fifo.error || fifo.status)}`);
			await assertAbortSettles(toolName, (signal) =>
				call(
					runtime!,
					toolName,
					toolName === "subagent_list" ? {} : { id: child.id },
					signal,
				),
			);
		} else if (toolName === "subagent_steer" || toolName === "subagent_follow_up") {
			runtime = await createRuntime({ mode: "hang-message" });
			const child = await startChild(runtime);
			childId = child.id;
			await assertAbortSettles(toolName, (signal) =>
				call(runtime!, toolName, { id: child.id, message: "blocked message" }, signal),
			);
		} else if (toolName === "subagent_interrupt") {
			runtime = await createRuntime({ mode: "hang-abort" });
			const child = await startChild(runtime);
			childId = child.id;
			await assertAbortSettles(toolName, (signal) =>
				call(runtime!, toolName, { id: child.id }, signal),
			);
		} else if (toolName === "subagent_kill") {
			runtime = await createRuntime({ mode: "queue-kill" });
			const child = await startChild(runtime);
			childId = child.id;
			await assertAbortSettles(toolName, (signal) =>
				call(runtime!, toolName, { id: child.id }, signal),
			);
		} else if (toolName === "subagent_resume") {
			runtime = await createRuntime({ mode: "hang-resume-state" });
			const child = await startChild(runtime);
			childId = child.id;
			await killChild(runtime, child.id);
			await assertAbortSettles(toolName, (signal) =>
				call(runtime!, toolName, { id: child.id, task: "blocked resume" }, signal),
			);
		} else {
			throw new Error(`Unknown cancellation tool ${toolName}.`);
		}
		if (childId) {
			await killChild(runtime, childId);
			await waitForLoggedProcessesToClose(runtime);
		} else {
			await waitForLoggedProcessesToClose(runtime);
		}
		return { tool: toolName, settled: true, abortEvidence: true };
	} finally {
		await cleanup(runtime);
	}
}

async function scenarioAbortOrder(slow: boolean): Promise<Record<string, unknown>> {
	let runtime: DriverRuntime | undefined;
	try {
		runtime = await createRuntime({
			mode: slow ? "slow-production-abort" : "production-abort",
			abortResponseDelay: slow ? 1_250 : 40,
		});
		const child = await startChild(runtime);
		const interrupted = await call(runtime, "subagent_interrupt", { id: child.id });
		assert.equal(interrupted.details.interrupted, true);
		const current = await status(runtime, child.id);
		assert.equal(current.details.runOutcome, "aborted");
		assert.equal(current.details.settlement.status, "settled");
		return {
			responseAfterSettlement: true,
			slow,
			interrupted: interrupted.details.interrupted,
		};
	} finally {
		await cleanup(runtime);
	}
}

async function scenarioStreamFlood(): Promise<Record<string, unknown>> {
	let runtime: DriverRuntime | undefined;
	let watcher: ReturnType<typeof watch> | undefined;
	let registryEvents = 0;
	try {
		runtime = await createRuntime({ mode: "stream-flood", floodCount: 600 });
		const owner = {
			ownerSessionFile: runtime.parentSession!,
			ownerSessionId: "e2e-parent",
		};
		const registryDirectory = dirname(ownerRegistryPath(runtime.agentDirectory, owner));
		watcher = watch(registryDirectory, { persistent: false }, (event, filename) => {
			if (event === "rename" && filename?.toString() === "registry.json") registryEvents++;
		});
		const child = await startChild(runtime);
		await waitForMarker(runtime, "flood-done", 5_000);
		await waitFor(
			async () => (await status(runtime!, child.id)).details.settlement.status === "settled",
			5_000,
			"stream flood settlement",
		);
		await waitFor(
			async () => {
				const entry = await registryEntry(runtime!, child.id);
				return entry?.runOutcome === "succeeded" && entry.settlementStatus === "settled";
			},
			5_000,
			"latest stream state persistence",
		);
		await delay(250);
		watcher.close();
		watcher = undefined;
		assert.ok(registryEvents > 0, "stream flood produced no registry save event");
		assert.ok(
			registryEvents < 100,
			`stream updates caused ${registryEvents} registry saves`,
		);
		const saved = await registryEntry(runtime, child.id);
		assert.equal(saved?.runOutcome, "succeeded");
		assert.equal(saved?.settlementStatus, "settled");
		return { floodCount: 600, registryEvents, registrySaves: registryEvents, latestState: saved };
	} finally {
		watcher?.close();
		await cleanup(runtime);
	}
}

async function scenarioPersistenceFlood(): Promise<Record<string, unknown>> {
	let runtime: DriverRuntime | undefined;
	let watcher: ReturnType<typeof watch> | undefined;
	let registrySaves = 0;
	try {
		runtime = await createRuntime({ mode: "persist-flood", floodCount: 16_000 });
		const owner = {
			ownerSessionFile: runtime.parentSession!,
			ownerSessionId: "e2e-parent",
		};
		watcher = watch(dirname(ownerRegistryPath(runtime.agentDirectory, owner)), { persistent: false }, (event, filename) => {
			if (event === "rename" && filename?.toString() === "registry.json") registrySaves++;
		});
		const child = await startChild(runtime);
		await waitForMarker(runtime, "flood-done", 5_000);
		await waitFor(
			async () => (await status(runtime!, child.id)).details.settlement.status === "settled",
			5_000,
			"persistence flood settlement",
		);
		const startedAt = Date.now();
		await withTimeout(
			Promise.resolve(runtime.handlers.get("session_shutdown")?.({ reason: "quit" }, runtime.ctx)),
			1_000,
			"persistence flood shutdown",
		);
		watcher?.close();
		watcher = undefined;
		const saved = await registryEntry(runtime, child.id);
		assert.ok(registrySaves > 0, "persistence flood produced no registry saves");
		assert.equal(saved?.runOutcome, "succeeded", "the latest state was not persisted");
		assert.equal(saved?.settlementStatus, "settled", "the latest settlement was not persisted");
		return { shutdownMs: Date.now() - startedAt, registrySaves, latestState: saved };
	} finally {
		watcher?.close();
		await cleanup(runtime);
	}
}

async function scenarioActiveLimit(): Promise<Record<string, unknown>> {
	let runtime: DriverRuntime | undefined;
	try {
		runtime = await createRuntime({ mode: "success" });
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, index) =>
				call(runtime!, "subagent_start", {
					task: `child ${index}`,
					model: "provider/model",
					thinking: "off",
				}),
			),
		);
		const accepted = results.filter(
			(result) => typeof result.details?.handle?.id === "string",
		);
		const rejected = results.filter(
			(result) => typeof result.details?.handle?.id !== "string",
		);
		const starts = (await logRecords(runtime)).filter((record) => record.event === "start");
		assert.ok(accepted.length <= 8, `accepted ${accepted.length} active children`);
		assert.ok(starts.length <= 8, `started ${starts.length} fake child processes`);
		assert.equal(starts.length, accepted.length, "rejected starts created hidden fake processes");
		assert.ok(rejected.length > 0, "the active-child limit never rejected a start");
		assert.ok(
			rejected.some((result) => /active subagent limit/i.test(result.content[0]?.text || "")),
			"the active-child rejection did not report its limit",
		);
		return { attempted: results.length, accepted: accepted.length, rejected: rejected.length, processStarts: starts.length };
	} finally {
		await cleanup(runtime);
	}
}

async function stopDirectChild(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const closed = new Promise<void>((resolve) => {
		child.once("close", () => resolve());
	});
	try {
		child.kill("SIGKILL");
	} catch {
		// The child already exited.
	}
	await withTimeout(closed, 500, "direct child cleanup").catch(() => {});
}

async function directTransport(
	mode: string,
	configure: (
		child: ChildProcess,
		transport: RpcChildTransport,
		diagnostics: string[],
	) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
	const root = await mkdtemp(join(tmpdir(), "pi-subagent-e2e-transport-"));
	const markerPath = join(root, "markers.log");
	const child = spawn(process.execPath, [fakePi], {
		cwd: root,
		env: {
			...process.env,
			E2E_FAKE_MODE: mode,
			E2E_MARKER_PATH: markerPath,
			E2E_LOG_PATH: join(root, "fake-pi.log"),
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	const diagnostics: string[] = [];
	const transport = new RpcChildTransport(child, {
		onRecord: () => {},
		onDiagnostic: (message) => diagnostics.push(message),
		onClose: () => {},
		requestTimeoutMs: 150,
	});
	try {
		await waitFor(() => fileContains(markerPath, mode === "huge-record" ? "huge-record-sent" : "stdin-paused"), 2_000, `${mode} marker`);
		return {
			...(await configure(child, transport, diagnostics)),
			diagnostics,
		};
	} finally {
		await withTimeout(
			transport.terminate({
				abort: false,
				termTimeoutMs: 300,
				killTimeoutMs: 300,
			}),
			1_000,
			"transport cleanup",
		).catch(() => {});
		await stopDirectChild(child);
		await rm(root, { recursive: true, force: true }).catch(() => {});
	}
}

async function scenarioRpcBuffer(): Promise<Record<string, unknown>> {
	return directTransport("huge-record", async (_child, _transport, diagnostics) => {
		await waitFor(
			() => diagnostics.some((message) => message.includes("Discarded oversized unterminated RPC JSONL record.")),
			800,
			"oversized RPC discard diagnostic",
		);
		return { discarded: true };
	});
}

function transportPendingCount(transport: RpcChildTransport): number {
	const exposed = (transport as any).pendingCount;
	if (typeof exposed === "number") return exposed;
	return (transport as any).pending?.size ?? 0;
}

function transportQueuedBytes(child: ChildProcess, transport: RpcChildTransport): number {
	const exposed = (transport as any).queuedBytes;
	if (typeof exposed === "number") return exposed;
	return child.stdin?.writableLength ?? 0;
}

async function scenarioBackpressure(): Promise<Record<string, unknown>> {
	const root = await mkdtemp(join(tmpdir(), "pi-subagent-e2e-transport-aggregate-"));
	const markerPath = join(root, "markers.log");
	const children: ChildProcess[] = [];
	const transports: RpcChildTransport[] = [];
	try {
		for (let index = 0; index < 2; index++) {
			const child = spawn(process.execPath, [fakePi], {
				cwd: root,
				env: {
					...process.env,
					E2E_FAKE_MODE: "pause-stdin",
					E2E_MARKER_PATH: markerPath,
					E2E_LOG_PATH: join(root, `fake-pi-${index}.log`),
				},
				stdio: ["pipe", "pipe", "pipe"],
			});
			children.push(child);
			transports.push(new RpcChildTransport(child, {
				onRecord: () => {},
				onDiagnostic: () => {},
				onClose: () => {},
				requestTimeoutMs: 150,
			}));
		}
		await waitFor(() => fileContains(markerPath, "stdin-paused"), 2_000, "aggregate stdin marker");
		const payload = "x".repeat(512 * 1024);
		const sends = transports.flatMap((transport, childIndex) =>
			Array.from({ length: 8 }, (_, index) =>
				transport.send({ type: "backpressure", childIndex, index, payload }, 150).catch(() => undefined),
			),
		);
		await delay(50);
		const pendingBefore = transports.reduce((total, transport) => total + transportPendingCount(transport), 0);
		const queuedBytesBefore = transports.reduce(
			(total, transport, index) => total + transportQueuedBytes(children[index]!, transport),
			0,
		);
		assert.ok(pendingBefore > 0, "the aggregate RPC pending count stayed empty");
		assert.ok(queuedBytesBefore <= 16 * 1024 * 1024, `RPC queued ${queuedBytesBefore} bytes across children`);
		await Promise.all(sends);
		const pendingAfter = transports.reduce((total, transport) => total + transportPendingCount(transport), 0);
		assert.equal(pendingAfter, 0, "RPC pending requests survived timeout cleanup");
		return { pendingBefore, pendingAfter, queuedBytesBefore };
	} finally {
		await Promise.all(transports.map((transport) =>
			withTimeout(transport.terminate({ abort: false, termTimeoutMs: 300, killTimeoutMs: 300 }), 1_000, "aggregate transport cleanup").catch(() => {}),
		));
		await Promise.all(children.map((child) => stopDirectChild(child)));
		await rm(root, { recursive: true, force: true }).catch(() => {});
	}
}

async function scenarioReloadQueue(queueCount: number, overflow: boolean): Promise<Record<string, unknown>> {
	let runtime: DriverRuntime | undefined;
	try {
		runtime = await createRuntime({
			mode: overflow ? "reload-queue-overflow" : "reload-queue-under-limit",
			contextMode: "tui",
			reloadQueueCount: queueCount,
		});
		const child = await startChild(runtime);
		await waitForMarker(runtime, "reload-ready");
		await withTimeout(
			Promise.resolve(runtime.handlers.get("session_shutdown")?.({ reason: "reload" }, runtime.ctx)),
			2_000,
			"reload detach",
		);
		runtime.uiState.throwNextWidget = true;
		await writeFile(runtime.controlPath, "emit\n");
		await waitForMarker(runtime, "flood-done", 5_000);
		installExtension(runtime, "tui", true);
		await runtime.handlers.get("session_start")?.({ reason: "reload" }, runtime.ctx);
		let current: TestResult | undefined;
		await waitFor(
			async () => {
				current = await status(runtime!, child.id);
				return (
					current.details.runOutcome === "succeeded" &&
					current.details.settlement.status === "settled"
				);
			},
			5_000,
			"reload queue settlement",
		);
		assert.ok(current);
		assert.equal(current.details.runOutcome, "succeeded");
		assert.equal(current.details.settlement.status, "settled");
		if (!overflow)
			assert.match(String(current.details.latestAssistantText), /reload-1-/);
		const diagnostics = (current.details.diagnostics || []) as string[];
		const overflowDiagnostic = "Reload event queue reached 512 records. Older records were discarded.";
		if (overflow)
			assert.ok(diagnostics.includes(overflowDiagnostic), "reload overflow had no discard diagnostic");
		else
			assert.ok(!diagnostics.includes(overflowDiagnostic), "under-limit reload discarded records");
		return { reloaded: true, queueDelivered: true, queueCount, overflow, diagnostics };
	} finally {
		await cleanup(runtime);
	}
}

async function scenarioStartupHealth(): Promise<Record<string, unknown>> {
	let runtime: DriverRuntime | undefined;
	try {
		runtime = await createRuntime({ mode: "success" });
		const healthy = await startChild(runtime);
		const handle = healthy.result.details.handle as Record<string, any>;
		const markerPath = join(
			String(handle.sessionDir),
			`child-extension-health-${String(handle.incarnation)}.marker`,
		);
		assert.equal(
			await readFile(markerPath, "utf8"),
			"pi-subagent-child-extension-ready/v1\n",
			"the child health marker was not exact",
		);
		await killChild(runtime, healthy.id);
		await cleanup(runtime);
		runtime = undefined;

		runtime = await createRuntime({ mode: "extension-error" });
		const result = await call(runtime, "subagent_start", {
			task: "extension health",
			model: "provider/model",
			thinking: "off",
		});
		assert.equal(result.details?.handle, undefined, "start accepted an unhealthy child extension");
		assert.match(result.content[0]?.text || "", /fake child extension failed to load/);
		assert.equal(
			(await logRecords(runtime)).filter((record) => record.event === "start").length,
			1,
			"extension health failure created hidden child processes",
		);
		return { markerExact: true, rejected: true };
	} finally {
		await cleanup(runtime);
	}
}

async function scenarioCloseCallback(): Promise<Record<string, unknown>> {
	let runtime: DriverRuntime | undefined;
	try {
		runtime = await createRuntime({ mode: "close", contextMode: "tui" });
		const child = await startChild(runtime);
		runtime.uiState.throwNextWidget = true;
		await waitForMarker(runtime, "close-scheduled");
		const beforeReload = await waitFor(
			async () => (await status(runtime!, child.id)).details.processState === "stopped",
			2_000,
			"fake child close",
		).then(() => status(runtime!, child.id));
		assert.equal(uncaughtException, undefined, `close callback escaped: ${uncaughtException}`);
		assert.equal(beforeReload.details.processState, "stopped");
		assert.equal(beforeReload.details.settlement.status, "closed_without_settlement");
		assert.equal(beforeReload.details.lifecycle, "error");
		assert.equal(beforeReload.details.state, "error");
		assert.equal(beforeReload.details.osCloseObserved, true);
		assert.equal(beforeReload.details.forced, false);

		await runtime.handlers.get("session_shutdown")?.({ reason: "reload" }, runtime.ctx);
		installExtension(runtime, "tui", true);
		await runtime.handlers.get("session_start")?.({ reason: "reload" }, runtime.ctx);
		const afterReload = await status(runtime, child.id);
		assert.equal(afterReload.details.processState, "stopped");
		assert.equal(afterReload.details.settlement.status, "closed_without_settlement");
		assert.equal(afterReload.details.lifecycle, "error");
		assert.equal(afterReload.details.state, "error");
		assert.equal(afterReload.details.osCloseObserved, true);
		assert.equal(afterReload.details.forced, false);
		return { closeHandled: true, lifecycle: afterReload.details.lifecycle, forced: afterReload.details.forced };
	} finally {
		await cleanup(runtime);
	}
}

async function scenarioLifecycle(): Promise<Record<string, unknown>> {
	let runtime: DriverRuntime | undefined;
	try {
		runtime = await createRuntime({ mode: "production-abort" });
		const child = await startChild(runtime);
		await call(runtime, "subagent_interrupt", { id: child.id });
		const current = await status(runtime, child.id);
		assert.equal(current.details.runState, "idle");
		assert.equal(current.details.processState, "alive");
		assert.equal(current.details.runOutcome, "aborted");
		assert.notEqual(current.details.state, "running", "aborted idle child kept a running compatibility state");
		assert.equal(current.details.lifecycle, "idle");
		return { state: current.details.state, lifecycle: current.details.lifecycle };
	} finally {
		await cleanup(runtime);
	}
}

async function scenarioStaleRunView(): Promise<Record<string, unknown>> {
	let runtime: DriverRuntime | undefined;
	try {
		runtime = await createRuntime({ mode: "two-runs" });
		const child = await startChild(runtime);
		await call(runtime, "subagent_follow_up", { id: child.id, message: "second run" });
		await waitForMarker(runtime, "second-run-active");
		let current: TestResult | undefined;
		await waitFor(
			async () => {
				current = await status(runtime!, child.id);
				return current.details.runState === "running" && current.details.completedAt === undefined;
			},
			2_000,
			"second run status",
		);
		assert.ok(current);
		assert.equal(current.details.runState, "running");
		assert.equal(current.details.completedAt, undefined, "a new run kept the prior completedAt");
		return { currentRun: 2, completedAt: current.details.completedAt };
	} finally {
		await cleanup(runtime);
	}
}

async function scenarioLargeTranscript(): Promise<Record<string, unknown>> {
	let runtime: DriverRuntime | undefined;
	try {
		runtime = await createRuntime({ mode: "large-transcript" });
		const child = await startChild(runtime);
		const current = await status(runtime, child.id);
		assert.equal(current.details.transcript.status, "available");
		assert.ok((current.details.transcript.messages[0]?.text || "").length <= 8 * 1024);
		return { transcript: current.details.transcript.status };
	} finally {
		await cleanup(runtime);
	}
}

async function scenarioLaunchPersistence(): Promise<Record<string, unknown>> {
	let runtime: DriverRuntime | undefined;
	let registryPath: string | undefined;
	try {
		runtime = await createRuntime({ mode: "success", deferSessionStart: true });
		registryPath = ownerRegistryPath(runtime.agentDirectory, {
			ownerSessionFile: runtime.parentSession!,
			ownerSessionId: "e2e-parent",
		});
		await mkdir(registryPath, { recursive: true });
		await runtime.handlers.get("session_start")?.({ reason: "startup" }, runtime.ctx);
		const result = await call(runtime, "subagent_start", {
			task: "must not start",
			model: "provider/model",
			thinking: "off",
		});
		const starts = (await logRecords(runtime)).filter((record) => record.event === "start");
		assert.equal(starts.length, 0, "launch started a child after its registry save failed");
		assert.equal(result.details.handle, undefined);
		const registryIsFile = await stat(registryPath).then((value) => value.isFile()).catch(() => false);
		assert.equal(registryIsFile, false, "failed launch left a durable registry file");
		return { childStarted: false, durableCleanup: true };
	} finally {
		if (registryPath) await rm(registryPath, { recursive: true, force: true }).catch(() => {});
		await cleanup(runtime);
	}
}

async function scenarioEphemeral(): Promise<Record<string, unknown>> {
	let runtime: DriverRuntime | undefined;
	try {
		runtime = await createRuntime({ mode: "success", persistent: false });
		const result = await call(runtime, "subagent_start", {
			task: "ephemeral parent",
			model: "provider/model",
			thinking: "off",
		});
		assert.equal(typeof result.details?.handle?.id, "string");
		return { accepted: true };
	} finally {
		await cleanup(runtime);
	}
}

async function scenarioNotification(): Promise<Record<string, unknown>> {
	let runtime: DriverRuntime | undefined;
	try {
		runtime = await createRuntime({ mode: "success" });
		await startChild(runtime);
		await waitFor(() => runtime!.sent.length > 0, 2_000, "settlement notification");
		const content = String(runtime.sent[0]?.message?.content || "");
		assert.match(content, /numMessages=3/);
		assert.doesNotMatch(content, /messages=3/);
		return { content };
	} finally {
		await cleanup(runtime);
	}
}

async function scenarioHangingPredecessor(): Promise<Record<string, unknown>> {
	let runtime: DriverRuntime | undefined;
	try {
		runtime = await createRuntime({ mode: "queue-message" });
		const child = await startChild(runtime);
		const firstController = new AbortController();
		let firstSettled = false;
		let firstError: unknown;
		const first = call(
			runtime,
			"subagent_steer",
			{ id: child.id, message: "hanging predecessor" },
			firstController.signal,
		).then(
			() => {
				firstSettled = true;
			},
			(error) => {
				firstSettled = true;
				firstError = error;
			},
		);
		await waitForMarker(runtime, "predecessor-message");
		assert.equal(firstSettled, false, "the predecessor operation settled unexpectedly");

		const secondController = new AbortController();
		let secondSettled = false;
		let secondError: unknown;
		const second = call(
			runtime,
			"subagent_follow_up",
			{ id: child.id, message: "queued successor" },
			secondController.signal,
		).then(
			() => {
				secondSettled = true;
			},
			(error) => {
				secondSettled = true;
				secondError = error;
			},
		);
		await delay(50);
		assert.equal(secondSettled, false, "the queued successor skipped its predecessor");
		secondController.abort();
		await withTimeout(second, 800, "queued successor cancellation");
		assert.equal((secondError as Error)?.name, "AbortError");

		firstController.abort();
		await withTimeout(first, 800, "predecessor cancellation");
		assert.equal((firstError as Error)?.name, "AbortError");
		const released = await call(runtime, "subagent_follow_up", {
			id: child.id,
			message: "released successor",
		});
		assert.equal(released.details.accepted, true);
		const starts = (await logRecords(runtime)).filter((record) => record.event === "start");
		assert.equal(starts.length, 1, "queue cancellation created a hidden child process");
		return { predecessorCanceled: true, successorCanceled: true, queueReleased: true, processStarts: starts.length };
	} finally {
		await cleanup(runtime);
	}
}

async function scenarioConcurrentResume(): Promise<Record<string, unknown>> {
	let runtime: DriverRuntime | undefined;
	try {
		runtime = await createRuntime({ mode: "resume-race" });
		const child = await startChild(runtime);
		await killChild(runtime, child.id);
		const results = await Promise.all([
			call(runtime, "subagent_resume", { id: child.id, task: "resume A" }),
			call(runtime, "subagent_resume", { id: child.id, task: "resume B" }),
		]);
		const starts = (await logRecords(runtime)).filter((record) => record.event === "start");
		assert.equal(starts.length, 2, `concurrent resume started ${starts.length - 1} replacement processes`);
		assert.equal(
			results.filter((result) => String(result.content[0]?.text || "").startsWith("Resumed subagent")).length,
			1,
		);
		return { processStarts: starts.length };
	} finally {
		await cleanup(runtime);
	}
}

async function scenarioConcurrentMessages(): Promise<Record<string, unknown>> {
	let runtime: DriverRuntime | undefined;
	try {
		runtime = await createRuntime({ mode: "message-race" });
		const child = await startChild(runtime);
		await Promise.all([
			call(runtime, "subagent_steer", { id: child.id, message: "steer" }),
			call(runtime, "subagent_follow_up", { id: child.id, message: "follow" }),
		]);
		const overlap = (await logRecords(runtime)).filter((record) => record.event === "message-overlap");
		assert.equal(overlap.length, 0, `same-child message operations overlapped ${overlap.length} times`);
		return { overlap: overlap.length };
	} finally {
		await cleanup(runtime);
	}
}

async function run(): Promise<Record<string, unknown>> {
	if (scenario.startsWith("cancel-")) {
		const cancellationTool: Record<string, string> = {
			start: "subagent_start",
			list: "subagent_list",
			status: "subagent_status",
			steer: "subagent_steer",
			"follow-up": "subagent_follow_up",
			interrupt: "subagent_interrupt",
			kill: "subagent_kill",
			resume: "subagent_resume",
		};
		const suffix = scenario.slice("cancel-".length);
		const toolName = cancellationTool[suffix];
		if (!toolName) throw new Error(`Unknown cancellation scenario ${suffix}.`);
		return scenarioCancellation(toolName);
	}
	switch (scenario) {
		case "abort-order":
			return scenarioAbortOrder(false);
		case "abort-order-slow":
			return scenarioAbortOrder(true);
		case "stream-flood":
			return scenarioStreamFlood();
		case "persistence-flood":
			return scenarioPersistenceFlood();
		case "active-child-limit":
			return scenarioActiveLimit();
		case "rpc-buffer-limit":
			return scenarioRpcBuffer();
		case "backpressure":
			return scenarioBackpressure();
		case "reload-queue":
		case "reload-queue-under-limit":
			return scenarioReloadQueue(400, false);
		case "reload-queue-overflow":
			return scenarioReloadQueue(600, true);
		case "startup-extension-health":
			return scenarioStartupHealth();
		case "close-callback":
			return scenarioCloseCallback();
		case "lifecycle-consistency":
			return scenarioLifecycle();
		case "stale-run-view":
			return scenarioStaleRunView();
		case "transcript-large-record":
			return scenarioLargeTranscript();
		case "launch-persistence":
			return scenarioLaunchPersistence();
		case "ephemeral-parent":
			return scenarioEphemeral();
		case "notification-parameter":
			return scenarioNotification();
		case "concurrent-resume":
			return scenarioConcurrentResume();
		case "hanging-predecessor":
			return scenarioHangingPredecessor();
		case "concurrent-messages":
			return scenarioConcurrentMessages();
		default:
			throw new Error(`Unknown E2E scenario ${scenario}.`);
	}
}

let runtimeResult: Record<string, unknown> | undefined;
let failure: string | undefined;
try {
	runtimeResult = await run();
} catch (error) {
	failure = error instanceof Error ? error.stack || error.message : String(error);
}
const result = {
	ok: !failure && !uncaughtException && !unhandledRejection,
	scenario,
	...(runtimeResult || {}),
	...(failure ? { failure } : {}),
	...(uncaughtException ? { uncaughtException } : {}),
	...(unhandledRejection ? { unhandledRejection } : {}),
};
await new Promise<void>((resolve) => process.stdout.write(`${JSON.stringify(result)}\n`, resolve));
process.exit(result.ok ? 0 : 1);
