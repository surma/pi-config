import * as fs from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import {
	type Focusable,
	Key,
	type KeybindingsManager,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import type { SessionLifecycle } from "./lifecycle.js";

export interface InspectorToolActivity {
	toolCallId: string;
	name: string;
	startedAt: number;
	updatedAt: number;
	endedAt?: number;
	output: string;
	outputTruncated: boolean;
	progress?: number;
	isError?: boolean;
}

export interface InspectorHandle {
	id: string;
	name?: string;
	state: "starting" | "running" | "done" | "error" | "killed";
	lifecycle: SessionLifecycle;
	processState: "alive" | "stopped";
	runState: "idle" | "running" | "retrying" | "finishing";
	runId?: number;
	runOutcome: "pending" | "succeeded" | "failed" | "aborted";
	settlementStatus: "pending" | "settled" | "closed_without_settlement";
	rpcReady?: boolean;
	killing: boolean;
	task: string;
	cwd: string;
	pid?: number;
	exitCode?: number | null;
	exitSignal?: NodeJS.Signals | null;
	requestedModel: string;
	requestedThinking: string;
	actualModel: { provider: string; id: string; name?: string };
	actualThinking: string;
	sessionPath: string;
	promptPath: string;
	outputPath?: string;
	outputStatus: "not_requested" | "pending" | "written" | "collision" | "failed";
	transcriptStatus: "available" | "missing" | "incomplete" | "unreadable";
	createdAt: number;
	rpcReadyAt?: number;
	agentStartedAt?: number;
	lastActivityAt: number;
	completedAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	lastTool?: string;
	isStreaming: boolean;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		turns: number;
	};
	stopReason?: string;
	error?: string;
	tentativeError?: string;
	finalError?: string;
	settledAt?: number;
	stderrTail?: string;
	currentAssistantText?: string;
	latestAssistantText?: string;
	activeTools: InspectorToolActivity[];
	recentTools: InspectorToolActivity[];
}

export interface SubagentInspectorCallbacks {
	getHandles(): InspectorHandle[];
	steer(id: string): Promise<string>;
	kill(id: string): Promise<string>;
	clearFinished(): number;
	onClose(): void;
}

type InspectorView = "list" | "status" | "task" | "live";
type DetailView = Exclude<InspectorView, "list">;
type ThemeColor =
	| "text"
	| "accent"
	| "muted"
	| "dim"
	| "borderMuted"
	| "success"
	| "warning"
	| "error";
type InspectorTheme = {
	fg(color: ThemeColor, text: string): string;
	bg(color: "selectedBg", text: string): string;
	bold(text: string): string;
};
type InspectorFiles = Pick<typeof fs, "open" | "stat">;

const MAX_TRANSCRIPT_LINES = 400;
const MAX_TRANSCRIPT_CHARS = 256 * 1024;
const MAX_TRANSCRIPT_READ_BYTES = 512 * 1024;
const MAX_PROMPT_READ_BYTES = 64 * 1024;
const DEFAULT_FILE_OPERATION_TIMEOUT_MS = 5_000;

export interface SubagentInspectorOptions {
	fileOperationTimeoutMs?: number;
}

interface BoundedTextRead {
	text: string;
	truncated: boolean;
}

function abortError(): Error {
	const error = new Error("The inspector file operation was aborted.");
	error.name = "AbortError";
	return error;
}

function timeoutError(label: string): Error {
	const error = new Error(`Timed out during inspector file ${label}.`);
	error.name = "TimeoutError";
	return error;
}

function positiveTimeout(value: number | undefined): number {
	return Number.isFinite(value) && value !== undefined
		? Math.max(1, Math.floor(value))
		: DEFAULT_FILE_OPERATION_TIMEOUT_MS;
}

/** Race one file operation against cancellation and a deadline. */
function boundedFileOperation<T>(
	operation: () => PromiseLike<T>,
	signal: AbortSignal | undefined,
	timeoutMs: number,
	label: string,
	onLateResolve?: (value: T) => void,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			callback();
		};
		const onAbort = () => finish(() => reject(abortError()));
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		timer = setTimeout(
			() => finish(() => reject(timeoutError(label))),
			positiveTimeout(timeoutMs),
		);
		timer.unref?.();
		let pending: PromiseLike<T>;
		try {
			pending = operation();
		} catch (error) {
			finish(() => reject(error));
			return;
		}
		void Promise.resolve(pending).then(
			(value) => {
				if (settled) {
					try {
						onLateResolve?.(value);
					} catch {
						// A late cleanup callback cannot escape the inspector.
					}
					return;
				}
				finish(() => resolve(value));
			},
			(error) => {
				if (!settled) finish(() => reject(error));
			},
		);
	});
}

