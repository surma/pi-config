import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@mariozechner/pi-tui";
import {
	type InspectorHandle,
	SubagentInspector,
	sanitizeTerminalText,
	type SubagentInspectorOptions,
} from "./ui.ts";

function handle(
	id: string,
	overrides: Partial<InspectorHandle> = {},
): InspectorHandle {
	return {
		id,
		name: `child-${id}`,
		state: "running",
		lifecycle: "running",
		processState: "alive",
		runState: "running",
		runId: 1,
		rpcReady: true,
		killing: false,
		task: `task-${id}\nwith details`,
		cwd: "/tmp/work",
		pid: 123,
		exitSignal: null,
		requestedModel: "provider/model",
		requestedThinking: "medium",
		actualModel: { provider: "provider", id: "model" },
		actualThinking: "medium",
		sessionPath: `/tmp/${id}.jsonl`,
		promptPath: `/tmp/${id}.prompt`,
		runOutcome: "pending",
		settlementStatus: "pending",
		outputPath: undefined,
		outputStatus: "not_requested",
		transcriptStatus: "available",
		stderrTail: undefined,
		createdAt: 1_000,
		lastActivityAt: Date.now(),
		currentTool: undefined,
		lastTool: "read",
		isStreaming: true,
		usage: {
			input: 10,
			output: 5,
			cacheRead: 2,
			cacheWrite: 1,
			cost: 0.01,
			turns: 1,
		},
		currentAssistantText: `live-${id}`,
		latestAssistantText: `final-${id}`,
		activeTools: [],
		recentTools: [],
		...overrides,
	};
}

interface TestFileStat {
	size: number;
	mtimeMs: number;
}

interface TestFileHandle {
	stat(): Promise<{ size: number }>;
	read(
		buffer: Buffer,
		offset: number,
		length: number,
		position: number,
	): Promise<{ bytesRead: number; buffer: Buffer }>;
	close(): Promise<void>;
}

interface TestFiles {
	open(path: string, flags: string): Promise<TestFileHandle>;
	stat(path: string): Promise<TestFileStat>;
}

function openText(content: string): TestFileHandle {
	const bytes = Buffer.from(content, "utf8");
	return {
		stat: async () => ({ size: bytes.length }),
		read: async (buffer, offset, length, position) => {
			const available = Math.max(0, bytes.length - position);
			const count = Math.min(length, available);
			bytes.copy(buffer, offset, position, position + count);
			return { bytesRead: count, buffer };
		},
		close: async () => {},
	};
}

type InspectorArguments = ConstructorParameters<typeof SubagentInspector>;
interface TestInspectorOptions extends SubagentInspectorOptions {
	throwOnRequestRender?: boolean;
}

function fixture(
	initial: InspectorHandle[],
	files?: TestFiles,
	rows = 60,
	options?: TestInspectorOptions,
) {
	const handles = initial;
	let renders = 0;
	let closed = false;
	const tui = {
		terminal: { rows, columns: 120 },
		requestRender: () => {
			if (options?.throwOnRequestRender) throw new Error("render failed");
			renders++;
		},
	} as unknown as InspectorArguments[0];
	const theme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as InspectorArguments[1];
	const keybindings = {
		matches(data: string, id: string) {
			return (
				(id === "app.interrupt" && data === "escape") ||
				(id === "tui.select.cancel" && data === "escape") ||
				(id === "tui.select.confirm" && data === "enter") ||
				(id === "tui.select.up" && data === "up") ||
				(id === "tui.select.down" && data === "down") ||
				(id === "tui.select.pageUp" && data === "pageUp") ||
				(id === "tui.select.pageDown" && data === "pageDown")
			);
		},
	} as unknown as InspectorArguments[2];
	const inspector = new SubagentInspector(
		tui,
		theme,
		keybindings,
		{
			getHandles: () => handles,
			steer: async () => "steered",
			kill: async () => "killed",
			clearFinished: () => 0,
			onClose: () => {
				closed = true;
			},
		},
		files as unknown as InspectorArguments[4],
		options,
	);
	return {
		handles,
		inspector,
		get renders() {
			return renders;
		},
		get closed() {
			return closed;
		},
	};
}

