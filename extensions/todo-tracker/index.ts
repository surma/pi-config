/**
 * Todo Tracker Extension — workflow-aware task management for Pi Superpowers
 *
 * Provides a `todo` tool the LLM can call to manage implementation checklists,
 * plan tasks, and verification gates. State is stored in tool result details
 * for proper branching support.
 *
 * Actions:
 *   create   — Create a new todo list (clears existing)
 *   add      — Add a single todo item
 *   batch    — Add multiple items at once (from a plan)
 *   start    — Mark item as in_progress
 *   done     — Mark item as completed
 *   skip     — Mark item as skipped (with reason)
 *   block    — Mark item as blocked (with reason)
 *   reset    — Reset item to pending
 *   list     — Show current state
 *   summary  — Compact summary (counts by status)
 *   clear    — Clear all items
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type, type Static } from "@sinclair/typebox";

// --- Types ---

type TodoStatus = "pending" | "in_progress" | "done" | "skipped" | "blocked";

interface TodoItem {
	id: number;
	text: string;
	status: TodoStatus;
	reason?: string; // for skipped/blocked
	group?: string; // optional grouping (e.g., "Task 1", "Phase 2")
}

interface TodoState {
	items: TodoItem[];
	nextId: number;
	listName?: string;
}

interface TodoDetails extends TodoState {
	action: string;
	error?: string;
}

// --- Schema ---

const ActionEnum = StringEnum([
	"create",
	"add",
	"batch",
	"start",
	"done",
	"skip",
	"block",
	"reset",
	"list",
	"summary",
	"clear",
] as const);

const TodoParams = Type.Object({
	action: ActionEnum,
	name: Type.Optional(Type.String({ description: "List name (for create)" })),
	text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
	items: Type.Optional(
		Type.Array(
			Type.Object({
				text: Type.String(),
				group: Type.Optional(Type.String()),
			}),
			{ description: "Multiple items (for batch)" },
		),
	),
	id: Type.Optional(Type.Number({ description: "Item ID (for start/done/skip/block/reset)" })),
	reason: Type.Optional(Type.String({ description: "Reason (for skip/block)" })),
	group: Type.Optional(Type.String({ description: "Group name (for add)" })),
});

export type TodoToolInput = Static<typeof TodoParams>;

// --- Status helpers ---

const STATUS_ICONS: Record<TodoStatus, string> = {
	pending: "○",
	in_progress: "◉",
	done: "✓",
	skipped: "⊘",
	blocked: "✗",
};

function statusColor(status: TodoStatus, theme: Theme): (t: string) => string {
	switch (status) {
		case "pending":
			return (t) => theme.fg("dim", t);
		case "in_progress":
			return (t) => theme.fg("warning", t);
		case "done":
			return (t) => theme.fg("success", t);
		case "skipped":
			return (t) => theme.fg("muted", t);
		case "blocked":
			return (t) => theme.fg("error", t);
	}
}

function formatItem(item: TodoItem, theme: Theme): string {
	const color = statusColor(item.status, theme);
	const icon = color(STATUS_ICONS[item.status]);
	const id = theme.fg("accent", `#${item.id}`);
	const text = item.status === "done" || item.status === "skipped" ? theme.fg("dim", item.text) : item.text;
	const extra = item.reason ? theme.fg("dim", ` (${item.reason})`) : "";
	return `${icon} ${id} ${text}${extra}`;
}

function formatItemPlain(item: TodoItem): string {
	const icon = STATUS_ICONS[item.status];
	const extra = item.reason ? ` (${item.reason})` : "";
	return `${icon} #${item.id}: ${item.text}${extra}`;
}

function summaryText(items: TodoItem[]): string {
	const counts: Record<TodoStatus, number> = { pending: 0, in_progress: 0, done: 0, skipped: 0, blocked: 0 };
	for (const item of items) counts[item.status]++;
	const parts: string[] = [];
	if (counts.done) parts.push(`${counts.done} done`);
	if (counts.in_progress) parts.push(`${counts.in_progress} in progress`);
	if (counts.pending) parts.push(`${counts.pending} pending`);
	if (counts.blocked) parts.push(`${counts.blocked} blocked`);
	if (counts.skipped) parts.push(`${counts.skipped} skipped`);
	return `${items.length} items: ${parts.join(", ")}`;
}

// --- TUI Component ---

class TodoListComponent {
	private items: TodoItem[];
	private listName?: string;
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(items: TodoItem[], listName: string | undefined, theme: Theme, onClose: () => void) {
		this.items = items;
		this.listName = listName;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const lines: string[] = [];
		const th = this.theme;

		lines.push("");
		const title = th.fg("accent", ` ${this.listName || "Todos"} `);
		const headerLine = th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - (this.listName?.length ?? 5) - 8)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		if (this.items.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No items yet.")}`, width));
		} else {
			lines.push(truncateToWidth(`  ${th.fg("muted", summaryText(this.items))}`, width));
			lines.push("");

			// Group items
			const groups = new Map<string, TodoItem[]>();
			for (const item of this.items) {
				const g = item.group || "";
				if (!groups.has(g)) groups.set(g, []);
				groups.get(g)!.push(item);
			}

			for (const [group, groupItems] of groups) {
				if (group) {
					lines.push(truncateToWidth(`  ${th.fg("accent", th.bold(group))}`, width));
				}
				for (const item of groupItems) {
					lines.push(truncateToWidth(`  ${formatItem(item, th)}`, width));
				}
				if (group) lines.push("");
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

// --- Extension ---

export default function (pi: ExtensionAPI) {
	let state: TodoState = { items: [], nextId: 1 };

	const makeDetails = (action: string, error?: string): TodoDetails => ({
		action,
		items: [...state.items],
		nextId: state.nextId,
		listName: state.listName,
		error,
	});

	const findItem = (id: number) => state.items.find((i) => i.id === id);

	const reconstructState = (ctx: ExtensionContext) => {
		state = { items: [], nextId: 1 };
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;
			const details = msg.details as TodoDetails | undefined;
			if (details) {
				state = { items: details.items, nextId: details.nextId, listName: details.listName };
			}
		}
	};

	pi.on("session_start", async (_e, ctx) => reconstructState(ctx));
	pi.on("session_switch", async (_e, ctx) => reconstructState(ctx));
	pi.on("session_fork", async (_e, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_e, ctx) => reconstructState(ctx));

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Manage a task/todo list for tracking implementation progress. " +
			"Actions: create (new list), add (single item), batch (multiple items with optional groups), " +
			"start/done/skip/block/reset (by id), list (show all), summary (counts), clear. " +
			"Use groups to organize items by task or phase. " +
			"Use this to track plan execution, verification checklists, and debugging progress.",
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			switch (params.action) {
				case "create": {
					state = { items: [], nextId: 1, listName: params.name };
					return {
						content: [{ type: "text", text: `Created todo list${params.name ? `: ${params.name}` : ""}` }],
						details: makeDetails("create"),
					};
				}

				case "add": {
					if (!params.text) {
						return {
							content: [{ type: "text", text: "Error: text required for add" }],
							details: makeDetails("add", "text required"),
						};
					}
					const item: TodoItem = {
						id: state.nextId++,
						text: params.text,
						status: "pending",
						group: params.group,
					};
					state.items.push(item);
					return {
						content: [{ type: "text", text: `Added #${item.id}: ${item.text}` }],
						details: makeDetails("add"),
					};
				}

				case "batch": {
					if (!params.items?.length) {
						return {
							content: [{ type: "text", text: "Error: items array required for batch" }],
							details: makeDetails("batch", "items required"),
						};
					}
					const added: TodoItem[] = [];
					for (const entry of params.items) {
						const item: TodoItem = {
							id: state.nextId++,
							text: entry.text,
							status: "pending",
							group: entry.group,
						};
						state.items.push(item);
						added.push(item);
					}
					return {
						content: [
							{
								type: "text",
								text: `Added ${added.length} items:\n${added.map((i) => `  #${i.id}: ${i.text}`).join("\n")}`,
							},
						],
						details: makeDetails("batch"),
					};
				}

				case "start":
				case "done":
				case "skip":
				case "block":
				case "reset": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: `Error: id required for ${params.action}` }],
							details: makeDetails(params.action, "id required"),
						};
					}
					const item = findItem(params.id);
					if (!item) {
						return {
							content: [{ type: "text", text: `Item #${params.id} not found` }],
							details: makeDetails(params.action, `#${params.id} not found`),
						};
					}
					const statusMap: Record<string, TodoStatus> = {
						start: "in_progress",
						done: "done",
						skip: "skipped",
						block: "blocked",
						reset: "pending",
					};
					item.status = statusMap[params.action];
					item.reason = params.reason;
					return {
						content: [{ type: "text", text: `#${item.id} → ${item.status}${item.reason ? ` (${item.reason})` : ""}` }],
						details: makeDetails(params.action),
					};
				}

				case "list": {
					if (state.items.length === 0) {
						return {
							content: [{ type: "text", text: "No items" }],
							details: makeDetails("list"),
						};
					}
					const header = state.listName ? `${state.listName}\n` : "";
					const text = header + state.items.map(formatItemPlain).join("\n") + "\n\n" + summaryText(state.items);
					return {
						content: [{ type: "text", text }],
						details: makeDetails("list"),
					};
				}

				case "summary": {
					return {
						content: [{ type: "text", text: summaryText(state.items) }],
						details: makeDetails("summary"),
					};
				}

				case "clear": {
					const count = state.items.length;
					state = { items: [], nextId: 1, listName: state.listName };
					return {
						content: [{ type: "text", text: `Cleared ${count} items` }],
						details: makeDetails("clear"),
					};
				}

				default:
					return {
						content: [{ type: "text", text: `Unknown action: ${params.action}` }],
						details: makeDetails("unknown", `unknown action: ${params.action}`),
					};
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.name) text += ` ${theme.fg("dim", args.name)}`;
			if (args.items?.length) text += ` ${theme.fg("dim", `(${args.items.length} items)`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text : "", 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			const items = details.items;

			switch (details.action) {
				case "create":
					return new Text(
						theme.fg("success", "✓ ") + theme.fg("muted", `Created${details.listName ? `: ${details.listName}` : ""}`),
						0,
						0,
					);

				case "add":
				case "batch": {
					const count = details.action === "batch" ? `${items.length} items` : "";
					let text = theme.fg("success", "✓ ") + theme.fg("muted", result.content[0]?.type === "text" ? result.content[0].text.split("\n")[0] : "Added");
					if (expanded && items.length > 0) {
						text += "\n" + items.slice(-5).map((i) => `  ${formatItem(i, theme)}`).join("\n");
					}
					return new Text(text, 0, 0);
				}

				case "start":
				case "done":
				case "skip":
				case "block":
				case "reset": {
					const msg = result.content[0]?.type === "text" ? result.content[0].text : "";
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
				}

				case "list": {
					if (items.length === 0) {
						return new Text(theme.fg("dim", "No items"), 0, 0);
					}
					let text = theme.fg("muted", summaryText(items));
					const display = expanded ? items : items.slice(0, 8);
					for (const item of display) {
						text += `\n  ${formatItem(item, theme)}`;
					}
					if (!expanded && items.length > 8) {
						text += `\n  ${theme.fg("dim", `... ${items.length - 8} more`)}`;
					}
					return new Text(text, 0, 0);
				}

				case "summary":
					return new Text(theme.fg("muted", summaryText(items)), 0, 0);

				case "clear":
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", "Cleared all items"), 0, 0);

				default:
					return new Text(theme.fg("dim", result.content[0]?.type === "text" ? result.content[0].text : ""), 0, 0);
			}
		},
	});

	// /todos command for user
	pi.registerCommand("todos", {
		description: "Show the current todo/task list",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new TodoListComponent(state.items, state.listName, theme, () => done());
			});
		},
	});
}
