import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import nodeTest from "node:test";

function e2eTest(
	name: string,
	options: { timeout: number },
	callback: () => Promise<void>,
): void {
	nodeTest(name, { ...options, concurrency: true }, callback);
}

const directory = dirname(fileURLToPath(import.meta.url));
const driver = join(directory, "e2e-driver.ts");
const fakePi = join(directory, "e2e-fake-pi.mjs");

type DriverResult = Record<string, unknown> & { ok: boolean; scenario: string };

function terminateProcessGroup(pid: number | undefined): void {
	if (!pid) return;
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// The driver already exited.
		}
	}
}

async function waitForChildClose(
	close: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
	milliseconds = 1_000,
): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			resolve(false);
		}, milliseconds);
		void close.then(
			() => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(true);
			},
			() => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(true);
			},
		);
	});
}

async function runScenario(
	scenario: string,
	timeoutMs = 8_000,
): Promise<DriverResult> {
	const child = spawn(
		process.execPath,
		["--experimental-transform-types", driver, scenario],
		{
			cwd: directory,
			env: {
				...process.env,
				E2E_FAKE_PI: fakePi,
			},
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		},
	);
	let stdout = "";
	let stderr = "";
	let resolveResult!: (result: DriverResult) => void;
	const resultOutput = new Promise<DriverResult>((resolve) => {
		resolveResult = resolve;
	});
	let resultResolved = false;
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		stdout += chunk;
		if (resultResolved) return;
		for (const line of stdout.split("\n")) {
			if (!line.trim()) continue;
			try {
				const parsed = JSON.parse(line) as Partial<DriverResult>;
				if (parsed.scenario !== scenario || typeof parsed.ok !== "boolean") continue;
				resultResolved = true;
				resolveResult(parsed as DriverResult);
				break;
			} catch {
				// The final JSON record can arrive in multiple chunks.
			}
		}
	});
	child.stderr?.on("data", (chunk: string) => {
		stderr += chunk;
	});
	const close = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
		(resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code, signal) => resolve({ code, signal }));
		},
	);
	let timer: NodeJS.Timeout | undefined;
	try {
		const outcome = await Promise.race([
			resultOutput.then((parsed) => ({ type: "result" as const, parsed })),
			close.then((exit) => ({ type: "close" as const, exit })),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					terminateProcessGroup(child.pid);
					reject(new Error(`E2E scenario ${scenario} timed out after ${timeoutMs} ms.`));
				}, timeoutMs);
			}),
		]);
		if (outcome.type === "result") {
			terminateProcessGroup(child.pid);
			if (!(await waitForChildClose(close)))
				throw new Error(`E2E scenario ${scenario} process cleanup timed out.`);
			assert.equal(
				outcome.parsed.ok,
				true,
				`E2E scenario ${scenario} reported failure: ${JSON.stringify(outcome.parsed)}`,
			);
			return outcome.parsed;
		}
		if (outcome.exit.code !== 0) {
			throw new Error(
				`E2E scenario ${scenario} exited with code ${String(outcome.exit.code)} signal ${String(outcome.exit.signal)}.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
			);
		}
		const lines = stdout.trim().split("\n").filter(Boolean);
		const line = lines.at(-1);
		if (!line) throw new Error(`E2E scenario ${scenario} produced no result.\nstderr:\n${stderr}`);
		const parsed = JSON.parse(line) as DriverResult;
		assert.equal(parsed.ok, true, `E2E scenario ${scenario} reported failure: ${JSON.stringify(parsed)}`);
		return parsed;
	} catch (error) {
		terminateProcessGroup(child.pid);
		if (!(await waitForChildClose(close)))
			throw new Error(`E2E scenario ${scenario} process cleanup timed out.`, { cause: error });
		throw error;
	} finally {
		if (timer) clearTimeout(timer);
	}
}

const cancellationCases: [string, string, number][] = [
	["start", "subagent_start", 6_000],
	["list", "subagent_list", 6_000],
	["status", "subagent_status", 6_000],
	["steer", "subagent_steer", 6_000],
	["follow-up", "subagent_follow_up", 6_000],
	["interrupt", "subagent_interrupt", 6_000],
	["kill", "subagent_kill", 10_000],
	["resume", "subagent_resume", 7_000],
];

for (const [suffix, toolName, timeoutMs] of cancellationCases) {
	e2eTest(`E2E: cancellation releases ${toolName}`, { timeout: timeoutMs + 2_000 }, async () => {
		const result = await runScenario(`cancel-${suffix}`, timeoutMs);
		assert.equal(result.settled, true);
	});
}

e2eTest(
	"E2E: resume cancellation releases the original indefinite-resume chain",
	{ timeout: 9_000 },
	async () => {
		const result = await runScenario("cancel-resume", 7_000);
		assert.equal(result.tool, "subagent_resume");
	},
);

e2eTest("E2E: production abort responds after native settlement", { timeout: 8_000 }, async () => {
	const result = await runScenario("abort-order");
	assert.equal(result.responseAfterSettlement, true);
	assert.equal(result.interrupted, true);
});

e2eTest("E2E: slow production abort remains accepted after settlement", { timeout: 8_000 }, async () => {
	const result = await runScenario("abort-order-slow", 5_000);
	assert.equal(result.interrupted, true);
});

e2eTest("E2E: stream updates keep registry persistence bounded", { timeout: 12_000 }, async () => {
	const result = await runScenario("stream-flood", 9_000);
	assert.ok(Number(result.registrySaves) > 0);
	assert.ok(Number(result.registrySaves) < 100);
});

e2eTest("E2E: persistence floods save current state and cannot hold shutdown", { timeout: 15_000 }, async () => {
	const result = await runScenario("persistence-flood", 12_000);
	assert.ok(Number(result.registrySaves) > 0);
	assert.ok(Number(result.shutdownMs) < 1_000);
});

e2eTest("E2E: active child count stays bounded", { timeout: 35_000 }, async () => {
	const result = await runScenario("active-child-limit", 30_000);
	assert.ok(Number(result.accepted) <= 8);
});

e2eTest("E2E: a large valid agent_end settles, wakes, and publishes output", { timeout: 10_000 }, async () => {
	const result = await runScenario("large-agent-end", 7_000);
	assert.equal(result.settled, true);
	assert.equal(result.wakeCount, 1);
	assert.equal(result.output, "written");
});

e2eTest("E2E: unterminated RPC records are discarded with a diagnostic", { timeout: 6_000 }, async () => {
	const result = await runScenario("rpc-unterminated-record");
	assert.equal(result.discarded, true);
});

e2eTest("E2E: RPC stdin bounds pending requests and queued bytes", { timeout: 8_000 }, async () => {
	const result = await runScenario("backpressure");
	assert.ok(Number(result.pendingBefore) > 0);
	assert.equal(Number(result.pendingAfter), 0);
	assert.ok(Number(result.queuedBytesBefore) <= 16 * 1024 * 1024);
});

e2eTest("E2E: reload drains under-limit records without losing settlement", { timeout: 12_000 }, async () => {
	const result = await runScenario("reload-queue-under-limit", 9_000);
	assert.equal(result.queueDelivered, true);
	assert.equal(result.overflow, false);
	assert.ok(Number(result.queueCount) < 512);
});

e2eTest("E2E: reload reports explicit overflow while preserving settlement", { timeout: 12_000 }, async () => {
	const result = await runScenario("reload-queue-overflow", 9_000);
	assert.equal(result.queueDelivered, true);
	assert.equal(result.overflow, true);
	assert.ok(Number(result.queueCount) > 512);
	assert.equal(result.forced, true);
	assert.ok(
		(Array.isArray(result.diagnostics) ? result.diagnostics : []).some((value) =>
			String(value).includes("overflow is terminal"),
		),
	);
});

e2eTest("E2E: startup requires the exact health marker and rejects extension errors", { timeout: 8_000 }, async () => {
	const result = await runScenario("startup-extension-health");
	assert.equal(result.markerExact, true);
	assert.equal(result.rejected, true);
});

e2eTest("E2E: asynchronous close callbacks preserve lifecycle evidence", { timeout: 8_000 }, async () => {
	const result = await runScenario("close-callback");
	assert.equal(result.closeHandled, true);
	assert.equal(result.lifecycle, "error");
	assert.equal(result.forced, false);
});

e2eTest("E2E: aborted idle state does not contradict its lifecycle", { timeout: 8_000 }, async () => {
	const result = await runScenario("lifecycle-consistency");
	assert.notEqual(result.state, "running");
});

e2eTest("E2E: a new run clears prior completion metadata", { timeout: 8_000 }, async () => {
	const result = await runScenario("stale-run-view");
	assert.equal(result.completedAt, undefined);
});

e2eTest("E2E: large valid transcript records remain readable", { timeout: 8_000 }, async () => {
	const result = await runScenario("transcript-large-record");
	assert.equal(result.transcript, "available");
});

e2eTest("E2E: launch stops when its initial registry save fails", { timeout: 8_000 }, async () => {
	const result = await runScenario("launch-persistence");
	assert.equal(result.childStarted, false);
});

e2eTest("E2E: ephemeral parent sessions can start children", { timeout: 8_000 }, async () => {
	const result = await runScenario("ephemeral-parent");
	assert.equal(result.accepted, true);
});

e2eTest("E2E: settlement guidance names the status message parameter", { timeout: 8_000 }, async () => {
	const result = await runScenario("notification-parameter");
	assert.match(String(result.content), /numMessages=3/);
});

e2eTest("E2E: concurrent resume creates one child incarnation", { timeout: 12_000 }, async () => {
	const result = await runScenario("concurrent-resume", 9_000);
	assert.equal(result.processStarts, 2);
});

e2eTest("E2E: a canceled queued operation releases its predecessor", { timeout: 12_000 }, async () => {
	const result = await runScenario("hanging-predecessor", 9_000);
	assert.equal(result.predecessorCanceled, true);
	assert.equal(result.successorCanceled, true);
	assert.equal(result.queueReleased, true);
	assert.equal(result.processStarts, 1);
});

e2eTest("E2E: concurrent same-child messages serialize", { timeout: 10_000 }, async () => {
	const result = await runScenario("concurrent-messages");
	assert.equal(result.overlap, 0);
});

// Keep this import in the test module so the launcher reports a clear fixture error.
await readFile(fakePi);