function plain(lines: string[]): string {
	return lines.join("\n");
}

const noFiles: TestFiles = {
	open: async () => openText(""),
	stat: async () => ({ size: 0, mtimeMs: 0 }),
};

test("status, original task, and live output have distinct hierarchy", async () => {
	const child = handle("a1", {
		activeTools: [
			{
				toolCallId: "tool-1",
				name: "bash",
				startedAt: Date.now() - 1_000,
				updatedAt: Date.now(),
				output: "partial output",
				outputTruncated: false,
			},
		],
	});
	const fx = fixture([child], noFiles);
	fx.inspector.render(120);
	fx.inspector.handleInput("enter");
	const status = plain(fx.inspector.render(120));
	assert.match(status, /IDENTITY/);
	assert.match(status, /LIFECYCLE/);
	assert.match(status, /OUTCOME/);
	assert.doesNotMatch(status, /task-a1/);
	assert.doesNotMatch(status, /live-a1/);

	fx.inspector.handleInput("p");
	await Promise.resolve();
	const task = plain(fx.inspector.render(120));
	assert.ok(
		task.indexOf("ORIGINAL DELEGATED TASK") <
			task.indexOf("CAPTURED PI EFFECTIVE SYSTEM PROMPT"),
	);
	assert.match(task, /task-a1/);

	fx.inspector.handleInput("r");
	await Promise.resolve();
	const live = plain(fx.inspector.render(120));
	assert.match(live, /CURRENT RESPONSE/);
	assert.match(live, /live-a1/);
	assert.match(live, /RECENT ACTIVITY \/ TRANSCRIPT/);
	assert.match(live, /\[tool\] bash · running/);
	assert.match(live, /partial output/);
	fx.inspector.dispose();
});

test("list and open detail reconcile lifecycle updates", () => {
	const child = handle("a1");
	const fx = fixture([child], noFiles);
	try {
		assert.match(plain(fx.inspector.render(80)), /\[ALIVE\/RUNNING\]/);
		fx.inspector.handleInput("enter");
		child.state = "done";
		child.lifecycle = "done";
		child.processState = "stopped";
		child.runState = "idle";
		child.isStreaming = false;
		child.completedAt = Date.now();
		fx.inspector.refresh();
		assert.match(plain(fx.inspector.render(80)), /\[STOPPED\/IDLE\]/);
		fx.inspector.handleInput("escape");
		assert.match(plain(fx.inspector.render(80)), /\[STOPPED\/IDLE\]/);
	} finally {
		fx.inspector.dispose();
	}
});

