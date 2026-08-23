import { promises as fs } from "node:fs";

/** The health of the child session snapshot. */
export type TranscriptStatus =
	| "available"
	| "missing"
	| "incomplete"
	| "unreadable";

/** The normalized records that a transcript page can expose. */
export type TranscriptMessageRole = "user" | "assistant" | "error";

export interface TranscriptMessage {
	role: TranscriptMessageRole;
	text: string;
	timestamp?: number;
}

export interface TranscriptOptions {
	/** Zero-based index in the filtered transcript message sequence. */
	messageOffset?: number;
	/** Number of messages to return. The default is three and the maximum is twenty. */
	numMessages?: number;
}

export interface TranscriptResult {
	status: TranscriptStatus;
	messages: TranscriptMessage[];
	nextMessageOffset: number;
}

const DEFAULT_MESSAGE_COUNT = 3;
const MAX_MESSAGE_COUNT = 20;
const MAX_MESSAGE_TEXT = 8 * 1024;
const MAX_TOTAL_TEXT = 32 * 1024;
const TRUNCATION_MARKER = "\n… [transcript text truncated] …\n";
const ERROR_FALLBACK = "Assistant response failed";

type TranscriptOptionsInput = TranscriptOptions | number | undefined;
type SessionRecord = Record<string, unknown>;

function isRecord(value: unknown): value is SessionRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeOffset(value: unknown): number {
	if (typeof value !== "number" || Number.isNaN(value)) return 0;
	if (value === Number.POSITIVE_INFINITY) return Number.MAX_SAFE_INTEGER;
	if (value === Number.NEGATIVE_INFINITY) return 0;
	return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)));
}

function normalizeCount(value: unknown): number {
	if (value === undefined || (typeof value === "number" && Number.isNaN(value)))
		return DEFAULT_MESSAGE_COUNT;
	if (typeof value !== "number") return DEFAULT_MESSAGE_COUNT;
	if (value === Number.POSITIVE_INFINITY) return MAX_MESSAGE_COUNT;
	if (value === Number.NEGATIVE_INFINITY) return 0;
	return Math.min(MAX_MESSAGE_COUNT, Math.max(0, Math.floor(value)));
}

function normalizeOptions(
	optionsOrOffset: TranscriptOptionsInput,
	numMessages: number | undefined,
): { messageOffset: number; numMessages: number } {
	if (typeof optionsOrOffset === "number") {
		return {
			messageOffset: normalizeOffset(optionsOrOffset),
			numMessages: normalizeCount(numMessages),
		};
	}
	return {
		messageOffset: normalizeOffset(optionsOrOffset?.messageOffset),
		numMessages: normalizeCount(optionsOrOffset?.numMessages),
	};
}

function timestampFor(
	entry: SessionRecord,
	message: SessionRecord,
): number | undefined {
	const messageTimestamp = finiteNumber(message.timestamp);
	if (messageTimestamp !== undefined) return messageTimestamp;
	const entryTimestamp = finiteNumber(entry.timestamp);
	if (entryTimestamp !== undefined) return entryTimestamp;
	if (typeof entry.timestamp === "string") {
		const parsed = Date.parse(entry.timestamp);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is SessionRecord =>
				isRecord(part) && part.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text as string)
		.join("\n");
}

function boundedText(text: string, max: number): string {
	if (text.length <= max) return text;
	if (max <= TRUNCATION_MARKER.length) return text.slice(0, max);
	const remaining = max - TRUNCATION_MARKER.length;
	const prefixLength = Math.ceil(remaining / 2);
	const suffixLength = remaining - prefixLength;
	return `${text.slice(0, prefixLength)}${TRUNCATION_MARKER}${
		suffixLength > 0 ? text.slice(-suffixLength) : ""
	}`;
}

function withTimestamp(
	role: TranscriptMessageRole,
	text: string,
	timestamp: number | undefined,
): TranscriptMessage {
	return timestamp === undefined ? { role, text } : { role, text, timestamp };
}

