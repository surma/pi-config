import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import childSubagentExtension, {
	CHILD_EXTENSION_HEALTH_SIGNAL,
	childExtensionHealthPath,
	verifyChildExtensionHealth,
	waitForChildExtensionHealth,
	writeChildExtensionHealthSignal,
} from "./child.ts";

test("child extension leaves native run settlement with the RPC host", () => {
	const registered: string[] = [];
	childSubagentExtension({
		on(name: string) {
			registered.push(name);
			return undefined;
		},
	} as never);
	assert.deepEqual(registered, [
		"session_start",
		"session_shutdown",
		"agent_start",
		"before_agent_start",
	]);
});

test("child extension health uses an exact bounded marker and rejects missing or bad signals", async () => {
	const directory = await fs.mkdtemp(join(tmpdir(), "pi-child-health-"));
	try {
		const path = childExtensionHealthPath(directory, "incarnation-a");
		assert.equal(await verifyChildExtensionHealth(path), false);
		assert.equal(
			await waitForChildExtensionHealth(path, { timeoutMs: 0 }),
			false,
		);
		assert.equal(await writeChildExtensionHealthSignal(path), true);
		assert.equal(await verifyChildExtensionHealth(path), true);
		assert.equal(
			await waitForChildExtensionHealth(path, { timeoutMs: 0 }),
			true,
		);
		await fs.writeFile(path, `${CHILD_EXTENSION_HEALTH_SIGNAL}extra`);
		assert.equal(await verifyChildExtensionHealth(path), false);
		await fs.writeFile(path, "bad-health-marker");
		assert.equal(await verifyChildExtensionHealth(path), false);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("child health ignores an inherited override path", async () => {
	const directory = await fs.mkdtemp(join(tmpdir(), "pi-child-health-override-"));
	const overridePath = join(directory, "override.marker");
	const environment = {
		sessionDir: process.env.PI_SUBAGENT_SESSION_DIR,
		incarnation: process.env.PI_SUBAGENT_INCARNATION,
		healthPath: process.env.PI_SUBAGENT_HEALTH_PATH,
	};
	try {
		process.env.PI_SUBAGENT_SESSION_DIR = directory;
		process.env.PI_SUBAGENT_INCARNATION = "incarnation-b";
		process.env.PI_SUBAGENT_HEALTH_PATH = overridePath;
		const module = await import(`./child.ts?health-path-test=${Math.random()}`);
		const handlers = new Map<string, (...args: any[]) => unknown>();
		module.default({
			on(name: string, handler: (...args: any[]) => unknown) {
				handlers.set(name, handler);
				return undefined;
			},
		} as never);
		await handlers.get("session_start")?.({}, { getSystemPrompt: () => "" });
		assert.equal(
			await verifyChildExtensionHealth(childExtensionHealthPath(directory, "incarnation-b")),
			true,
		);
		assert.equal(await verifyChildExtensionHealth(overridePath), false);
		await handlers.get("session_shutdown")?.();
	} finally {
		if (environment.sessionDir === undefined) delete process.env.PI_SUBAGENT_SESSION_DIR;
		else process.env.PI_SUBAGENT_SESSION_DIR = environment.sessionDir;
		if (environment.incarnation === undefined) delete process.env.PI_SUBAGENT_INCARNATION;
		else process.env.PI_SUBAGENT_INCARNATION = environment.incarnation;
		if (environment.healthPath === undefined) delete process.env.PI_SUBAGENT_HEALTH_PATH;
		else process.env.PI_SUBAGENT_HEALTH_PATH = environment.healthPath;
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("aborted child health checks preserve cancellation", async () => {
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		verifyChildExtensionHealth("/tmp/missing-child-health", controller.signal),
		(error: unknown) => error instanceof Error && error.name === "AbortError",
	);
	await assert.rejects(
		waitForChildExtensionHealth("/tmp/missing-child-health", {
			timeoutMs: 10_000,
			signal: controller.signal,
		}),
		(error: unknown) => error instanceof Error && error.name === "AbortError",
	);
	await assert.rejects(
		writeChildExtensionHealthSignal(
			join(tmpdir(), "pi-aborted-child-health", "marker"),
			controller.signal,
		),
		(error: unknown) => error instanceof Error && error.name === "AbortError",
	);
});