test("all rendered lines fit narrow and wide widths after sanitization", () => {
	const child = handle("a1", {
		name: `unsafe\u001b[31m-${"x".repeat(200)}`,
		currentAssistantText: `line with \u001b[2J controls ${"long ".repeat(100)}`,
	});
	for (const width of [40, 52, 80, 120]) {
		const fx = fixture([child], noFiles, 30);
		fx.inspector.render(width);
		fx.inspector.handleInput("r");
		const lines = fx.inspector.render(width);
		assert.ok(
			lines.every((line) => visibleWidth(line) <= width),
			`line exceeded ${width} columns`,
		);
		assert.doesNotMatch(plain(lines), /\u001b\[2J/);
		fx.inspector.dispose();
	}
	assert.equal(sanitizeTerminalText("a\u001b[31m"), "a\\u001B[31m");
});

test("manual live scroll pauses follow until f resumes", () => {
	const child = handle("a1", {
		currentAssistantText: Array.from(
			{ length: 40 },
			(_, index) => `line ${index}`,
		).join("\n"),
	});
	const fx = fixture([child], noFiles, 16);
	fx.inspector.render(80);
	fx.inspector.handleInput("r");
	assert.match(plain(fx.inspector.render(80)), /FOLLOWING LIVE OUTPUT/);
	fx.inspector.handleInput("up");
	child.currentAssistantText += "\nnewest line";
	assert.match(
		plain(fx.inspector.render(80)),
		/PAUSED — End\/f resumes latest/,
	);
	fx.inspector.handleInput("f");
	const resumed = plain(fx.inspector.render(80));
	assert.match(resumed, /FOLLOWING LIVE OUTPUT/);
	assert.match(resumed, /newest line/);
	fx.inspector.dispose();
});

test("stale prompt reads cannot overwrite a newer selection", async () => {
	let resolveFirst!: (value: string) => void;
	const first = new Promise<string>((resolve) => {
		resolveFirst = resolve;
	});
	const files: TestFiles = {
		open: async (path: string) =>
			openText(path.includes("a.prompt") ? await first : "prompt-b"),
		stat: async () => ({ size: 0, mtimeMs: 0 }),
	};
	const fx = fixture([handle("a"), handle("b")], files);
	fx.inspector.render(100);
	fx.inspector.handleInput("p");
	fx.inspector.handleInput("escape");
	fx.inspector.handleInput("down");
	fx.inspector.handleInput("p");
	await new Promise((resolve) => setTimeout(resolve, 10));
	resolveFirst("prompt-a");
	await first;
	await new Promise((resolve) => setTimeout(resolve, 10));
	const rendered = plain(fx.inspector.render(100));
	assert.match(rendered, /prompt-b/);
	assert.doesNotMatch(rendered, /prompt-a/);
	fx.inspector.dispose();
});

test("malformed and partial JSONL history remains renderable", async () => {
	const files: TestFiles = {
		open: async () => openText(`not-json\n{"type":"message"`),
		stat: async () => ({ size: 30, mtimeMs: 1 }),
	};
	const fx = fixture([handle("a")], files);
	fx.inspector.render(100);
	fx.inspector.handleInput("r");
	await new Promise((resolve) => setTimeout(resolve, 0));
	const rendered = plain(fx.inspector.render(100));
	assert.match(rendered, /malformed JSONL record/);
	assert.match(rendered, /partial JSONL record while Pi writes/);
	fx.inspector.dispose();
});

test("inspector reads only a bounded transcript tail and keeps recent records", async () => {
	const transcript = `${Array.from(
		{ length: 20_000 },
		(_, index) => JSON.stringify({ type: "session_info", name: `history-${index}` }),
	).join("\n")}\n`;
	const size = Buffer.byteLength(transcript, "utf8");
	let largestRead = 0;
	const files: TestFiles = {
		stat: async () => ({ size, mtimeMs: 1 }),
		open: async () => {
			const source = openText(transcript);
			return {
				stat: source.stat,
				read: async (buffer, offset, length, position) => {
					largestRead = Math.max(largestRead, length);
					return source.read(buffer, offset, length, position);
				},
				close: source.close,
			};
		},
	};
	const fx = fixture([handle("a")], files, 40);
	fx.inspector.render(100);
	fx.inspector.handleInput("r");
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.ok(largestRead <= 512 * 1024);
	fx.inspector.handleInput("\x1bOH");
	assert.match(plain(fx.inspector.render(100)), /earlier transcript records omitted/);
	fx.inspector.handleInput("\x1bOF");
	assert.match(plain(fx.inspector.render(100)), /history-19999/);
	fx.inspector.dispose();
});

test("inspector bounds captured prompt reads and reports truncation", async () => {
	const prompt = `prompt-start\n${"p".repeat(70 * 1024)}`;
	let largestRead = 0;
	const files: TestFiles = {
		stat: async () => ({ size: 0, mtimeMs: 0 }),
		open: async () => {
			const source = openText(prompt);
			return {
				stat: source.stat,
				read: async (buffer, offset, length, position) => {
					largestRead = Math.max(largestRead, length);
					return source.read(buffer, offset, length, position);
				},
				close: source.close,
			};
		},
	};
	const fx = fixture([handle("a")], files);
	fx.inspector.render(100);
	fx.inspector.handleInput("p");
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(largestRead <= 64 * 1024 + 1);
	assert.match(plain(fx.inspector.render(100)), /prompt-start/);
	fx.inspector.handleInput("\x1bOF");
	assert.match(plain(fx.inspector.render(100)), /prompt truncated after/);
	fx.inspector.dispose();
});

test("a stalled transcript read cancels before the next selection refreshes", async () => {
	const reads: string[] = [];
	let closedStalledFile = 0;
	const files: TestFiles = {
		stat: async (path: string) => ({
			size: 20,
			mtimeMs: path.includes("a.jsonl") ? 1 : 2,
		}),
		open: async (path: string) => {
			reads.push(path);
			if (path.includes("a.jsonl")) {
				return {
					stat: async () => ({ size: 20 }),
					read: async () => new Promise<never>(() => {}),
					close: async () => {
						closedStalledFile++;
					},
				};
			}
			return openText(
				`${JSON.stringify({ type: "session_info", name: "history-b" })}\n`,
			);
		},
	};
	const fx = fixture(
		[handle("a"), handle("b")],
		files,
		40,
		{ fileOperationTimeoutMs: 20 },
	);
	fx.inspector.render(100);
	fx.inspector.handleInput("r");
	await new Promise<void>((resolve) => setImmediate(resolve));
	fx.inspector.handleInput("escape");
	fx.inspector.handleInput("down");
	fx.inspector.handleInput("r");
	await new Promise((resolve) => setTimeout(resolve, 80));
	assert.ok(reads[0]?.includes("a.jsonl"));
	assert.ok(reads.some((path) => path.includes("b.jsonl")));
	assert.equal(closedStalledFile, 1);
	assert.match(plain(fx.inspector.render(100)), /history-b/);
	fx.inspector.dispose();
});

test("a failed UI refresh stays inside the inspector boundary", () => {
	const fx = fixture([handle("a")], noFiles, 60, {
		throwOnRequestRender: true,
	});
	assert.doesNotThrow(() => fx.inspector.refresh());
	fx.inspector.dispose();
});

test("an aborted settled idle child does not keep the inspector refresh timer", async () => {
	const fx = fixture([
		handle("a", {
			state: "running",
			lifecycle: "idle",
			processState: "alive",
			runState: "idle",
			runOutcome: "aborted",
			settlementStatus: "settled",
			isStreaming: false,
		}),
	]);
	fx.inspector.render(80);
	const before = fx.renders;
	await new Promise((resolve) => setTimeout(resolve, 1_050));
	assert.equal(fx.renders, before);
	fx.inspector.dispose();
});

test("active refresh timer updates elapsed labels and dispose stops future renders", async () => {
	const fx = fixture([handle("a")], noFiles);
	const before = fx.renders;
	await new Promise((resolve) => setTimeout(resolve, 1_050));
	assert.ok(fx.renders > before);
	fx.inspector.dispose();
	const disposedAt = fx.renders;
	await new Promise((resolve) => setTimeout(resolve, 1_050));
	assert.equal(fx.renders, disposedAt);
});

test("stale transcript reads are ignored and queued refresh uses the newer child", async () => {
	let resolveFirstStat: ((value: TestFileStat) => void) | undefined;
	const firstStat = new Promise<TestFileStat>((resolve) => {
		resolveFirstStat = resolve;
	});
	const files: TestFiles = {
		stat: async (path: string) =>
			path.includes("a.jsonl") ? firstStat : { size: 20, mtimeMs: 2 },
		open: async (path: string) =>
			openText(
				path.includes("a.jsonl")
					? `${JSON.stringify({ type: "session_info", name: "history-a" })}\n`
					: `${JSON.stringify({ type: "session_info", name: "history-b" })}\n`,
			),
	};
	const fx = fixture([handle("a"), handle("b")], files);
	fx.inspector.render(100);
	fx.inspector.handleInput("r");
	fx.inspector.handleInput("escape");
	fx.inspector.handleInput("down");
	fx.inspector.handleInput("r");
	resolveFirstStat?.({ size: 20, mtimeMs: 1 });
	await firstStat;
	await new Promise((resolve) => setTimeout(resolve, 0));
	const rendered = plain(fx.inspector.render(100));
	assert.match(rendered, /history-b/);
	assert.doesNotMatch(rendered, /history-a/);
	fx.inspector.dispose();
});