/** Read only a bounded prefix or tail of a file before parsing its contents. */
async function readBoundedText(
	files: InspectorFiles,
	path: string,
	maxBytes: number,
	fromEnd = false,
	signal?: AbortSignal,
	timeoutMs = DEFAULT_FILE_OPERATION_TIMEOUT_MS,
): Promise<BoundedTextRead> {
	let file: Awaited<ReturnType<typeof fs.open>> | undefined;
	const closeLateFile = (lateFile: Awaited<ReturnType<typeof fs.open>>) => {
		void boundedFileOperation(
			() => lateFile.close(),
			undefined,
			timeoutMs,
			"close",
		).catch(() => {});
	};
	try {
		file = await boundedFileOperation(
			() => files.open(path, "r"),
			signal,
			timeoutMs,
			"open",
			closeLateFile,
		);
		const stat = await boundedFileOperation(
			() => file!.stat(),
			signal,
			timeoutMs,
			"stat",
		);
		const size = Number(stat.size);
		if (!Number.isSafeInteger(size) || size < 0)
			throw new Error("File size is invalid.");
		const truncatedByStat = size > maxBytes;
		const start = fromEnd ? Math.max(0, size - maxBytes) : 0;
		const capacity = fromEnd && truncatedByStat ? maxBytes : maxBytes + 1;
		const buffer = Buffer.allocUnsafe(capacity);
		let bytesRead = 0;
		while (bytesRead < capacity) {
			const result = await boundedFileOperation(
				() =>
					file!.read(
						buffer,
						bytesRead,
						capacity - bytesRead,
						start + bytesRead,
					),
				signal,
				timeoutMs,
				"read",
			);
			if (result.bytesRead <= 0) break;
			bytesRead += result.bytesRead;
		}
		const truncated = truncatedByStat || bytesRead > maxBytes;
		const used = buffer.subarray(0, Math.min(bytesRead, maxBytes));
		return {
			text: new StringDecoder("utf8").end(used),
			truncated,
		};
	} finally {
		if (file) {
			const closeSignal = signal?.aborted ? undefined : signal;
			await boundedFileOperation(
				() => file!.close(),
				closeSignal,
				timeoutMs,
				"close",
			).catch(() => {});
		}
	}
}

