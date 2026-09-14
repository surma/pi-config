import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	MAX_TRANSCRIPT_RECORD_BYTES,
	parseTranscript,
	readTranscript,
	type TranscriptFileHandle,
	type TranscriptMessage,
} from "./transcript.ts";

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
		messagesInWindow: 0,
		windowed: false,
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
	assert.equal(result.messagesInWindow, 5);
});

test("a tail read returns the most recent messages, oldest first", () => {
	const content = [
		line({ type: "session", id: "session" }),
		line(message("user", "one")),
		line(message("toolResult", [{ type: "text", text: "ignored" }])),
		line(message("assistant", [{ type: "text", text: "two" }])),
		line(message("user", "three")),
	].join("");
	const tail = parseTranscript(content, { numMessages: 2 });
	assert.deepEqual(tail.messages.map(({ role, text }) => ({ role, text })), [
		{ role: "assistant", text: "two" },
		{ role: "user", text: "three" },
	]);
	assert.equal(tail.messagesInWindow, 3);
});

test("the default returns only the last message", () => {
	const content = Array.from({ length: 5 }, (_, index) =>
		line(message("user", `message-${index}`)),
	).join("");
	const result = parseTranscript(content);
	assert.deepEqual(result.messages.map(({ text }) => text), ["message-4"]);
	assert.equal(result.messagesInWindow, 5);
});

test("a tail wider than the transcript returns every message", () => {
	const result = parseTranscript(line(message("user", "first")), { numMessages: 20 });
	assert.deepEqual(result.messages.map(({ text }) => text), ["first"]);
	assert.equal(result.messagesInWindow, 1);
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
	assert.equal(result.messagesInWindow, 1);
});

test("an incomplete trailing record becomes visible when its LF arrives", () => {
	const prefix = line(message("user", "saved"));
	const trailing = JSON.stringify(message("assistant", [
		{ type: "text", text: "finished later" },
	]));
	const incomplete = parseTranscript(`${prefix}${trailing}`, { numMessages: 3 });
	assert.equal(incomplete.status, "incomplete");
	assert.deepEqual(incomplete.messages.map(({ text }) => text), ["saved"]);
	assert.equal(incomplete.messagesInWindow, 1);

	const complete = parseTranscript(`${prefix}${trailing}\n`, { numMessages: 1 });
	assert.equal(complete.status, "available");
	assert.deepEqual(complete.messages, [
		{
			role: "assistant",
			text: "finished later",
			timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
		},
	]);
	assert.equal(complete.messagesInWindow, 2);
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
	assert.equal(result.messagesInWindow, 2);
});

test("a tail read returns long messages in full", () => {
	const huge = "x".repeat(100_000);
	const content = Array.from({ length: 25 }, (_, index) =>
		line(message("assistant", [{ type: "text", text: index === 24 ? huge : `message-${index}` }])),
	).join("");
	const result = parseTranscript(content, { numMessages: 2 });
	assert.equal(result.status, "available");
	assert.equal(result.messagesInWindow, 25);
	assert.deepEqual(result.messages.map(({ text }) => text), ["message-23", huge]);
});

test("multibyte text survives a tail read without splitting a surrogate pair", () => {
	const text = "prefix-\u{1F600}".repeat(4_000);
	const result = parseTranscript(
		line(message("assistant", [{ type: "text", text }])),
		{ numMessages: 1 },
	);
	assert.equal(result.status, "available");
	const projected = result.messages[0];
	assert.ok(projected);
	assert.equal(projected.text, text);
	assertWellFormedUtf16(projected.text);
});

test("an oversized complete record stays bounded and keeps later records readable", async () => {
	const fixture = await temporaryFile(
		JSON.stringify({
			type: "custom",
			payload: "x".repeat(MAX_TRANSCRIPT_RECORD_BYTES + 1_024),
		}) +
		"\n" +
		line(message("user", "after oversized input")),
	);
	try {
		const result = await readTranscript(fixture.path, { numMessages: 3 });
		assert.equal(result.status, "unreadable");
		assert.deepEqual(result.messages.map(({ role, text }) => ({ role, text })), [
			{ role: "user", text: "after oversized input" },
		]);
		assert.equal(result.messagesInWindow, 1);
	} finally {
		await removeTemporary(fixture.directory);
	}
});

test("an oversized unterminated record is unreadable", () => {
	const result = parseTranscript(
		JSON.stringify({
			type: "custom",
			payload: "x".repeat(MAX_TRANSCRIPT_RECORD_BYTES + 1_024),
		}),
		{ numMessages: 3 },
	);
	assert.equal(result.status, "unreadable");
	assert.deepEqual(result.messages, []);
});

