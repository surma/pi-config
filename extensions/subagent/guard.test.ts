import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import subagentExtension from "./index.ts";

function stubApi() {
	const calls = { on: 0, registerTool: 0, registerCommand: 0 };
	const api = {
		on: () => {
			calls.on++;
		},
		registerTool: () => {
			calls.registerTool++;
		},
		registerCommand: () => {
			calls.registerCommand++;
		},
		getActiveTools: () => [],
		getThinkingLevel: () => "off",
	};
	return { api, calls };
}

test("controller registers nothing under PI_SUBAGENT_CHILD=1", () => {
	const previous = process.env.PI_SUBAGENT_CHILD;
	process.env.PI_SUBAGENT_CHILD = "1";
	try {
		const { api, calls } = stubApi();
		subagentExtension(api as unknown as ExtensionAPI);
		assert.deepEqual(calls, { on: 0, registerTool: 0, registerCommand: 0 });
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = previous;
	}
});

test("controller registers nine tools and commands without marker", () => {
	const previous = process.env.PI_SUBAGENT_CHILD;
	delete process.env.PI_SUBAGENT_CHILD;
	try {
		const { api, calls } = stubApi();
		subagentExtension(api as unknown as ExtensionAPI);
		assert.deepEqual(calls, { on: 3, registerTool: 9, registerCommand: 3 });
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = previous;
	}
});
