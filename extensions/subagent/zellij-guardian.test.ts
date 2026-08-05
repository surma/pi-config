import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const guardian = new URL("./zellij-guardian.mjs", import.meta.url);
const session = "pi0123456789abcdefABCDEF";
const generation = "0123456789abcdef0123456789abcdef";
const capability = "a".repeat(64);

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "pi-zellij-guardian-"));
	const log = join(directory, "log");
	const binary = join(directory, "zellij");
	await writeFile(binary, `#!/bin/sh
printf '%s ' "$@" >> ${JSON.stringify(log)}
if [ "$1" = list-sessions ]; then
  printf 'No active zellij sessions found.\\n' >&2
  exit 1
fi
exit 0
`);
	await chmod(binary, 0o755);
	return { binary, log };
}
function start(
	binary: string,
	guardianGeneration = generation,
	guardianCapability = capability,
) {
	return spawn(
		process.execPath,
		[guardian.pathname, session, guardianGeneration, guardianCapability, binary],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);
}
async function ready(proc: ReturnType<typeof start>): Promise<string> {
	let output = "";
	proc.stdout!.setEncoding("utf8");
	await new Promise<void>((resolve, reject) => {
		proc.stdout!.on("data", (chunk: string) => { output += chunk; if (output.includes('"ready"')) resolve(); });
		proc.once("error", reject);
		proc.once("close", (code) => reject(new Error(`guardian exited before ready (${code ?? "unknown"})`)));
	});
	return output;
}

test("guardian rejects malformed generation and capability startup arguments", async () => {
	const { binary, log } = await fixture();
	const cases = [
		[session, "short", capability, binary],
		[session, generation.toUpperCase(), capability, binary],
		[session, generation, "short", binary],
		[session, generation, capability.toUpperCase(), binary],
		[session, generation],
	];
	for (const args of cases) {
		const proc = spawn(process.execPath, [guardian.pathname, ...args], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		let output = "";
		proc.stdout.setEncoding("utf8");
		proc.stdout.on("data", (chunk: string) => { output += chunk; });
		const code = await new Promise<number | null>((resolve) => proc.on("close", resolve));
		assert.equal(code, 64);
		assert.equal(output, "");
	}
	assert.equal(await readFile(log, "utf8").catch(() => ""), "");
});

test("guardian ready includes the exact generation and independent capability", async () => {
	const { binary, log } = await fixture();
	const proc = start(binary);
	const output = await ready(proc);
	assert.match(
		output,
		new RegExp(`"type":"ready","generation":"${generation}","capability":"${capability}"`),
	);
	proc.stdin!.end();
	await new Promise<void>((resolve) => proc.on("close", () => resolve()));
	assert.match(await readFile(log, "utf8"), /delete-session/);
});

test("guardian deletes only its exact session after control EOF", async () => {
	const { binary, log } = await fixture();
	const proc = start(binary);
	await ready(proc);
	proc.stdin!.end();
	const [code] = await new Promise<[number | null]>((resolve) => proc.on("close", (value) => resolve([value])));
	assert.equal(code, 0);
	const calls = await readFile(log, "utf8");
	assert.match(calls, new RegExp(`delete-session --force ${session}`));
	assert.match(calls, /list-sessions --short --no-formatting/);
});

test("guardian rejects a stale generation and cleans up on EOF", async () => {
	const { binary, log } = await fixture();
	const proc = start(binary);
	await ready(proc);
	proc.stdin!.end(
		`${JSON.stringify({
			type: "disarm",
			generation: "f".repeat(32),
			capability,
		})}\n`,
	);
	await new Promise<void>((resolve) => proc.on("close", () => resolve()));
	assert.match(await readFile(log, "utf8"), /delete-session/);
});

test("guardian rejects an invalid capability and cleans up on EOF", async () => {
	const { binary, log } = await fixture();
	const proc = start(binary);
	await ready(proc);
	proc.stdin!.end(
		`${JSON.stringify({
			type: "disarm",
			generation,
			capability: "b".repeat(64),
		})}\n`,
	);
	await new Promise<void>((resolve) => proc.on("close", () => resolve()));
	assert.match(await readFile(log, "utf8"), /delete-session/);
});

test("guardian valid disarm acknowledges and does not delete", async () => {
	const { binary, log } = await fixture();
	const proc = start(binary);
	let output = "";
	proc.stdout!.setEncoding("utf8");
	proc.stdout!.on("data", (chunk: string) => {
		output += chunk;
	});
	await ready(proc);
	proc.stdin!.write(
		`${JSON.stringify({
			type: "disarm",
			generation,
			capability,
		})}\n`,
	);
	await new Promise<void>((resolve) => {
		const check = () => output.includes('"type":"ack"') && resolve();
		proc.stdout!.on("data", check);
		check();
	});
	assert.equal(proc.exitCode, null, "guardian must wait for control EOF after ack");
	assert.match(
		output,
		new RegExp(`"type":"ack","generation":"${generation}","capability":"${capability}"`),
	);
	proc.stdin!.end();
	const code = await new Promise<number | null>((resolve) =>
		proc.on("close", resolve),
	);
	assert.equal(code, 0);
	assert.equal(
		(await readFile(log, "utf8").catch(() => "")).includes("delete-session"),
		false,
	);
});