test("the tail count normalizes out-of-range values", () => {
	const content = Array.from({ length: 5 }, (_, index) =>
		line(message("user", `message-${index}`)),
	).join("");
	assert.equal(parseTranscript(content).messages.length, 1);
	assert.equal(parseTranscript(content, { numMessages: -4 }).messages.length, 0);
	assert.equal(parseTranscript(content, { numMessages: 99 }).messages.length, 5);
	assert.equal(parseTranscript(content, { numMessages: 0 }).messagesInWindow, 5);
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

test("valid records above the old 256 KiB limit remain readable in full", () => {
	const text = "x".repeat(300_000);
	const result = parseTranscript(
		line(message("assistant", [{ type: "text", text }])),
		{ numMessages: 1 },
	);
	assert.equal(result.status, "available");
	assert.equal(result.messages.length, 1);
	assert.ok(result.messages[0]);
	assert.equal(result.messages[0].text, text);
});

test("transcript reads use the initial file size while the source grows", async () => {
	const initial = Buffer.from(line(message("user", "initial")), "utf8");
	const grown = Buffer.from(
		`${initial.toString("utf8")}${line(message("user", "appended later"))}`,
		"utf8",
	);
	let maximumReadEnd = 0;
	let closeCount = 0;
	const handle: TranscriptFileHandle = {
		stat: async () => ({ size: initial.length }),
		read: async (buffer, offset, length, position) => {
			maximumReadEnd = Math.max(maximumReadEnd, position + length);
			const chunk = grown.subarray(position, Math.min(position + length, initial.length));
			chunk.copy(buffer, offset);
			return { bytesRead: chunk.length };
		},
		close: async () => {
			closeCount++;
		},
	};
	const result = await readTranscript("growing.jsonl", {
		numMessages: 20,
		io: { open: async () => handle },
	});
	assert.equal(result.status, "available");
	assert.deepEqual(result.messages.map(({ text }) => text), ["initial"]);
	assert.ok(maximumReadEnd <= initial.length);
	assert.equal(closeCount, 1);
});

test("stuck transcript reads return unreadable within the operation deadline", async () => {
	const never = new Promise<never>(() => {});
	let closeCount = 0;
	const started = Date.now();
	const result = await readTranscript("stuck.jsonl", {
		timeoutMs: 25,
		io: {
			open: async () => ({
				stat: async () => ({ size: 1 }),
				read: async () => never,
				close: async () => {
					closeCount++;
				},
			}),
		},
	});
	assert.equal(result.status, "unreadable");
	assert.deepEqual(result.messages, []);
	assert.ok(Date.now() - started < 500);
	assert.equal(closeCount, 1);
});

test("transcript reads preserve AbortError cancellation", async () => {
	const controller = new AbortController();
	let closeCount = 0;
	const never = new Promise<never>(() => {});
	const result = readTranscript("canceled.jsonl", {
		timeoutMs: 500,
		signal: controller.signal,
		io: {
			open: async () => ({
				stat: async () => never,
				read: async () => never,
				close: async () => {
					closeCount++;
				},
			}),
		},
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	controller.abort(new Error("transcript canceled"));
	await assert.rejects(result, (error) => {
		assert.equal((error as Error).name, "AbortError");
		assert.match((error as Error).message, /transcript canceled/);
		return true;
	});
	assert.equal(closeCount, 1);
});

test("a window smaller than one record yields a windowed read, not a rejection", async () => {
	const fixture = await temporaryFile(line(message("user", "bounded")));
	try {
		const result = await readTranscript(fixture.path, { maxSnapshotBytes: 1 });
		assert.equal(result.status, "available");
		assert.deepEqual(result.messages, []);
		assert.equal(result.windowed, true);
	} finally {
		await removeTemporary(fixture.directory);
	}
});

test("a file far above the window bound stays readable from its end", async () => {
	const filler = Array.from({ length: 400 }, (_, index) =>
		line(message("assistant", [{ type: "text", text: `filler-${index}`.padEnd(600, "x") }])),
	).join("");
	const fixture = await temporaryFile(
		`${filler}${line(message("assistant", [{ type: "text", text: "the final answer" }]))}`,
	);
	try {
		const result = await readTranscript(fixture.path, {
			maxSnapshotBytes: 4096,
			numMessages: 1,
		});
		assert.equal(result.status, "available");
		assert.equal(result.windowed, true);
		assert.deepEqual(result.messages.map(({ text }) => text), ["the final answer"]);
		// The window holds only its own records, so the count is not the file total.
		assert.ok(result.messagesInWindow > 0);
		assert.ok(result.messagesInWindow < 401);
	} finally {
		await removeTemporary(fixture.directory);
	}
});

test("a partial leading record inside the window never becomes a message", async () => {
	const first = line(message("assistant", [{ type: "text", text: "x".repeat(2_000) }]));
	const second = line(message("assistant", [{ type: "text", text: "second" }]));
	const fixture = await temporaryFile(`${first}${second}`);
	try {
		const result = await readTranscript(fixture.path, {
			maxSnapshotBytes: second.length + 40,
			numMessages: 10,
		});
		assert.equal(result.status, "available");
		assert.deepEqual(result.messages.map(({ text }) => text), ["second"]);
	} finally {
		await removeTemporary(fixture.directory);
	}
});
