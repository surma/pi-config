import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AutocompleteProvider, AutocompleteProviderFactory } from "@mariozechner/pi-tui";
import skillAliasesExtension from "../extensions/skill-aliases.ts";

type Handler = (event: any, ctx: any) => unknown;

type Command = {
	name: string;
	description: string;
	source: "extension" | "prompt" | "skill";
	sourceInfo: Record<string, never>;
};

function command(name: string, source: Command["source"]): Command {
	return { name, source, description: `${source} ${name}`, sourceInfo: {} };
}

function createHarness(commands: Command[]) {
	const handlers = new Map<string, Handler[]>();
	let autocompleteFactory: AutocompleteProviderFactory | undefined;
	const pi = {
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		getCommands: () => commands,
	};
	skillAliasesExtension(pi as unknown as ExtensionAPI);

	async function emit(name: string, event: any, ctx: any) {
		let result: unknown;
		for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
		return result;
	}

	return {
		emit,
		start(hasUI = true) {
			return emit("session_start", { reason: "startup" }, {
				hasUI,
				ui: {
					addAutocompleteProvider(factory: AutocompleteProviderFactory) {
						autocompleteFactory = factory;
					},
				},
			});
		},
		input(text: string) {
			return emit("input", { type: "input", text, source: "interactive" }, {});
		},
		get autocompleteFactory() {
			return autocompleteFactory;
		},
	};
}

test("rewrites bare skill commands and preserves arguments", async () => {
	const harness = createHarness([
		command("skill:music", "skill"),
		command("skill:web-search", "skill"),
	]);
	await harness.start();

	assert.deepEqual(await harness.input("/music"), {
		action: "transform",
		text: "/skill:music",
	});
	assert.deepEqual(await harness.input("/music find Boards of Canada"), {
		action: "transform",
		text: "/skill:music find Boards of Canada",
	});
	assert.deepEqual(await harness.input("/skill:music find Boards of Canada"), { action: "continue" });
	assert.deepEqual(await harness.input("Please use /music"), { action: "continue" });
	assert.deepEqual(await harness.input("/unknown"), { action: "continue" });
});

test("does not create aliases that conflict with prompts or extension commands", async () => {
	const harness = createHarness([
		command("skill:review", "skill"),
		command("review", "prompt"),
		command("skill:ctxwarn", "skill"),
		command("ctxwarn", "extension"),
		command("skill:music", "skill"),
	]);
	await harness.start();

	assert.deepEqual(await harness.input("/review"), { action: "continue" });
	assert.deepEqual(await harness.input("/ctxwarn status"), { action: "continue" });
	assert.deepEqual(await harness.input("/music"), {
		action: "transform",
		text: "/skill:music",
	});
});

test("shows bare skill names in autocomplete and preserves conflicting commands", async () => {
	const harness = createHarness([command("skill:music", "skill")]);
	await harness.start();
	assert.ok(harness.autocompleteFactory);

	let appliedItem: string | undefined;
	const current: AutocompleteProvider = {
		triggerCharacters: ["@"],
		async getSuggestions() {
			return {
				prefix: "/",
				items: [
					{ value: "new", label: "new", description: "Built-in command" },
					{ value: "skill:new", label: "skill:new", description: "New skill" },
					{ value: "skill:music", label: "skill:music", description: "Music skill" },
					{ value: "quit", label: "quit", description: "Built-in command" },
				],
			};
		},
		applyCompletion(lines, cursorLine, cursorCol, item) {
			appliedItem = item.value;
			return { lines, cursorLine, cursorCol };
		},
		shouldTriggerFileCompletion: () => true,
	};
	const provider = harness.autocompleteFactory!(current);
	const suggestions = await provider.getSuggestions(["/"], 0, 1, {
		signal: new AbortController().signal,
	});

	assert.deepEqual(suggestions?.items, [
		{ value: "new", label: "new", description: "Built-in command" },
		{ value: "music", label: "music", description: "Music skill" },
		{ value: "quit", label: "quit", description: "Built-in command" },
	]);
	assert.deepEqual(provider.triggerCharacters, ["@"]);
	assert.equal(provider.shouldTriggerFileCompletion?.([""], 0, 0), true);

	provider.applyCompletion(["/mu"], 0, 3, suggestions!.items[1]!, "/mu");
	assert.equal(appliedItem, "music");
});

test("does not install autocomplete outside UI modes", async () => {
	const harness = createHarness([command("skill:music", "skill")]);
	await harness.start(false);
	assert.equal(harness.autocompleteFactory, undefined);
});
