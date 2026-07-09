import * as fs from "node:fs/promises";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Focusable, type KeybindingsManager, type TUI } from "@mariozechner/pi-tui";

export interface InspectorHandle {
	id: string;
	name: string;
	agent: string;
	source: string;
	sourcePath: string;
	state: "starting" | "running" | "done" | "error" | "killed";
	killing: boolean;
	task: string;
	cwd: string;
	pid?: number;
	exitCode?: number;
	requestedModel: string;
	requestedThinking: string;
	actualModel: { provider: string; id: string; name?: string };
	actualThinking: string;
	configuredTools: string[];
	sessionPath: string;
	promptPath: string;
	resultPath?: string;
	resultKind: "none" | "final" | "partial";
	transcriptNote: string;
	createdAt: number;
	rpcReadyAt?: number;
	agentStartedAt?: number;
	lastActivityAt: number;
	completedAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	lastTool?: string;
	isStreaming: boolean;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number };
	stopReason?: string;
	error?: string;
	stderrPreview?: string;
	resultPreview?: string;
}

export interface SubagentInspectorCallbacks {
	getHandles(): InspectorHandle[];
	steer(id: string): Promise<string>;
	kill(id: string): Promise<string>;
	clearFinished(): number;
	onClose(): void;
}

type InspectorView = "list" | "overview" | "prompt" | "transcript";

