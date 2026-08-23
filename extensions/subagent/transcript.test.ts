import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	parseTranscript,
	readTranscript,
	type TranscriptMessage,
} from "./transcript.ts";

function line(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

function message(
	role: string,
	content: unknown,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		type: "message",
		id: `${role}-entry`,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role, content, ...extra },
	};
}

async function temporaryFile(content: string): Promise<{
	directory: string;
	path: string;
}> {
	const directory = await mkdtemp(join(tmpdir(), "pi-transcript-"));
	const path = join(directory, "child.jsonl");
	await writeFile(path, content, "utf8");
	return { directory, path };
}

async function removeTemporary(directory: string): Promise<void> {
	await rm(directory, { recursive: true, force: true });
}

test("missing paths and read errors have explicit statuses", async () => {
	const missing = await readTranscript("/path/that/does/not/exist.jsonl");
	assert.deepEqual(missing, {
		status: "missing",
		messages: [],
		nextMessageOffset: 0,
	});

	const directory = await mkdtemp(join(tmpdir(), "pi-transcript-directory-"));
	try {
		const unreadable = await readTranscript(directory);
		assert.equal(unreadable.status, "unreadable");
		assert.deepEqual(unreadable.messages, []);
	} finally {
		await removeTemporary(directory);
	}
});

test("projection keeps user text, assistant text, and normalized errors only", () => {
	const content = [
		line({ type: "session", version: 3, id: "session" }),
		line(message("user", [
			{ type: "text", text: "question" },
			{ type: "image", data: "ignored", mimeType: "image/png" },
		], { timestamp: 101 })),
		line(message("assistant", [
			{ type: "thinking", thinking: "secret" },
			{ type: "text", text: "answer" },
			{ type: "toolCall", name: "ignored", arguments: {} },
		], { timestamp: 102, stopReason: "stop" })),
		line(message("toolResult", [{ type: "text", text: "tool output" }])),
		line({ type: "custom", id: "custom", data: "ignored" }),
		line({ type: "compaction", id: "compact", summary: "ignored" }),
		line(message("user", [{ type: "image", data: "ignored", mimeType: "image/png" }])),
		line(message("assistant", [], { timestamp: 103, stopReason: "error", errorMessage: "quota" })),
		line(message("assistant", [{ type: "text", text: "partial" }], { errorMessage: "failed" })),
	].join("");

	const result = parseTranscript(content, { numMessages: 20 });
	assert.equal(result.status, "available");
	assert.deepEqual(result.messages, [
		{ role: "user", text: "question", timestamp: 101 },
		{ role: "assistant", text: "answer", timestamp: 102 },
		{ role: "error", text: "quota", timestamp: 103 },
		{
			role: "error",
			text: "failed",
			timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
		},
	] satisfies TranscriptMessage[]);
	assert.equal(result.nextMessageOffset, 4);
});

test("offsets count filtered messages and remain stable when lines append", () => {
	const initial = [
		line({ type: "session", id: "session" }),
		line(message("user", "one")),
		line(message("toolResult", [{ type: "text", text: "ignored" }])),
		line(message("assistant", [{ type: "text", text: "two" }])),
	].join("");
	const first = parseTranscript(initial, { messageOffset: 0, numMessages: 2 });
	assert.deepEqual(first.messages.map(({ role, text }) => ({ role, text })), [
		{ role: "user", text: "one" },
		{ role: "assistant", text: "two" },
	]);
	assert.equal(first.nextMessageOffset, 2);

	const appended = `${initial}${line(message("user", "three"))}`;
	const second = parseTranscript(appended, {
		messageOffset: first.nextMessageOffset,
		numMessages: 3,
	});
	assert.deepEqual(second.messages.map(({ role, text }) => ({ role, text })), [
		{ role: "user", text: "three" },
	]);
	assert.equal(second.nextMessageOffset, 3);
});

test("a final record without LF remains incomplete and never appears", () => {
	const complete = line({ type: "session", id: "session" }) + line(message("user", "complete"));
	const finalRecord = JSON.stringify(message("assistant", [
		{ type: "text", text: "still being written" },
	]));
	const result = parseTranscript(`${complete}${finalRecord}`, { numMessages: 20 });
	assert.equal(result.status, "incomplete");
	assert.deepEqual(result.messages, [
		{
			role: "user",
			text: "complete",
			timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
		},
	]);
	assert.equal(result.nextMessageOffset, 1);
});

test("LF framing accepts CRLF but does not treat CR as a record separator", () => {
	const record = line(message("user", "line framed"));
	const crlf = parseTranscript(record.replaceAll("\n", "\r\n"), { numMessages: 20 });
	assert.equal(crlf.status, "available");
	assert.deepEqual(crlf.messages.map(({ role, text }) => ({ role, text })), [
		{ role: "user", text: "line framed" },
	]);

	const crOnly = parseTranscript(record.replace("\n", "\r"), { numMessages: 20 });
	assert.equal(crOnly.status, "incomplete");
	assert.deepEqual(crOnly.messages, []);
});

test("malformed complete records report unreadable while valid records stay inspectable", () => {
	const content = [
		line(message("user", "before")),
		"not-json\n",
		line(message("assistant", [{ type: "text", text: "after" }])),
	].join("");
	const result = parseTranscript(content, { numMessages: 20 });
	assert.equal(result.status, "unreadable");
	assert.deepEqual(result.messages.map(({ role, text }) => ({ role, text })), [
		{ role: "user", text: "before" },
		{ role: "assistant", text: "after" },
	]);
	assert.equal(result.nextMessageOffset, 2);
});

test("limits page size and bounds individual and total text", () => {
	const huge = "x".repeat(100_000);
	const content = Array.from({ length: 25 }, (_, index) =>
		line(message("assistant", [{ type: "text", text: index === 0 ? huge : `message-${index}` }])),
	).join("");
	const result = parseTranscript(content, { numMessages: 100 });
	assert.equal(result.status, "available");
	assert.equal(result.messages.length, 20);
	assert.ok(result.messages.every((item) => item.text.length <= 8 * 1024));
	assert.ok(result.messages.reduce((total, item) => total + item.text.length, 0) <= 32 * 1024);
	assert.equal(result.nextMessageOffset, result.messages.length);
});

test("numeric arguments and defaults normalize the pagination contract", () => {
	const content = Array.from({ length: 5 }, (_, index) =>
		line(message("user", `message-${index}`)),
	).join("");
	assert.equal(parseTranscript(content).messages.length, 3);
	assert.equal(parseTranscript(content, 1, 2).nextMessageOffset, 3);
	assert.equal(parseTranscript(content, { messageOffset: -4, numMessages: 99 }).messages.length, 5);
	assert.equal(parseTranscript(content, { messageOffset: 2, numMessages: 0 }).nextMessageOffset, 2);
});

test("the file reader parses one snapshot and does not expose a partial append", async () => {
	const fixture = await temporaryFile(
		line(message("user", "saved")) +
		JSON.stringify(message("assistant", [{ type: "text", text: "partial" }])),
	);
	try {
		const result = await readTranscript(fixture.path, { numMessages: 20 });
		assert.equal(result.status, "incomplete");
		assert.deepEqual(result.messages, [
			{
				role: "user",
				text: "saved",
				timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
			},
		]);
		assert.equal(await readFile(fixture.path, "utf8"),
			line(message("user", "saved")) +
			JSON.stringify(message("assistant", [{ type: "text", text: "partial" }])),
		);
	} finally {
		await removeTemporary(fixture.directory);
	}
});
