import assert from "node:assert/strict";
import { watch } from "node:fs";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
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
	await withTimeout(call(runtime, "subagent_kill", { id }), 6_000, "child kill").catch(() => {});
}

async function assertAbortSettles(
	name: string,
	operation: (signal: AbortSignal) => Promise<unknown>,
): Promise<void> {
	const controller = new AbortController();
	let timer: NodeJS.Timeout | undefined;
	let settled = false;
	const promise = operation(controller.signal).then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	try {
		await Promise.race([
			promise,
			new Promise<void>((resolve) => {
				timer = setTimeout(() => {
					controller.abort();
					resolve();
				}, 40);
			}),
		]);
		if (!settled)
			await withTimeout(promise, 500, `${name} after cancellation`);
		assert.equal(settled, true, `${name} did not settle after cancellation.`);
	} finally {
		if (timer) clearTimeout(timer);
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

async function killLoggedProcesses(runtime: DriverRuntime): Promise<void> {
	for (const pid of await loggedPids(runtime)) {
		if (pid === process.pid) continue;
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// The normal shutdown path already closed this child.
		}
	}
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
	await killLoggedProcesses(runtime);
	await rm(runtime.root, { recursive: true, force: true }).catch(() => {});
}

async function scenarioCancellation(toolName: string): Promise<Record<string, unknown>> {
	let runtime: DriverRuntime | undefined;
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
			const sessionPath = child.result.details.handle.sessionPath as string;
			await rm(sessionPath, { force: true });
			await symlink("/dev/zero", sessionPath);
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
			await assertAbortSettles(toolName, (signal) =>
				call(runtime!, toolName, { id: child.id, message: "blocked message" }, signal),
			);
		} else if (toolName === "subagent_interrupt") {
			runtime = await createRuntime({ mode: "hang-abort" });
			const child = await startChild(runtime);
			await assertAbortSettles(toolName, (signal) =>
				call(runtime!, toolName, { id: child.id }, signal),
			);
		} else if (toolName === "subagent_kill") {
			runtime = await createRuntime({ mode: "persist-flood", floodCount: 16_000 });
			const child = await startChild(runtime);
			await waitForMarker(runtime, "flood-done", 5_000);
			await delay(40);
			await assertAbortSettles(toolName, (signal) =>
				call(runtime!, toolName, { id: child.id }, signal),
			);
		} else if (toolName === "subagent_resume") {
			runtime = await createRuntime({ mode: "hang-resume-state" });
			const child = await startChild(runtime);
			await killChild(runtime, child.id);
			await assertAbortSettles(toolName, (signal) =>
				call(runtime!, toolName, { id: child.id, task: "blocked resume" }, signal),
			);
		} else {
			throw new Error(`Unknown cancellation tool ${toolName}.`);
		}
		return { tool: toolName, settled: true };
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
		watcher = watch(registryDirectory, { persistent: false }, (_event, filename) => {
			if (filename?.toString() === "registry.json") registryEvents++;
		});
		const child = await startChild(runtime);
		await waitForMarker(runtime, "flood-done", 5_000);
		await waitFor(
			async () => (await status(runtime!, child.id)).details.settlement.status === "settled",
			5_000,
			"stream flood settlement",
		);
		await delay(250);
		watcher.close();
		watcher = undefined;
		assert.ok(registryEvents > 0, "stream flood produced no registry snapshot event");
		assert.ok(
			registryEvents < 100,
			`stream updates caused ${registryEvents} registry snapshots`,
		);
		return { floodCount: 600, registryEvents, registry: ownerRegistryPath(runtime.agentDirectory, owner) };
	} finally {
		watcher?.close();
		await cleanup(runtime);
	}
}