/** Render untrusted text literally without allowing it to issue terminal controls. */
export function sanitizeTerminalText(value: unknown): string {
	const text = typeof value === "string" ? value : String(value ?? "");
	return text
		.replace(/\r\n?/gu, "\n")
		.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/gu, (character) => {
			const codePoint = character.codePointAt(0)!;
			return `\\u${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
		});
}

function elapsed(from: number, until = Date.now()): string {
	const seconds = Math.max(0, Math.floor((until - from) / 1000));
	const minutes = Math.floor(seconds / 60);
	return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const value = part as { type?: unknown; text?: unknown; thinking?: unknown; name?: unknown; arguments?: unknown };
			if (value.type === "text" && typeof value.text === "string") return value.text;
			if (value.type === "thinking" && typeof value.thinking === "string") return `[thinking]\n${value.thinking}`;
			if (value.type === "toolCall") return `[tool] ${String(value.name || "unknown")} ${JSON.stringify(value.arguments || {})}`;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function transcriptLine(entry: unknown): string {
	if (!entry || typeof entry !== "object") return String(entry);
	const value = entry as { type?: unknown; message?: { role?: unknown; content?: unknown; toolName?: unknown }; provider?: unknown; modelId?: unknown; thinkingLevel?: unknown; name?: unknown; summary?: unknown };
	switch (value.type) {
		case "session":
			return "[session]";
		case "message": {
			const message = value.message;
			if (!message) return "[message]";
			const role = String(message.role || "message");
			const body = textFromContent(message.content);
			const tool = role === "toolResult" && message.toolName ? ` ${String(message.toolName)}` : "";
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
	private scrollOffset = 0;
	private viewHeight = 1;
	private totalLines = 0;
	private flash = "";
	private promptContent?: string[];
	private transcriptContent?: string[];
	private transcriptCache?: { path: string; size: number; mtimeMs: number; lines: string[] };
	private transcriptRefreshTimer?: NodeJS.Timeout;

	constructor(
		private readonly tui: TUI,
		private readonly theme: { fg(color: any, text: string): string; bold(text: string): string },
		private readonly keybindings: KeybindingsManager,
		private readonly callbacks: SubagentInspectorCallbacks,
	) {}

	dispose(): void {
		this.stopTranscriptRefresh();
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "app.interrupt") || this.keybindings.matches(data, "tui.select.cancel") || data === "q") {
			if (this.view === "list") this.callbacks.onClose();
			else this.showList();
			return;
		}

		const wheelDelta = this.parseMouseScrollDelta(data);
		if (wheelDelta !== 0) {
			this.scrollBy(wheelDelta);
			return;
		}

		if (this.keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.up)) {
			if (this.view === "list") this.moveSelection(-1);
			else this.scrollBy(-1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.down)) {
			if (this.view === "list") this.moveSelection(1);
			else this.scrollBy(1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageUp") || matchesKey(data, Key.pageUp)) {
			this.scrollBy(-(this.viewHeight || 1));
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageDown") || matchesKey(data, Key.pageDown)) {
			this.scrollBy(this.viewHeight || 1);
			return;
		}
		if (matchesKey(data, Key.home)) {
			this.setScroll(0);
			return;
		}
		if (matchesKey(data, Key.end)) {
			this.setScroll(Math.max(0, this.totalLines - this.viewHeight));
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter)) {
			if (this.view === "list") this.showOverview();
			return;
		}

		switch (data) {
			case "o":
				this.showOverview();
				return;
			case "p":
				this.showPrompt();
				return;
			case "t":
				this.showTranscript();
				return;
			case "s":
				this.runAction("steer", () => this.callbacks.steer(this.selected()?.id || ""));
				return;
			case "x":
				this.runAction("kill", () => this.callbacks.kill(this.selected()?.id || ""));
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
		const innerWidth = Math.max(36, width - 2);
		const rows = this.tui.terminal.rows || 24;
		const panelHeight = Math.min(Math.max(12, rows - 2), Math.max(12, Math.floor(rows * 0.85)));
		const chromeLines = 6;
		const contentHeight = Math.max(1, panelHeight - chromeLines);
		const content = this.contentLines(innerWidth);
		this.totalLines = content.length;
		this.viewHeight = contentHeight;
		if (this.view === "list") this.ensureListSelectionVisible();
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, Math.max(0, content.length - contentHeight)));
		const visible = content.slice(this.scrollOffset, this.scrollOffset + contentHeight);
		const padding = Math.max(0, contentHeight - visible.length);
		const start = content.length === 0 ? 0 : this.scrollOffset + 1;
		const end = Math.min(content.length, this.scrollOffset + visible.length);
		const scrollInfo = content.length > contentHeight ? `${start}-${end}/${content.length}` : `${content.length}/${content.length}`;
		const title = this.view === "list" ? " Subagents " : ` Subagent ${sanitizeTerminalText(this.selected()?.id || "")} · ${this.view} `;

		const lines = [
			this.borderLine(innerWidth, "top"),
			this.frameLine(this.theme.fg("accent", this.theme.bold(title)), innerWidth),
			this.frameLine(this.theme.fg("dim", this.helpText(scrollInfo)), innerWidth),
			this.theme.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`),
			...visible.map((line) => this.frameLine(line, innerWidth)),
		];
		for (let index = 0; index < padding; index++) lines.push(this.frameLine("", innerWidth));
		lines.push(this.theme.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`));
		lines.push(this.frameLine(this.theme.fg("dim", sanitizeTerminalText(this.flash || this.footerText())), innerWidth));
		lines.push(this.borderLine(innerWidth, "bottom"));
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	invalidate(): void {}

	refresh(): void {
		this.requestRender();
	}

	private contentLines(width: number): string[] {
		if (this.view === "list") return this.listLines(width);
		if (this.view === "overview") return this.overviewLines(width);
		if (this.view === "prompt") return this.promptLines(width);
		return this.transcriptLines(width);
	}

	private listLines(width: number): string[] {
		const handles = this.callbacks.getHandles();
		if (handles.length === 0) return [this.theme.fg("dim", "No subagents tracked yet.")];
		return handles.map((handle) => {
			const selected = handle.id === this.selectedId;
			const icon = handle.killing ? "◐" : handle.state === "done" ? "✓" : handle.state === "error" ? "✗" : handle.state === "killed" ? "■" : "●";
			const activity = handle.currentTool || handle.lastTool || (handle.isStreaming ? "responding" : "idle");
			const model = `${handle.actualModel.provider}/${handle.actualModel.id}`;
			const state = handle.killing ? "killing" : handle.state;
			const result = handle.resultKind === "partial" ? " · partial result" : handle.resultKind === "final" ? " · final result" : "";
			const row = sanitizeTerminalText(`${icon} ${handle.id} ${handle.name} ${state} ${elapsed(handle.createdAt, handle.completedAt)} ${model} · thinking:${handle.actualThinking} · ${activity}${result}`);
			const rendered = truncateToWidth(row, width, "…");
			return selected ? this.theme.fg("accent", `› ${rendered}`) : `  ${rendered}`;
		});
	}

	private overviewLines(width: number): string[] {
		const handle = this.selected();
		if (!handle) return ["Selected handle no longer exists."];
		const rows = [
			`Agent: ${handle.name} (${handle.source})`,
			`Source: ${handle.sourcePath}`,
			`State: ${handle.killing ? "killing" : handle.state}`,
			`Task: ${handle.task}`,
			`Cwd: ${handle.cwd}`,
			`PID / exit: ${handle.pid ?? "-"} / ${handle.exitCode ?? "-"}`,
			`Requested model/thinking: ${handle.requestedModel} · ${handle.requestedThinking}`,
			`Actual model/thinking: ${handle.actualModel.provider}/${handle.actualModel.id} · ${handle.actualThinking}`,
			`Tools: ${handle.configuredTools.join(", ") || "(none)"}`,
			`Created / RPC ready / agent start: ${this.time(handle.createdAt)} / ${this.time(handle.rpcReadyAt)} / ${this.time(handle.agentStartedAt)}`,
			`Last activity / completed: ${this.time(handle.lastActivityAt)} / ${this.time(handle.completedAt)}`,
			`Activity: ${handle.currentTool ? `${handle.currentTool} since ${this.time(handle.currentToolStartedAt)}` : handle.lastTool || (handle.isStreaming ? "responding" : "idle")}`,
			`Usage: ${handle.usage.turns} turns, ↑${handle.usage.input} ↓${handle.usage.output} R${handle.usage.cacheRead} W${handle.usage.cacheWrite} $${handle.usage.cost.toFixed(4)}`,
			`Session: ${handle.sessionPath}`,
			`Transcript: ${handle.transcriptNote}`,
			`Prompt: ${handle.promptPath}`,
			`Result: ${handle.resultKind === "none" ? "no assistant result captured" : `${handle.resultKind} result ${handle.resultPath || "(no result Markdown yet)"}`}`,
		];
		if (handle.stopReason) rows.push(`Stop reason: ${handle.stopReason}`);
		if (handle.error) rows.push(`Error: ${handle.error}`);
		if (handle.stderrPreview) rows.push(`Stderr: ${handle.stderrPreview}`);
		if (handle.resultPreview) rows.push(`${handle.resultKind === "partial" ? "Partial result preview" : "Final result preview"}: ${handle.resultPreview}`);
		return this.wrapRows(rows, width);
	}

	private promptLines(width: number): string[] {
		const handle = this.selected();
		if (!handle) return ["Selected handle no longer exists."];
		const header = [
			"Pi effective system prompt",
			`Agent: ${handle.name}`,
			`Source: ${handle.source}`,
			`Source path: ${handle.sourcePath}`,
			"",
			"Delegated task",
			handle.task,
			"",
			"Prompt capture:",
		];
		const body = this.promptContent || ["Loading prompt sidecar…"];
		return this.wrapRows([...header, ...body], width);
	}

	private transcriptLines(width: number): string[] {
		const handle = this.selected();
		if (!handle) return ["Selected handle no longer exists."];
		const body = this.transcriptContent || [handle.transcriptNote, "Loading transcript…"];
		return this.wrapRows([`Read-only transcript: ${handle.sessionPath}`, "", ...body], width);
	}

	private wrapRows(rows: string[], width: number): string[] {
		const result: string[] = [];
		for (const row of rows) {
			if (!row) {
				result.push("");
				continue;
			}
			result.push(...wrapTextWithAnsi(sanitizeTerminalText(row), Math.max(1, width)));
		}
		return result;
	}

	private helpText(scrollInfo: string): string {
		if (this.view === "list") return `Enter overview · ↑↓ select · s steer · x kill · c clear finished · Esc close · ${scrollInfo}`;
		return `o overview · p prompt · t transcript · s steer · x kill · c clear finished · ↑↓ scroll · Esc back · ${scrollInfo}`;
	}

	private footerText(): string {
		if (this.view === "list") return "Selection stays attached to the subagent ID while records refresh.";
		return "Prompt and transcript are read-only; transcript refreshes while this view is open.";
	}

	private selected(): InspectorHandle | undefined {
		return this.callbacks.getHandles().find((handle) => handle.id === this.selectedId);
	}

	private ensureSelection(): void {
		const handles = this.callbacks.getHandles();
		if (!handles.some((handle) => handle.id === this.selectedId)) this.selectedId = handles[0]?.id;
	}

	private moveSelection(delta: number): void {
		const handles = this.callbacks.getHandles();
		if (handles.length === 0) return;
		const current = Math.max(0, handles.findIndex((handle) => handle.id === this.selectedId));
		const next = Math.max(0, Math.min(handles.length - 1, current + delta));
		this.selectedId = handles[next]?.id;
		this.ensureListSelectionVisible();
		this.flash = "";
		this.requestRender();
	}

	private ensureListSelectionVisible(): void {
		const selectedIndex = this.callbacks.getHandles().findIndex((handle) => handle.id === this.selectedId);
		if (selectedIndex < 0) return;
		if (selectedIndex < this.scrollOffset) this.scrollOffset = selectedIndex;
		else if (selectedIndex >= this.scrollOffset + this.viewHeight) this.scrollOffset = selectedIndex - this.viewHeight + 1;
	}

	private showList(): void {
		this.view = "list";
		this.scrollOffset = 0;
		this.flash = "";
		this.stopTranscriptRefresh();
		this.requestRender();
	}

	private showOverview(): void {
		if (!this.selected()) return;
		this.view = "overview";
		this.scrollOffset = 0;
		this.flash = "";
		this.stopTranscriptRefresh();
		this.requestRender();
	}

	private showPrompt(): void {
		const handle = this.selected();
		if (!handle) return;
		this.view = "prompt";
		this.scrollOffset = 0;
		this.flash = "";
		this.stopTranscriptRefresh();
		void this.loadPrompt(handle.promptPath);
		this.requestRender();
	}

	private showTranscript(): void {
		const handle = this.selected();
		if (!handle) return;
		this.view = "transcript";
		this.scrollOffset = 0;
		this.flash = "";
		void this.refreshTranscript(handle);
		this.startTranscriptRefresh();
		this.requestRender();
	}

	private async loadPrompt(path: string): Promise<void> {
		try {
			this.promptContent = (await fs.readFile(path, "utf8")).split("\n");
		} catch (error) {
			this.promptContent = [`No captured Pi effective system prompt yet (${error instanceof Error ? error.message : String(error)}).`];
		}
		this.requestRender();
	}

	private async refreshTranscript(handle: InspectorHandle): Promise<void> {
		try {
			const stat = await fs.stat(handle.sessionPath);
			if (
				this.transcriptCache?.path === handle.sessionPath &&
				this.transcriptCache.size === stat.size &&
				this.transcriptCache.mtimeMs === stat.mtimeMs
			) {
				this.transcriptContent = this.transcriptCache.lines;
				return;
			}
			const raw = await fs.readFile(handle.sessionPath, "utf8");
			const records = raw.split("\n");
			const partial = records.pop();
			const lines: string[] = [];
			for (const record of records) {
				if (!record) continue;
				try {
					lines.push(transcriptLine(JSON.parse(record)));
				} catch (error) {
					lines.push(`[malformed JSONL record] ${error instanceof Error ? error.message : String(error)}: ${record}`);
				}
			}
			if (partial) lines.push(`[partial JSONL record while Pi writes] ${partial}`);
			this.transcriptCache = { path: handle.sessionPath, size: stat.size, mtimeMs: stat.mtimeMs, lines };
			this.transcriptContent = lines.length > 0 ? lines : ["No persisted transcript yet."];
		} catch {
			this.transcriptCache = undefined;
			this.transcriptContent = ["No persisted transcript yet."];
		}
		this.requestRender();
	}

	private startTranscriptRefresh(): void {
		this.stopTranscriptRefresh();
		this.transcriptRefreshTimer = setInterval(() => {
			const handle = this.view === "transcript" ? this.selected() : undefined;
			if (handle) void this.refreshTranscript(handle);
		}, 1000);
	}

	private stopTranscriptRefresh(): void {
		if (this.transcriptRefreshTimer) clearInterval(this.transcriptRefreshTimer);
		this.transcriptRefreshTimer = undefined;
	}

	private runAction(name: string, action: () => Promise<string>): void {
		if (!this.selected()) return;
		void action()
			.then((message) => {
				this.flash = message;
				this.requestRender();
			})
			.catch((error) => {
				this.flash = `${name} failed: ${error instanceof Error ? error.message : String(error)}`;
				this.requestRender();
			});
	}

	private time(value: number | undefined): string {
		return value ? new Date(value).toISOString().slice(11, 19) : "-";
	}

	private scrollBy(delta: number): void {
		this.setScroll(this.scrollOffset + delta);
	}

	private setScroll(next: number): void {
		const clamped = Math.max(0, Math.min(next, Math.max(0, this.totalLines - this.viewHeight)));
		if (clamped === this.scrollOffset) return;
		this.scrollOffset = clamped;
		this.requestRender();
	}

	private frameLine(content: string, innerWidth: number): string {
		const truncated = truncateToWidth(content, innerWidth, "");
		return `${this.theme.fg("borderMuted", "│")}${truncated}${" ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)))}${this.theme.fg("borderMuted", "│")}`;
	}

	private borderLine(innerWidth: number, edge: "top" | "bottom"): string {
		return this.theme.fg("borderMuted", `${edge === "top" ? "┌" : "└"}${"─".repeat(innerWidth)}${edge === "top" ? "┐" : "┘"}`);
	}

	private requestRender(): void {
		this.tui.requestRender();
	}

	private parseMouseScrollDelta(data: string): number {
		const sgr = /^\x1b\[<(\d+);\d+;\d+([Mm])$/u.exec(data);
		if (sgr) return this.wheelDelta(Number(sgr[1]));
		if (data.startsWith("\x1b[M") && data.length >= 6) return this.wheelDelta(data.charCodeAt(3) - 32);
		return 0;
	}

	private wheelDelta(code: number): number {
		if (!Number.isFinite(code) || (code & 64) === 0) return 0;
		if ((code & 3) === 0) return 3;
		if ((code & 3) === 1) return -3;
		return 0;
	}
}
