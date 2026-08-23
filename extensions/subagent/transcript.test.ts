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

const MAX_MESSAGE_BYTES = 8 * 1024;
const MAX_PAGE_BYTES = 32 * 1024;

function assertWellFormedUtf16(value: string): void {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			assert.ok(
				next >= 0xdc00 && next <= 0xdfff,
				`unpaired high surrogate at UTF-16 index ${index}`,
			);
			index++;
		} else {
			assert.ok(
				code < 0xdc00 || code > 0xdfff,
				`unpaired low surrogate at UTF-16 index ${index}`,
			);
		}
	}
}

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
		line({ type: "error", timestamp: 104, error: { message: "provider disconnected" } }),
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
		{ role: "error", text: "provider disconnected", timestamp: 104 },
	] satisfies TranscriptMessage[]);
	assert.equal(result.nextMessageOffset, 5);
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

test("an offset beyond the current end stays unchanged until appends catch up", () => {
	const initial = line(message("user", "first"));
	const requestedOffset = 5;
	const beforeAppend = parseTranscript(initial, {
		messageOffset: requestedOffset,
		numMessages: 3,
	});
	assert.deepEqual(beforeAppend.messages, []);
	assert.equal(beforeAppend.nextMessageOffset, requestedOffset);

	const appended = `${initial}${Array.from({ length: 5 }, (_, index) =>
		line(message("user", `appended-${index}`)),
	).join("")}`;
	const afterAppend = parseTranscript(appended, {
		messageOffset: beforeAppend.nextMessageOffset,
		numMessages: 3,
	});
	assert.deepEqual(afterAppend.messages.map(({ role, text }) => ({ role, text })), [
		{ role: "user", text: "appended-4" },
	]);
	assert.equal(afterAppend.nextMessageOffset, 6);
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

test("an incomplete trailing record becomes visible when its LF arrives", () => {
	const prefix = line(message("user", "saved"));
	const trailing = JSON.stringify(message("assistant", [
		{ type: "text", text: "finished later" },
	]));
	const incomplete = parseTranscript(`${prefix}${trailing}`, {
		messageOffset: 1,
		numMessages: 3,
	});
	assert.equal(incomplete.status, "incomplete");
	assert.deepEqual(incomplete.messages, []);
	assert.equal(incomplete.nextMessageOffset, 1);

	const complete = parseTranscript(`${prefix}${trailing}\n`, {
		messageOffset: incomplete.nextMessageOffset,
		numMessages: 3,
	});
	assert.equal(complete.status, "available");
	assert.deepEqual(complete.messages, [
		{
			role: "assistant",
			text: "finished later",
			timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
		},
	]);
	assert.equal(complete.nextMessageOffset, 2);
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
	assert.ok(
		result.messages.every(
			(item) => Buffer.byteLength(item.text, "utf8") <= MAX_MESSAGE_BYTES,
		),
	);
	assert.ok(
		result.messages.reduce(
			(total, item) => total + Buffer.byteLength(item.text, "utf8"),
			0,
		) <= MAX_PAGE_BYTES,
	);
	assert.equal(result.nextMessageOffset, result.messages.length);
});

test("multibyte text uses hard UTF-8 budgets without splitting a surrogate pair", () => {
	const text = "prefix-😀".repeat(4_000);
	const result = parseTranscript(
		line(message("assistant", [{ type: "text", text }])),
		{ numMessages: 1 },
	);
	assert.equal(result.status, "available");
	assert.equal(result.messages.length, 1);
	const projected = result.messages[0];
	assert.ok(projected);
	assert.ok(Buffer.byteLength(projected.text, "utf8") <= MAX_MESSAGE_BYTES);
	assertWellFormedUtf16(projected.text);
	assert.match(projected.text, /transcript text truncated/);
});

test("an oversized complete record stays bounded and does not change filtered offsets", async () => {
	const fixture = await temporaryFile(
		JSON.stringify({ type: "custom", payload: "x".repeat(300_000) }) +
		"\n" +
		line(message("user", "after oversized input")),
	);
	try {
		const result = await readTranscript(fixture.path, { numMessages: 3 });
		assert.equal(result.status, "unreadable");
		assert.deepEqual(result.messages.map(({ role, text }) => ({ role, text })), [
			{ role: "user", text: "after oversized input" },
		]);
		assert.equal(result.nextMessageOffset, 1);
	} finally {
		await removeTemporary(fixture.directory);
	}
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