function messageFromEntry(
	entry: SessionRecord,
): { message?: TranscriptMessage; malformed: boolean } {
	if (entry.type !== "message") return { malformed: false };
	const rawMessage = entry.message;
	if (!isRecord(rawMessage) || typeof rawMessage.role !== "string")
		return { malformed: true };

	const timestamp = timestampFor(entry, rawMessage);
	if (rawMessage.role === "user") {
		const text = textFromContent(rawMessage.content);
		return text
			? { message: withTimestamp("user", text, timestamp), malformed: false }
			: { malformed: false };
	}

	if (rawMessage.role !== "assistant") return { malformed: false };
	const text = textFromContent(rawMessage.content);
	const errorMessage =
		typeof rawMessage.errorMessage === "string"
			? rawMessage.errorMessage
			: undefined;
	if (rawMessage.stopReason === "error" || errorMessage !== undefined) {
		return {
			message: withTimestamp(
				"error",
				(errorMessage || text || ERROR_FALLBACK),
				timestamp,
			),
			malformed: false,
		};
	}
	return text
		? { message: withTimestamp("assistant", text, timestamp), malformed: false }
		: { malformed: false };
}

function page(
	candidates: TranscriptMessage[],
	status: TranscriptStatus,
	options: { messageOffset: number; numMessages: number },
): TranscriptResult {
	const start = Math.min(options.messageOffset, candidates.length);
	const messages: TranscriptMessage[] = [];
	let totalText = 0;
	let nextMessageOffset = start;
	while (
		nextMessageOffset < candidates.length &&
		messages.length < options.numMessages &&
		totalText < MAX_TOTAL_TEXT
	) {
		const candidate = candidates[nextMessageOffset];
		if (!candidate) break;
		const remaining = MAX_TOTAL_TEXT - totalText;
		const text = boundedText(
			candidate.text,
			Math.min(MAX_MESSAGE_TEXT, remaining),
		);
		if (!text) break;
		messages.push({
			...candidate,
			text,
		});
		totalText += text.length;
		nextMessageOffset++;
	}
	return { status, messages, nextMessageOffset };
}

function emptyResult(
	status: TranscriptStatus,
	options: { messageOffset: number; numMessages: number },
): TranscriptResult {
	return {
		status,
		messages: [],
		nextMessageOffset: options.messageOffset,
	};
}

/**
 * Parse one LF-framed child session snapshot without accepting its final fragment.
 * The offset indexes only emitted user, assistant, and error messages.
 */
export function parseTranscript(
	content: string,
	optionsOrOffset?: TranscriptOptionsInput,
	numMessages?: number,
): TranscriptResult {
	const options = normalizeOptions(optionsOrOffset, numMessages);
	const lines = content.split("\n");
	const trailing = lines.pop() || "";
	const candidates: TranscriptMessage[] = [];
	let malformed = false;

	for (const line of lines) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			malformed = true;
			continue;
		}
		if (!isRecord(parsed) || typeof parsed.type !== "string") {
			malformed = true;
			continue;
		}
		const projected = messageFromEntry(parsed);
		if (projected.malformed) {
			malformed = true;
			continue;
		}
		if (projected.message) candidates.push(projected.message);
	}

	const status: TranscriptStatus = malformed
		? "unreadable"
		: trailing.length > 0
			? "incomplete"
			: "available";
	return page(candidates, status, options);
}

/** Read and parse one child session snapshot. */
export async function readTranscript(
	sessionPath: string | undefined,
	optionsOrOffset?: TranscriptOptionsInput,
	numMessages?: number,
): Promise<TranscriptResult> {
	const options = normalizeOptions(optionsOrOffset, numMessages);
	if (typeof sessionPath !== "string" || sessionPath.length === 0)
		return emptyResult("missing", options);
	let content: string;
	try {
		content = await fs.readFile(sessionPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return emptyResult("missing", options);
		return emptyResult("unreadable", options);
	}
	return parseTranscript(content, options);
}

/** Child-specific aliases keep callers explicit while sharing the same API. */
export const parseChildTranscript = parseTranscript;
export const readChildTranscript = readTranscript;
