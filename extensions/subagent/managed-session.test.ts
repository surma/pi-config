import assert from "node:assert/strict";
import { promises as nodeFs } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createManagedSessionName,
	createManagedSessionRecord,
	isManagedSessionRecord,
	loadManagedSession,
	removeManagedSession,
	removeManagedSessionIfMatches,
	saveManagedSession,
} from "./managed-session.ts";

const owner = { ownerSessionFile: "/tmp/owner.jsonl", ownerSessionId: "a-b-c" };
const generation = "0123456789abcdef0123456789abcdef";

function validRecord() {
	return createManagedSessionRecord(owner, generation, createManagedSessionName(owner.ownerSessionId), 123);
}

test("managed session names are compact URL-safe 128-bit random values", () => {
	const names = new Set(
		Array.from({ length: 100 }, () => createManagedSessionName("ignored-owner")),
	);
	assert.equal(names.size, 100);
	for (const name of names) {
		assert.equal(name.length, 24);
		assert.match(name, /^pi[A-Za-z0-9_-]{22}$/);
	}
});

test("managed records round trip atomically", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-managed-session-"));
	const path = join(directory, "managed-session.json");
	const record = validRecord();
	await saveManagedSession(path, record);
	assert.deepEqual(await loadManagedSession(path), record);
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), record);
	await removeManagedSession(path);
	assert.equal(await loadManagedSession(path), undefined);
});

test("strict validation rejects malformed generation, session names, extra keys, and timestamps", () => {
	const record = validRecord();
	assert.equal(isManagedSessionRecord(record), true);
	assert.equal(isManagedSessionRecord({ ...record, generation: "not-32-hex" }), false);
	assert.equal(isManagedSessionRecord({ ...record, generation: "A".repeat(32) }), false);
	assert.equal(isManagedSessionRecord({ ...record, sessionName: `pi-subagent-owner-${"a".repeat(32)}` }), false);
	assert.equal(isManagedSessionRecord({ ...record, sessionName: `pi${"a".repeat(21)}` }), false);
	assert.equal(isManagedSessionRecord({ ...record, sessionName: `pi${"a".repeat(23)}` }), false);
	assert.equal(isManagedSessionRecord({ ...record, sessionName: `pi${"!".repeat(22)}` }), false);
	assert.equal(isManagedSessionRecord({ ...record, extra: true }), false);
	for (const createdAt of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
		assert.equal(isManagedSessionRecord({ ...record, createdAt }), false);
	assert.equal(isManagedSessionRecord({ ...record, ownerSessionFile: "" }), false);
	assert.equal(isManagedSessionRecord({ ...record, ownerSessionId: "" }), false);
});

test("empty and invalid durable records fail closed", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-managed-session-"));
	const path = join(directory, "managed-session.json");
	await writeFile(path, "\n");
	await assert.rejects(loadManagedSession(path), /empty/);
	await writeFile(path, JSON.stringify({ version: 1, sessionName: "evil" }));
	await assert.rejects(loadManagedSession(path), /invalid/);
	assert.equal(isManagedSessionRecord({}), false);
});

test("record writes serialize with compare-and-remove so a racing successor survives", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-managed-session-"));
	const path = join(directory, "managed-session.json");
	const expected = { ...validRecord(), state: "cleanup_pending" as const };
	const successor = createManagedSessionRecord(
		owner,
		"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		createManagedSessionName(owner.ownerSessionId),
		125,
		"active",
	);
	await saveManagedSession(path, expected);
	const originalReadFile = nodeFs.readFile.bind(nodeFs);
	let releaseRead!: () => void;
	const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
	let compared = false;
	try {
		nodeFs.readFile = (async (target: Parameters<typeof nodeFs.readFile>[0], ...args: unknown[]) => {
			const result = await (originalReadFile as (...values: unknown[]) => Promise<unknown>)(target, ...args);
			if (!compared && String(target) === path) {
				compared = true;
				await readGate;
			}
			return result;
		}) as typeof nodeFs.readFile;
		const removing = removeManagedSessionIfMatches(path, expected);
		for (let turn = 0; turn < 100 && !compared; turn++)
			await new Promise<void>((resolve) => setTimeout(resolve, 1));
		assert.equal(compared, true);
		let successorSaved = false;
		const saving = saveManagedSession(path, successor).then(() => { successorSaved = true; });
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
		assert.equal(successorSaved, false, "successor write bypassed the owner-record lock");
		releaseRead();
		await Promise.all([removing, saving]);
		assert.deepEqual(await loadManagedSession(path), successor);
	} finally {
		releaseRead();
		nodeFs.readFile = originalReadFile;
	}
});

test("compare-and-remove refuses a successor generation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-managed-session-"));
	const path = join(directory, "managed-session.json");
	const expected = { ...validRecord(), state: "cleanup_pending" as const };
	const successor = createManagedSessionRecord(
		owner,
		"fedcba9876543210fedcba9876543210",
		createManagedSessionName(owner.ownerSessionId),
		124,
		"active",
	);
	await saveManagedSession(path, successor);
	await assert.rejects(removeManagedSessionIfMatches(path, expected), /changed before removal/);
	assert.deepEqual(await loadManagedSession(path), successor);
});
