import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import bashJobsExtension from "../extensions/bash-jobs.ts";

type Tool = {
	name: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	execute(...args: any[]): Promise<{ content: Array<{ type: "text"; text: string }> }>;
};

type Harness = ReturnType<typeof createHarness>;

function createHarness() {
	const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
	const tools = new Map<string, Tool>();
	const sends: Array<{ message: any; options: any }> = [];
	const pi = {
		on(name: string, handler: (...args: any[]) => unknown) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerTool(tool: Tool) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		sendMessage(message: any, options: any) {
			sends.push({ message, options });
		},
	};
	bashJobsExtension(pi as unknown as ExtensionAPI);

	const ctx = { cwd: process.cwd() };
	async function emit(name: string, event: any = {}) {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	}
	async function execute(name: string, params: any) {
		const tool = tools.get(name);
		if (!tool) throw new Error(`Missing tool ${name}`);
		return tool.execute("test-tool-call", params, undefined, undefined, ctx);
	}

	return { emit, execute, sends, tools };
}

function jobIdFrom(text: string): string {
	const match = /managed bash job (job_[0-9a-f]+)/.exec(text);
	if (!match) throw new Error(`No managed job id in: ${text}`);
	return match[1];
}

function logPathFrom(text: string): string {
	const match = /^Log file: (.+)$/m.exec(text);
	if (!match) throw new Error(`No log path in: ${text}`);
	return match[1];
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
		await delay(10);
	}
}