/** Render untrusted text literally without allowing it to issue terminal controls. */
export function sanitizeTerminalText(value: unknown): string {
	const text = typeof value === "string" ? value : String(value ?? "");
	return text
		.replace(/\r\n?/gu, "\n")
		.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/gu, (character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return `\\u${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
		});
}

function elapsed(from: number, until = Date.now()): string {
	const seconds = Math.max(0, Math.floor((until - from) / 1000));
	const minutes = Math.floor(seconds / 60);
	return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function freshness(at: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.floor((now - at) / 1000));
	if (seconds < 1) return "<1s ago";
	if (seconds < 60) return `${seconds}s ago`;
	return `${Math.floor(seconds / 60)}m ago`;
}

function stateText(handle: InspectorHandle): string {
	return `[${handle.processState.toUpperCase()}/${handle.runState.toUpperCase()}]`;
}

function activityText(handle: InspectorHandle): string {
	if (handle.lifecycle === "killing") return "killing";
	if (handle.processState === "stopped") {
		if (handle.state === "killed") return "killed";
		if (handle.runOutcome === "failed") return "error";
		return "stopped";
	}
	if (handle.currentTool) return `tool: ${handle.currentTool}`;
	if (handle.isStreaming) return "responding";
	if (handle.runState === "retrying") return "retrying";
	if (handle.runState === "finishing") return "finishing";
	if (handle.lastTool && handle.runState !== "idle")
		return `tool: ${handle.lastTool}`;
	if (handle.runState === "idle" && handle.runOutcome === "aborted")
		return "aborted";
	if (handle.runState === "idle" && handle.runOutcome === "failed")
		return "error";
	if (handle.runState === "idle" && handle.runOutcome === "succeeded")
		return "final response";
	return "idle";
}

function stateColor(handle: InspectorHandle): ThemeColor {
	if (handle.processState === "stopped") {
		if (handle.state === "killed") return "warning";
		return handle.runOutcome === "failed" ? "error" : "success";
	}
	if (handle.runState === "idle") {
		if (handle.runOutcome === "failed") return "error";
		if (handle.runOutcome === "aborted") return "warning";
		if (handle.runOutcome === "succeeded") return "success";
	}
	if (handle.lifecycle === "retrying" || handle.lifecycle === "killing")
		return "warning";
	return "accent";
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const value = part as {
				type?: unknown;
				text?: unknown;
				thinking?: unknown;
				name?: unknown;
				arguments?: unknown;
			};
			if (value.type === "text" && typeof value.text === "string")
				return value.text;
			if (value.type === "thinking" && typeof value.thinking === "string")
				return `[thinking]\n${value.thinking}`;
			if (value.type === "toolCall")
				return `[tool] ${String(value.name || "unknown")} ${JSON.stringify(value.arguments || {})}`;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function boundTranscript(lines: string[]): string[] {
	const bounded: string[] = [];
	let remaining = MAX_TRANSCRIPT_CHARS;
	for (
		let index = lines.length - 1;
		index >= 0 && bounded.length < MAX_TRANSCRIPT_LINES && remaining > 0;
		index--
	) {
		const line = lines[index];
		if (line === undefined) continue;
		const value =
			line.length > remaining
				? `… [record truncated] …${line.slice(-remaining)}`
				: line;
		bounded.unshift(value);
		remaining -= value.length;
	}
	if (bounded.length < lines.length)
		bounded.unshift(
			`… ${lines.length - bounded.length} earlier transcript records omitted …`,
		);
	return bounded;
}

function transcriptLine(entry: unknown): string {
	if (!entry || typeof entry !== "object") return String(entry);
	const value = entry as {
		type?: unknown;
		message?: { role?: unknown; content?: unknown; toolName?: unknown };
		provider?: unknown;
		modelId?: unknown;
		thinkingLevel?: unknown;
		name?: unknown;
		summary?: unknown;
	};
	switch (value.type) {
		case "session":
			return "[session]";
		case "message": {
			const message = value.message;
			if (!message) return "[message]";
			const role = String(message.role || "message");
			const body = textFromContent(message.content);
			const tool =
				role === "toolResult" && message.toolName
					? ` ${String(message.toolName)}`
					: "";
			return `${role}${tool}: ${body || "(no text content)"}`;
		}
		case "model_change":
			return `[model] ${String(value.provider || "")}/${String(value.modelId || "")}`;
		case "thinking_level_change":
			return `[thinking] ${String(value.thinkingLevel || "")}`;
		case "compaction":
			return `[compaction] ${String(value.summary || "")}`;
		case "branch_summary":
			return `[branch summary] ${String(value.summary || "")}`;
		case "session_info":
			return `[session name] ${String(value.name || "")}`;
		default:
			return JSON.stringify(entry, null, 2);
	}
}

export class SubagentInspector implements Focusable {
	focused = false;

	private view: InspectorView = "list";
	private selectedId?: string;
	private readonly offsets: Record<InspectorView, number> = {
		list: 0,
		status: 0,
		task: 0,
		live: 0,
	};
	private viewHeight = 1;
	private totalLines = 0;
	private flash = "";
	private promptContent?: string[];
	private transcriptContent?: string[];
	private transcriptCache?: {
		path: string;
		size: number;
		mtimeMs: number;
		lines: string[];
	};
	private refreshTimer?: NodeJS.Timeout;
	private disposed = false;
	private requestGeneration = 0;
	private transcriptReadActive = false;
	private transcriptReadPending = false;
	private transcriptDelay?: NodeJS.Timeout;
	private readonly transcriptLastReadAt = new Map<string, number>();
	private readonly readControllers = new Set<AbortController>();
	private readonly fileOperationTimeoutMs: number;
	private followingLive = true;

	constructor(
		private readonly tui: TUI,
		private readonly theme: InspectorTheme,
		private readonly keybindings: KeybindingsManager,
		private readonly callbacks: SubagentInspectorCallbacks,
		private readonly files: InspectorFiles = fs,
		options: SubagentInspectorOptions = {},
	) {
		this.fileOperationTimeoutMs = positiveTimeout(options.fileOperationTimeoutMs);
		this.reconcileRefreshTimer();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.requestGeneration += 1;
		this.abortReads();
		if (this.refreshTimer) clearInterval(this.refreshTimer);
		this.refreshTimer = undefined;
		if (this.transcriptDelay) clearTimeout(this.transcriptDelay);
		this.transcriptDelay = undefined;
		this.transcriptReadPending = false;
	}

	handleInput(data: string): void {
		if (
			this.keybindings.matches(data, "app.interrupt") ||
			this.keybindings.matches(data, "tui.select.cancel") ||
			data === "q"
		) {
			if (this.view === "list") {
				try {
					this.callbacks.onClose();
				} catch (error) {
					this.reportRefreshError(error);
				}
			} else this.showList();
			return;
		}

		const wheelDelta = this.parseMouseScrollDelta(data);
		if (wheelDelta !== 0) {
			this.scrollBy(wheelDelta, wheelDelta < 0);
			return;
		}

		if (
			this.keybindings.matches(data, "tui.select.up") ||
			matchesKey(data, Key.up)
		) {
			if (this.view === "list") this.moveSelection(-1);
			else this.scrollBy(-1, true);
			return;
		}
		if (
			this.keybindings.matches(data, "tui.select.down") ||
			matchesKey(data, Key.down)
		) {
			if (this.view === "list") this.moveSelection(1);
			else this.scrollBy(1);
			return;
		}
		if (
			this.keybindings.matches(data, "tui.select.pageUp") ||
			matchesKey(data, Key.pageUp)
		) {
			this.scrollBy(-this.viewHeight, true);
			return;
		}
		if (
			this.keybindings.matches(data, "tui.select.pageDown") ||
			matchesKey(data, Key.pageDown)
		) {
			this.scrollBy(this.viewHeight);
			return;
		}
		if (matchesKey(data, Key.home)) {
			this.setScroll(0, true);
			return;
		}
		if (matchesKey(data, Key.end)) {
			this.resumeFollow();
			return;
		}
		if (
			this.keybindings.matches(data, "tui.select.confirm") ||
			matchesKey(data, Key.enter)
		) {
			if (this.view === "list") this.showDetail("status");
			return;
		}

		switch (data) {
			case "o":
				this.showDetail("status");
				return;
			case "p":
				this.showDetail("task");
				return;
			case "r":
				this.showDetail("live");
				return;
			case "f":
				if (this.view === "live") this.resumeFollow();
				return;
			case "s":
				this.runAction("steer", () =>
					this.callbacks.steer(this.selected()?.id || ""),
				);
				return;
			case "x":
				this.runAction("kill", () =>
					this.callbacks.kill(this.selected()?.id || ""),
				);
				return;
			case "c": {
				const count = this.callbacks.clearFinished();
				this.flash = `Cleared ${count} finished handle${count === 1 ? "" : "s"}; artifacts were kept.`;
				this.ensureSelection();
				this.requestRender();
				return;
			}
		}
	}

	render(width: number): string[] {
		this.ensureSelection();
		this.reconcileRefreshTimer();
		const innerWidth = Math.max(1, width - 2);
		const rows = this.tui.terminal.rows || 24;
		const panelHeight = Math.max(9, Math.min(rows, Math.floor(rows * 0.95)));
		const chromeLines = 7;
		const contentHeight = Math.max(1, panelHeight - chromeLines);
		const content = this.contentLines(innerWidth);
		this.totalLines = content.length;
		this.viewHeight = contentHeight;
		if (this.view === "list") this.ensureListSelectionVisible();
		if (this.view === "live" && this.followingLive)
			this.offsets.live = Math.max(0, content.length - contentHeight);
		const maxOffset = Math.max(0, content.length - contentHeight);
		this.offsets[this.view] = Math.max(
			0,
			Math.min(this.offsets[this.view], maxOffset),
		);
		const offset = this.offsets[this.view];
		const visible = content.slice(offset, offset + contentHeight);
		const padding = Math.max(0, contentHeight - visible.length);
		const start = content.length === 0 ? 0 : offset + 1;
		const end = Math.min(content.length, offset + visible.length);
		const scrollInfo =
			content.length > contentHeight
				? `${start}-${end}/${content.length}`
				: `${content.length}/${content.length}`;
		const title =
			this.view === "list"
				? " Subagents "
				: ` #${sanitizeTerminalText(this.selected()?.id || "")} · ${this.viewTitle()} `;

		const lines = [
			this.borderLine(innerWidth, "top"),
			this.frameLine(
				this.theme.fg("accent", this.theme.bold(title)),
				innerWidth,
			),
			this.frameLine(
				this.theme.fg("dim", sanitizeTerminalText(this.helpText(scrollInfo))),
				innerWidth,
			),
			this.theme.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`),
			...visible.map((line) => this.frameLine(line, innerWidth)),
		];
		for (let index = 0; index < padding; index++)
			lines.push(this.frameLine("", innerWidth));
		lines.push(this.theme.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`));
		lines.push(
			this.frameLine(
				this.theme.fg(
					"dim",
					sanitizeTerminalText(this.flash || this.footerText()),
				),
				innerWidth,
			),
		);
		lines.push(this.borderLine(innerWidth, "bottom"));
		return lines.map((line) => truncateToWidth(line, Math.max(1, width), ""));
	}

	invalidate(): void {}

	refresh(): void {
		if (this.disposed) return;
		try {
			this.ensureSelection();
			this.reconcileRefreshTimer();
			this.requestRender();
		} catch (error) {
			this.reportRefreshError(error);
		}
	}

	private contentLines(width: number): string[] {
		if (this.view === "list") return this.listLines(width);
		if (this.view === "status") return this.statusLines(width);
		if (this.view === "task") return this.taskLines(width);
		return this.liveLines(width);
	}

	private listLines(width: number): string[] {
		const handles = this.callbacks.getHandles();
		if (handles.length === 0)
			return [this.theme.fg("dim", "No subagents tracked yet.")];
		return handles.map((handle) => {
			const selected = handle.id === this.selectedId;
			const state = this.theme.fg(stateColor(handle), stateText(handle));
			const id = this.theme.fg("accent", sanitizeTerminalText(`#${handle.id}`));
			const activity = this.theme.fg(
				"text",
				sanitizeTerminalText(activityText(handle)),
			);
			const time = this.theme.fg(
				"dim",
				elapsed(handle.createdAt, handle.completedAt ?? handle.settledAt),
			);
			let row: string;
			if (width < 52) {
				row = `${state} ${id} ${activity} ${time}`;
			} else {
				const label = sanitizeTerminalText(handle.name || "(unnamed)");
				row = `${state} ${id} ${this.theme.fg("text", label)}  ${activity}  ${time}`;
				if (width >= 80) {
					row += this.theme.fg(
						"dim",
						`  ${sanitizeTerminalText(`${handle.actualModel.provider}/${handle.actualModel.id} · thinking:${handle.actualThinking}`)}`,
					);
				}
			}
			const prefix = selected ? this.theme.fg("accent", "› ") : "  ";
			const rendered = truncateToWidth(`${prefix}${row}`, width, "…");
			if (!selected) return rendered;
			const padded = `${rendered}${" ".repeat(Math.max(0, width - visibleWidth(rendered)))}`;
			return this.theme.bg("selectedBg", padded);
		});
	}

	private statusLines(width: number): string[] {
		const handle = this.selected();
		if (!handle)
			return [this.theme.fg("warning", "Selected handle no longer exists.")];
		const lines: string[] = [];
		this.pushHeading(lines, "IDENTITY", width);
		this.pushField(lines, "Name", handle.name || "(none)", width);
		this.pushField(lines, "ID", handle.id, width);
		this.pushField(
			lines,
			"Model",
			`${handle.actualModel.provider}/${handle.actualModel.id} · thinking:${handle.actualThinking}`,
			width,
		);
		if (width >= 80)
			this.pushField(
				lines,
				"Requested",
				`${handle.requestedModel} · thinking:${handle.requestedThinking}`,
				width,
			);

		this.pushHeading(lines, "LIFECYCLE", width, true);
		this.pushField(
			lines,
			"State",
			`${stateText(handle)} ${activityText(handle)}${handle.rpcReady === false ? " · RPC unavailable" : ""}`,
			width,
			stateColor(handle),
		);
		this.pushField(lines, "Run", String(handle.runId ?? 0), width);
		this.pushField(
			lines,
			"RPC",
			handle.rpcReady === false ? "not ready" : "ready",
			width,
		);
		this.pushField(
			lines,
			"Elapsed",
			elapsed(handle.createdAt, handle.completedAt),
			width,
		);
		this.pushField(
			lines,
			"Last update",
			freshness(handle.lastActivityAt),
			width,
		);
		if (width >= 52)
			this.pushField(
				lines,
				"Started",
				new Date(handle.createdAt).toISOString(),
				width,
			);
		if (handle.tentativeError)
			this.pushField(
				lines,
				"Retry diagnostic",
				handle.tentativeError,
				width,
				"warning",
			);

		this.pushHeading(lines, "EXECUTION", width, true);
		this.pushField(
			lines,
			"Current tool",
			handle.currentTool || "(none)",
			width,
		);
		this.pushField(lines, "Last tool", handle.lastTool || "(none)", width);
		this.pushField(
			lines,
			"Process",
			`${handle.processState} · PID ${handle.pid ?? "-"} · exit ${handle.exitCode ?? "-"}${handle.exitSignal ? ` · signal ${handle.exitSignal}` : ""}`,
			width,
		);
		this.pushField(
			lines,
			"Usage",
			`${handle.usage.turns} turns · ↑${handle.usage.input} ↓${handle.usage.output} · cache R${handle.usage.cacheRead} W${handle.usage.cacheWrite} · $${handle.usage.cost.toFixed(4)}`,
			width,
		);
		this.pushHeading(lines, "OUTCOME", width, true);
		this.pushField(lines, "Settlement", handle.settlementStatus, width);
		this.pushField(lines, "Run outcome", handle.runOutcome || "pending", width);
		this.pushField(lines, "Stop reason", handle.stopReason || "(none)", width);
		if (handle.finalError || handle.error)
			this.pushField(
				lines,
				"Error",
				handle.finalError || handle.error || "",
				width,
				"error",
			);
		if (handle.stderrTail)
			this.pushField(lines, "Stderr tail", handle.stderrTail, width, "warning");

		this.pushHeading(lines, "ARTIFACTS", width, true);
		this.pushField(lines, "Session", handle.sessionPath, width);
		this.pushField(lines, "Transcript", handle.transcriptStatus, width);
		this.pushField(lines, "Prompt", handle.promptPath, width);
		this.pushField(lines, "Output", handle.outputPath || "(not requested)", width);
		this.pushField(lines, "Output status", handle.outputStatus, width);
		if (width >= 80) this.pushField(lines, "Cwd", handle.cwd, width);
		return lines;
	}

	private taskLines(width: number): string[] {
		const handle = this.selected();
		if (!handle)
			return [this.theme.fg("warning", "Selected handle no longer exists.")];
		const lines: string[] = [];
		this.pushHeading(lines, "ORIGINAL DELEGATED TASK", width);
		lines.push(...this.wrapRaw(handle.task, width, "text"));
		lines.push("");
		lines.push(this.theme.fg("borderMuted", "─".repeat(width)));
		lines.push("");
		this.pushHeading(
			lines,
			"CAPTURED PI EFFECTIVE SYSTEM PROMPT (read-only)",
			width,
		);
		const body = this.promptContent || ["Loading captured prompt…"];
		for (const row of body) lines.push(...this.wrapRaw(row, width, "muted"));
		return lines;
	}

	private liveLines(width: number): string[] {
		const handle = this.selected();
		if (!handle)
			return [this.theme.fg("warning", "Selected handle no longer exists.")];
		const lines: string[] = [];
		const strip = `${stateText(handle)} ${activityText(handle).toUpperCase()} · updated ${freshness(handle.lastActivityAt)}`;
		lines.push(...this.wrapRaw(strip, width, stateColor(handle), true));
		lines.push("");
		this.pushHeading(lines, "CURRENT RESPONSE", width);
		const response = handle.isStreaming
			? handle.currentAssistantText
			: handle.currentAssistantText || handle.latestAssistantText;
		if (response) {
			for (const row of response.split("\n"))
				lines.push(...this.wrapRaw(row, width, "text"));
		} else {
			const none =
				handle.state === "killed"
					? "No assistant text was captured before the child was killed."
					: handle.state === "error"
						? "No assistant text was captured before the error."
						: "Waiting for assistant text…";
			lines.push(...this.wrapRaw(none, width, "dim"));
		}
		lines.push("");
		this.pushHeading(lines, "RECENT ACTIVITY / TRANSCRIPT", width);
		for (const tool of handle.activeTools)
			this.pushTool(lines, tool, width, true);
		for (const tool of handle.recentTools.slice(-4))
			this.pushTool(lines, tool, width, false);
		const body = this.transcriptContent || [
			`Transcript: ${handle.transcriptStatus}`,
			"Loading persisted transcript history…",
		];
		if (handle.activeTools.length > 0 || handle.recentTools.length > 0)
			lines.push("");
		for (const row of body) lines.push(...this.wrapRaw(row, width, "muted"));
		return lines;
	}

	private pushTool(
		lines: string[],
		tool: InspectorToolActivity,
		width: number,
		active: boolean,
	): void {
		const duration = elapsed(tool.startedAt, tool.endedAt);
		const progress =
			typeof tool.progress === "number" ? ` · ${tool.progress}%` : "";
		const status = active ? "running" : tool.isError ? "error" : "done";
		lines.push(
			...this.wrapRaw(
				`[tool] ${tool.name} · ${status} · ${duration}${progress}`,
				width,
				tool.isError ? "error" : active ? "warning" : "dim",
			),
		);
		if (tool.output) {
			for (const row of tool.output.split("\n"))
				lines.push(...this.wrapRaw(`  ${row}`, width, "dim"));
		}
	}

	private pushHeading(
		lines: string[],
		heading: string,
		width: number,
		gap = false,
	): void {
		if (gap) lines.push("");
		lines.push(...this.wrapRaw(heading, width, "accent", true));
	}

	private pushField(
		lines: string[],
		label: string,
		value: unknown,
		width: number,
		color: ThemeColor = "text",
	): void {
		const safeLabel = sanitizeTerminalText(label);
		const safeValue = sanitizeTerminalText(value);
		if (width < 52) {
			lines.push(
				this.theme.fg("muted", this.theme.bold(safeLabel.toUpperCase())),
			);
			for (const row of safeValue.split("\n"))
				lines.push(...this.wrapRaw(row, width, color));
			return;
		}
		const prefix = `${safeLabel}: `;
		const available = Math.max(1, width - visibleWidth(prefix));
		const wrapped = safeValue
			.split("\n")
			.flatMap((row) => wrapTextWithAnsi(row, available));
		if (wrapped.length === 0) wrapped.push("");
		lines.push(
			this.theme.fg("muted", prefix) + this.theme.fg(color, wrapped[0] ?? ""),
		);
		const indent = " ".repeat(visibleWidth(prefix));
		for (const row of wrapped.slice(1))
			lines.push(`${indent}${this.theme.fg(color, row)}`);
	}

	private wrapRaw(
		value: unknown,
		width: number,
		color: ThemeColor,
		bold = false,
	): string[] {
		const safe = sanitizeTerminalText(value);
		const wrapped = wrapTextWithAnsi(safe, Math.max(1, width));
		return wrapped.map((row) =>
			this.theme.fg(color, bold ? this.theme.bold(row) : row),
		);
	}

	private helpText(scrollInfo: string): string {
		if (this.view === "list")
			return `Enter status · ↑↓ select · r live · s steer · x kill · c clear · Esc close · ${scrollInfo}`;
		return `o status · p task · r live · f follow · ↑↓ scroll · End latest · s steer · x kill · Esc back · ${scrollInfo}`;
	}

	private footerText(): string {
		if (this.view === "live")
			return this.followingLive
				? "FOLLOWING LIVE OUTPUT · ↑ pauses"
				: "PAUSED — End/f resumes latest";
		if (this.view === "list")
			return "Selection stays attached to the subagent ID while lifecycle records refresh.";
		if (this.view === "task")
			return "Original task and captured effective system prompt are read-only.";
		return "Status metadata intentionally excludes task and assistant response bodies.";
	}

	private viewTitle(): string {
		if (this.view === "status") return "Status";
		if (this.view === "task") return "Original task";
		return "Live output";
	}

	private selected(): InspectorHandle | undefined {
		return this.callbacks
			.getHandles()
			.find((handle) => handle.id === this.selectedId);
	}

	private ensureSelection(): void {
		const handles = this.callbacks.getHandles();
		if (handles.some((handle) => handle.id === this.selectedId)) return;
		const previous = this.selectedId;
		this.selectedId = handles[0]?.id;
		if (previous !== this.selectedId) {
			this.offsets.status = 0;
			this.offsets.task = 0;
			this.offsets.live = 0;
			this.invalidateReads();
		}
		if (!this.selectedId && this.view !== "list") this.view = "list";
	}

	private moveSelection(delta: number): void {
		const handles = this.callbacks.getHandles();
		if (handles.length === 0) return;
		const current = Math.max(
			0,
			handles.findIndex((handle) => handle.id === this.selectedId),
		);
		const next = Math.max(0, Math.min(handles.length - 1, current + delta));
		const nextId = handles[next]?.id;
		if (nextId === this.selectedId) return;
		this.selectedId = nextId;
		this.offsets.status = 0;
		this.offsets.task = 0;
		this.offsets.live = 0;
		this.invalidateReads();
		this.ensureListSelectionVisible();
		this.flash = "";
		this.requestRender();
	}

	private ensureListSelectionVisible(): void {
		const selectedIndex = this.callbacks
			.getHandles()
			.findIndex((handle) => handle.id === this.selectedId);
		if (selectedIndex < 0) return;
		if (selectedIndex < this.offsets.list) this.offsets.list = selectedIndex;
		else if (selectedIndex >= this.offsets.list + this.viewHeight)
			this.offsets.list = selectedIndex - this.viewHeight + 1;
	}

	private showList(): void {
		this.view = "list";
		this.flash = "";
		this.invalidateReads();
		this.requestRender();
	}

	private showDetail(view: DetailView): void {
		const handle = this.selected();
		if (!handle) return;
		this.view = view;
		this.flash = "";
		this.invalidateReads();
		if (view === "task")
			void this.loadPrompt(handle.promptPath, this.requestGeneration);
		if (view === "live") {
			this.followingLive = true;
			void this.refreshTranscript(handle, this.requestGeneration);
		}
		this.requestRender();
	}

	private invalidateReads(): void {
		this.requestGeneration += 1;
		this.abortReads();
		this.promptContent = undefined;
		this.transcriptContent = undefined;
		this.transcriptReadPending = false;
	}

	private beginRead(): AbortController {
		const controller = new AbortController();
		this.readControllers.add(controller);
		return controller;
	}

	private finishRead(controller: AbortController): void {
		this.readControllers.delete(controller);
	}

	private abortReads(): void {
		for (const controller of this.readControllers) controller.abort();
		this.readControllers.clear();
	}

	private reportRefreshError(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.flash = `Inspector refresh failed: ${message.slice(0, 512)}`;
	}

	private async loadPrompt(path: string, generation: number): Promise<void> {
		const controller = this.beginRead();
		let content: string[] | undefined;
		try {
			const snapshot = await readBoundedText(
				this.files,
				path,
				MAX_PROMPT_READ_BYTES,
				false,
				controller.signal,
				this.fileOperationTimeoutMs,
			);
			content = snapshot.text.split("\n");
			if (snapshot.truncated)
				content.push(
					`… prompt truncated after ${MAX_PROMPT_READ_BYTES} bytes …`,
				);
		} catch (error) {
			content = [
				`No captured Pi effective system prompt yet (${error instanceof Error ? error.message : String(error)}).`,
			];
		} finally {
			this.finishRead(controller);
		}
		try {
			if (
				!content ||
				this.disposed ||
				generation !== this.requestGeneration ||
				this.view !== "task" ||
				this.selected()?.promptPath !== path
			)
				return;
			this.promptContent = content;
			this.requestRender();
		} catch (error) {
			this.reportRefreshError(error);
		}
	}

	private async refreshTranscript(
		handle: InspectorHandle,
		generation: number,
	): Promise<void> {
		let controller: AbortController | undefined;
		let started = false;
		let path: string | undefined;
		let content: string[] | undefined;
		try {
			if (
				this.disposed ||
				generation !== this.requestGeneration ||
				this.view !== "live"
			)
				return;
			path = handle.sessionPath;
			const sinceLastRead =
				Date.now() - (this.transcriptLastReadAt.get(path) ?? 0);
			if (sinceLastRead < 1_000) {
				if (!this.transcriptDelay) {
					this.transcriptDelay = setTimeout(() => {
						this.transcriptDelay = undefined;
						try {
							const selected =
								this.view === "live" ? this.selected() : undefined;
							if (selected)
								void this.refreshTranscript(
									selected,
									this.requestGeneration,
								);
						} catch (error) {
							this.reportRefreshError(error);
						}
					}, 1_000 - sinceLastRead);
				}
				return;
			}
			if (this.transcriptReadActive) {
				this.transcriptReadPending = true;
				return;
			}
			this.transcriptReadActive = true;
			started = true;
			this.transcriptLastReadAt.set(path, Date.now());
			controller = this.beginRead();
			try {
				const stat = await boundedFileOperation(
					() => this.files.stat(path!),
					controller.signal,
					this.fileOperationTimeoutMs,
					"stat",
				);
				if (
					this.transcriptCache?.path === path &&
					this.transcriptCache.size === stat.size &&
					this.transcriptCache.mtimeMs === stat.mtimeMs
				) {
					content = this.transcriptCache.lines;
				} else {
					const snapshot = await readBoundedText(
						this.files,
						path,
						MAX_TRANSCRIPT_READ_BYTES,
						true,
						controller.signal,
						this.fileOperationTimeoutMs,
					);
					let raw = snapshot.text;
					const lines: string[] = [];
					if (snapshot.truncated) {
						const boundary = raw.indexOf("\n");
						if (boundary < 0) {
							lines.push(
								"[bounded transcript tail contains no complete JSONL record]",
							);
							raw = "";
						} else {
							// The first tail fragment can start inside an older JSONL record.
							raw = raw.slice(boundary + 1);
						}
					}
					const records = raw.split("\n");
					const partial = records.pop();
					for (const record of records) {
						if (!record) continue;
						try {
							lines.push(transcriptLine(JSON.parse(record)));
						} catch (error) {
							lines.push(
								`[malformed JSONL record] ${error instanceof Error ? error.message : String(error)}: ${record}`,
							);
						}
					}
					if (partial)
						lines.push(`[partial JSONL record while Pi writes] ${partial}`);
					const bounded = boundTranscript(lines);
					if (snapshot.truncated)
						bounded.unshift(
							`… earlier transcript records omitted (inspector read the last ${MAX_TRANSCRIPT_READ_BYTES} bytes) …`,
						);
					content =
						bounded.length > 0 ? bounded : ["No persisted transcript yet."];
					this.transcriptCache = {
						path,
						size: stat.size,
						mtimeMs: stat.mtimeMs,
						lines: content,
					};
				}
			} catch (error) {
				content = [
					`No persisted transcript yet (${error instanceof Error ? error.message : String(error)}).`,
				];
			}
		} catch (error) {
			this.reportRefreshError(error);
			if (started && path && !content)
				content = [
					`No persisted transcript yet (${error instanceof Error ? error.message : String(error)}).`,
				];
		} finally {
			if (!started) return;
			if (controller) this.finishRead(controller);
			this.transcriptReadActive = false;
			try {
				if (
					content &&
					path &&
					!this.disposed &&
					generation === this.requestGeneration &&
					this.view === "live" &&
					this.selected()?.sessionPath === path
				) {
					this.transcriptContent = content;
					this.requestRender();
				}
				if (this.transcriptReadPending && !this.disposed) {
					this.transcriptReadPending = false;
					const selected =
						this.view === "live" ? this.selected() : undefined;
					if (selected)
						void this.refreshTranscript(
							selected,
							this.requestGeneration,
						);
				}
			} catch (error) {
				this.reportRefreshError(error);
			}
		}
	}

	private reconcileRefreshTimer(): void {
		if (this.disposed) return;
		const active = this.callbacks.getHandles().some(
			(handle) =>
				handle.processState === "alive" &&
				(handle.state === "starting" || handle.runState !== "idle"),
		);
		if (active && !this.refreshTimer) {
			this.refreshTimer = setInterval(() => {
				try {
					if (this.disposed) return;
					const selected =
						this.view === "live" ? this.selected() : undefined;
					if (selected)
						void this.refreshTranscript(
							selected,
							this.requestGeneration,
						);
					this.requestRender();
				} catch (error) {
					this.reportRefreshError(error);
				}
			}, 1000);
		} else if (!active && this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = undefined;
		}
	}

	private runAction(name: string, action: () => Promise<string>): void {
		if (!this.selected()) return;
		void action()
			.then((message) => {
				if (this.disposed) return;
				this.flash = message;
				this.requestRender();
			})
			.catch((error) => {
				if (this.disposed) return;
				this.flash = `${name} failed: ${error instanceof Error ? error.message : String(error)}`;
				this.requestRender();
			});
	}

	private scrollBy(delta: number, pauseFollow = false): void {
		this.setScroll(this.offsets[this.view] + delta, pauseFollow);
	}

	private setScroll(next: number, pauseFollow = false): void {
		if (this.view === "live" && pauseFollow) this.followingLive = false;
		const max = Math.max(0, this.totalLines - this.viewHeight);
		const clamped = Math.max(0, Math.min(next, max));
		if (this.view === "live" && !pauseFollow && clamped >= max)
			this.followingLive = true;
		if (clamped === this.offsets[this.view]) {
			this.requestRender();
			return;
		}
		this.offsets[this.view] = clamped;
		this.requestRender();
	}

	private resumeFollow(): void {
		if (this.view === "live") this.followingLive = true;
		this.offsets[this.view] = Math.max(0, this.totalLines - this.viewHeight);
		this.requestRender();
	}

	private frameLine(content: string, innerWidth: number): string {
		const truncated = truncateToWidth(content, innerWidth, "");
		return `${this.theme.fg("borderMuted", "│")}${truncated}${" ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)))}${this.theme.fg("borderMuted", "│")}`;
	}

	private borderLine(innerWidth: number, edge: "top" | "bottom"): string {
		return this.theme.fg(
			"borderMuted",
			`${edge === "top" ? "┌" : "└"}${"─".repeat(innerWidth)}${edge === "top" ? "┐" : "┘"}`,
		);
	}

	private requestRender(): void {
		if (this.disposed) return;
		try {
			this.tui.requestRender();
		} catch (error) {
			this.reportRefreshError(error);
		}
	}

	private parseMouseScrollDelta(data: string): number {
		const sgr = /^\x1b\[<(\d+);\d+;\d+([Mm])$/u.exec(data);
		if (sgr) return this.wheelDelta(Number(sgr[1]));
		if (data.startsWith("\x1b[M") && data.length >= 6)
			return this.wheelDelta(data.charCodeAt(3) - 32);
		return 0;
	}

	private wheelDelta(code: number): number {
		if (!Number.isFinite(code) || (code & 64) === 0) return 0;
		if ((code & 3) === 0) return -3;
		if ((code & 3) === 1) return 3;
		return 0;
	}
}
