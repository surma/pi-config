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
	["start", "subagent_start", 4_000],
	["list", "subagent_list", 4_000],
	["status", "subagent_status", 4_000],
	["steer", "subagent_steer", 4_000],
	["follow-up", "subagent_follow_up", 4_000],
	["interrupt", "subagent_interrupt", 4_000],
	["kill", "subagent_kill", 10_000],
	["resume", "subagent_resume", 5_000],
];

for (const [suffix, toolName, timeoutMs] of cancellationCases) {
	e2eTest(`E2E: cancellation releases ${toolName}`, { timeout: timeoutMs + 2_000 }, async () => {
		const result = await runScenario(`cancel-${suffix}`, timeoutMs);
		assert.equal(result.settled, true);
	});
}

e2eTest(
	"E2E: resume cancellation releases the original indefinite-resume chain",
	{ timeout: 7_000 },
	async () => {
		const result = await runScenario("cancel-resume", 5_000);
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
	assert.ok(Number(result.registryEvents) < 100);
});

e2eTest("E2E: persistence floods cannot hold shutdown", { timeout: 15_000 }, async () => {
	const result = await runScenario("persistence-flood", 12_000);
	assert.ok(Number(result.shutdownMs) < 1_000);
});

e2eTest("E2E: active child count stays bounded", { timeout: 35_000 }, async () => {
	const result = await runScenario("active-child-limit", 30_000);
	assert.ok(Number(result.accepted) <= 8);
});

e2eTest("E2E: oversized unterminated RPC records are discarded with a diagnostic", { timeout: 6_000 }, async () => {
	const result = await runScenario("rpc-buffer-limit");
	assert.equal(result.discarded, true);
});

e2eTest("E2E: RPC stdin honors stream backpressure", { timeout: 8_000 }, async () => {
	const result = await runScenario("backpressure");
	assert.ok(Number(result.writableLength) <= 8 * 1024 * 1024);
});

e2eTest("E2E: reload drains queued records without losing settlement", { timeout: 12_000 }, async () => {
	const result = await runScenario("reload-queue", 9_000);
	assert.equal(result.queueDelivered, true);
});

e2eTest("E2E: startup rejects a child with an extension health error", { timeout: 8_000 }, async () => {
	const result = await runScenario("startup-extension-health");
	assert.equal(result.rejected, true);
});

e2eTest("E2E: close callback errors cannot crash the parent", { timeout: 8_000 }, async () => {
	const result = await runScenario("close-callback");
	assert.equal(result.closeHandled, true);
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

e2eTest("E2E: concurrent same-child messages serialize", { timeout: 10_000 }, async () => {
	const result = await runScenario("concurrent-messages");
	assert.equal(result.overlap, 0);
});

// Keep this import in the test module so the launcher reports a clear fixture error.
await readFile(fakePi);