async function waitForTerminalJob(jobId: string, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const result = await jobs().execute("jobs", {});
		if (new RegExp(`● ${jobId} · (?:completed|failed|killed)`).test(result.content[0]?.text ?? "")) return;
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for terminal job ${jobId}`);
		await delay(5);
	}
}

const h = createHarness();
const bash = () => h.tools.get("bash")!;
const status = () => h.tools.get("bash_status")!;
const kill = () => h.tools.get("bash_kill")!;
const jobs = () => h.tools.get("bash_jobs")!;

await h.emit("session_start", { reason: "startup" });
process.env.PI_BASH_TEST_OUTPUT = "terminal-output";
process.env.PI_BASH_TEST_STATUS_OUTPUT = "status-before-notification-output";
process.env.PI_BASH_TEST_BATCH_ONE = "batch-one-output";
process.env.PI_BASH_TEST_BATCH_TWO = "batch-two-output";

test("registers no wait tool or wait prompt metadata", () => {
	assert.equal(h.tools.has("bash_" + "wait"), false);
	const metadata = [...h.tools.values()]
		.map((tool) => `${tool.description} ${tool.promptSnippet ?? ""} ${(tool.promptGuidelines ?? []).join(" ")}`)
		.join("\n");
	assert.equal(metadata.includes("bash_" + "wait"), false);
});

test("fast commands return normally without a notification", async () => {
	h.sends.length = 0;
	const result = await bash().execute("fast", { command: "printf fast", timeout: 1 }, undefined, undefined, { cwd: process.cwd() });
	assert.match(result.content[0]?.text ?? "", /fast/);
	await delay(100);
	assert.equal(h.sends.length, 0);
});

test("timed-out jobs notify once after terminal log readiness", async () => {
	h.sends.length = 0;
	const result = await bash().execute("slow", { command: "sleep 1.05; printf \"$PI_BASH_TEST_OUTPUT\"", timeout: 1 }, undefined, undefined, { cwd: process.cwd() });
	const runningMessage = result.content[0]?.text ?? "";
	const jobId = jobIdFrom(runningMessage);
	const logPath = logPathFrom(runningMessage);
	assert.match(runningMessage, /still running/);

	await waitFor(() => h.sends.length === 1);
	assert.deepEqual(h.sends[0]?.options, { triggerTurn: true, deliverAs: "steer" });
	assert.equal(h.sends[0]?.message.customType, "bash-job-completion");
	assert.match(h.sends[0]?.message.content, new RegExp(jobId));
	assert.match(h.sends[0]?.message.content, /completed/);
	assert.match(h.sends[0]?.message.content, /sleep 1\.05/);
	assert.match(h.sends[0]?.message.content, /Use bash_status with a job ID to retrieve its final output\./);
	assert.equal(h.sends[0]?.message.content.includes("terminal-output"), false);
	assert.match(await readFile(logPath, "utf8"), /terminal-output/);
	await delay(100);
	assert.equal(h.sends.length, 1);
});

test("bash_status consumes a terminal job before its notification dispatch", async () => {
	h.sends.length = 0;
	const result = await bash().execute("terminal-before-notification", { command: "sleep 1.01; printf \"$PI_BASH_TEST_STATUS_OUTPUT\"", timeout: 1 }, undefined, undefined, { cwd: process.cwd() });
	const runningMessage = result.content[0]?.text ?? "";
	const jobId = jobIdFrom(runningMessage);
	const logPath = logPathFrom(runningMessage);
	await waitForTerminalJob(jobId);

	const snapshot = await status().execute("status-terminal", { jobId }, undefined, undefined, { cwd: process.cwd() });
	assert.match(snapshot.content[0]?.text ?? "", /status-before-notification-output/);
	assert.match(await readFile(logPath, "utf8"), /status-before-notification-output/);
	await assert.rejects(() => status().execute("status-terminal-again", { jobId }, undefined, undefined, { cwd: process.cwd() }));
	assert.equal(h.sends.length, 0);
	await delay(100);
	assert.equal(h.sends.length, 0);
});

test("bash_jobs recovers terminal jobs and bash_status consumes them", async () => {
	h.sends.length = 0;
	const result = await bash().execute("terminal", { command: "sleep 1.05; printf status-output", timeout: 1 }, undefined, undefined, { cwd: process.cwd() });
	const jobId = jobIdFrom(result.content[0]?.text ?? "");
	await waitFor(() => h.sends.length === 1);
	const listed = await jobs().execute("jobs", {});
	assert.match(listed.content[0]?.text ?? "", new RegExp(jobId));
	assert.match(listed.content[0]?.text ?? "", /completed/);

	const snapshot = await status().execute("status", { jobId }, undefined, undefined, { cwd: process.cwd() });
	assert.match(snapshot.content[0]?.text ?? "", /status-output/);
	await assert.rejects(() => status().execute("status-again", { jobId }, undefined, undefined, { cwd: process.cwd() }));
});

test("bash_status retains running jobs without purging them", async () => {
	h.sends.length = 0;
	const result = await bash().execute("running", { command: "sleep 1.2; printf should-not-run", timeout: 1 }, undefined, undefined, { cwd: process.cwd() });
	const jobId = jobIdFrom(result.content[0]?.text ?? "");
	const snapshot = await status().execute("status-running", { jobId }, undefined, undefined, { cwd: process.cwd() });
	assert.match(snapshot.content[0]?.text ?? "", new RegExp(`Job: ${jobId}`));
	assert.match(snapshot.content[0]?.text ?? "", /Status: running/);
	const listed = await jobs().execute("jobs-running", {});
	assert.match(listed.content[0]?.text ?? "", new RegExp(jobId));
	await kill().execute("kill-running", { jobId }, undefined, undefined, { cwd: process.cwd() });
	assert.equal(h.sends.length, 0);
});

test("close terminal completions use one batched steering message", async () => {
	h.sends.length = 0;
	const [first, second] = await Promise.all([
		bash().execute("batch-one", { command: "sleep 1.1; printf \"$PI_BASH_TEST_BATCH_ONE\"; : batch-one", timeout: 1 }, undefined, undefined, { cwd: process.cwd() }),
		bash().execute("batch-two", { command: "sleep 1.1; printf \"$PI_BASH_TEST_BATCH_TWO\"; : batch-two", timeout: 1 }, undefined, undefined, { cwd: process.cwd() }),
	]);
	assert.match(first.content[0]?.text ?? "", /still running/);
	assert.match(second.content[0]?.text ?? "", /still running/);
	await waitFor(() => h.sends.length === 1, 2_000);
	assert.deepEqual(h.sends[0]?.options, { triggerTurn: true, deliverAs: "steer" });
	assert.match(h.sends[0]?.message.content, /batch-one/);
	assert.match(h.sends[0]?.message.content, /batch-two/);
	assert.equal(h.sends[0]?.message.content.includes("batch-one-output"), false);
	assert.equal(h.sends[0]?.message.content.includes("batch-two-output"), false);
});

test("explicit kill suppresses completion notifications", async () => {
	h.sends.length = 0;
	const result = await bash().execute("kill", { command: "sleep 1.2; printf killed-output", timeout: 1 }, undefined, undefined, { cwd: process.cwd() });
	const jobId = jobIdFrom(result.content[0]?.text ?? "");
	await kill().execute("kill-detached", { jobId }, undefined, undefined, { cwd: process.cwd() });
	await delay(150);
	assert.equal(h.sends.length, 0);
});

test("session shutdown suppresses completion notifications", async () => {
	h.sends.length = 0;
	const result = await bash().execute("shutdown", { command: "sleep 1.2; printf shutdown-output", timeout: 1 }, undefined, undefined, { cwd: process.cwd() });
	assert.match(result.content[0]?.text ?? "", /still running/);
	await h.emit("session_shutdown", { reason: "quit" });
	await delay(150);
	assert.equal(h.sends.length, 0);
});