async function scenarioPersistenceFlood(): Promise<Record<string, unknown>> {
	let runtime: DriverRuntime | undefined;
	try {
		runtime = await createRuntime({ mode: "persist-flood", floodCount: 16_000 });
		await startChild(runtime);
		await waitForMarker(runtime, "flood-done", 5_000);
		const startedAt = Date.now();
		await withTimeout(
			Promise.resolve(runtime.handlers.get("session_shutdown")?.({ reason: "quit" }, runtime.ctx)),
			1_000,
			"persistence flood shutdown",
		);
		return { shutdownMs: Date.now() - startedAt };
	} finally {
		await cleanup(runtime);
	}
}

async function scenarioActiveLimit(): Promise<Record<string, unknown>> {
	let runtime: DriverRuntime | undefined;
	try {
		runtime = await createRuntime({ mode: "success" });
		const accepted: string[] = [];
		for (let index = 0; index < 28; index++) {
			const result = await call(runtime, "subagent_start", {
				task: `child ${index}`,
				model: "provider/model",
				thinking: "off",
			});
			if (typeof result.details?.handle?.id === "string")
				accepted.push(result.details.handle.id);
		}
		assert.ok(accepted.length <= 24, `accepted ${accepted.length} active children`);
		return { attempted: 28, accepted: accepted.length };
	} finally {
		await cleanup(runtime);
	}
}

async function directTransport(
	mode: string,
	configure: (child: ChildProcess, transport: RpcChildTransport) => Promise<Record<string, unknown>>,
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
			...(await configure(child, transport)),
			diagnostics,
		};
	} finally {
		await transport.terminate({
			abort: false,
			termTimeoutMs: 300,
			killTimeoutMs: 300,
		}).catch(() => {});
		await rm(root, { recursive: true, force: true }).catch(() => {});
	}
}

async function scenarioRpcBuffer(): Promise<Record<string, unknown>> {
	return directTransport("huge-record", async (_child, transport) => {
		const closed = await withTimeout(transport.waitForClose(500), 800, "oversized RPC frame");
		assert.equal(closed, true, "an oversized unterminated RPC record stayed open");
		return { closed };
	});
}

async function scenarioBackpressure(): Promise<Record<string, unknown>> {
	return directTransport("pause-stdin", async (child, transport) => {
		const payload = "x".repeat(1024 * 1024);
		const sends = Array.from({ length: 64 }, (_, index) =>
			transport
				.send({ type: "backpressure", index, payload }, 150)
				.catch(() => undefined),
		);
		await delay(50);
		const writableLength = child.stdin?.writableLength ?? 0;
		assert.ok(
			writableLength <= 8 * 1024 * 1024,
			`RPC stdin buffered ${writableLength} bytes after backpressure`,
		);
		await Promise.all(sends);
		return { writableLength };
	});
}

async function scenarioReloadQueue(): Promise<Record<string, unknown>> {
	let runtime: DriverRuntime | undefined;
	try {
		runtime = await createRuntime({ mode: "reload-queue", contextMode: "tui" });
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
		const current = await status(runtime, child.id);
		assert.equal(current.details.runOutcome, "succeeded");
		assert.equal(current.details.settlement.status, "settled");
		assert.match(String(current.details.latestAssistantText), /reload-1-/);
		return { reloaded: true, queueDelivered: true };
	} finally {
		await cleanup(runtime);
	}
}

async function scenarioStartupHealth(): Promise<Record<string, unknown>> {
	let runtime: DriverRuntime | undefined;
	try {
		runtime = await createRuntime({ mode: "extension-error" });
		const result = await call(runtime, "subagent_start", {
			task: "extension health",
			model: "provider/model",
			thinking: "off",
		});
		assert.equal(result.details?.handle, undefined, "start accepted an unhealthy child extension");
		assert.match(result.content[0]?.text || "", /extension/i);
		return { healthy: false, rejected: true };
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
		await delay(350);
		assert.equal(uncaughtException, undefined, `close callback escaped: ${uncaughtException}`);
		const current = await status(runtime, child.id);
		assert.equal(current.details.processState, "stopped");
		return { closeHandled: true };
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
		const current = await status(runtime, child.id);
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
		return { childStarted: false };
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
			return scenarioReloadQueue();
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
