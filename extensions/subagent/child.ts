import * as fs from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const delegatedPrompt = process.env.PI_SUBAGENT_SYSTEM_PROMPT || "";
const promptPath = process.env.PI_SUBAGENT_PROMPT_PATH;
const hasInheritedActiveTools = process.env.PI_SUBAGENT_ACTIVE_TOOLS !== undefined;
const inheritedActiveTools = (process.env.PI_SUBAGENT_ACTIVE_TOOLS || "")
	.split(",")
	.map((value) => value.trim())
	.filter(Boolean);
const subagentDepth = Math.max(1, Number.parseInt(process.env.PI_SUBAGENT_DEPTH || "1", 10) || 1);

async function captureEffectivePrompt(prompt: string): Promise<void> {
	if (!promptPath) return;
	try {
		await fs.mkdir(dirname(promptPath), { recursive: true, mode: 0o700 });
		await fs.chmod(dirname(promptPath), 0o700).catch(() => {});
		await fs.writeFile(promptPath, prompt, { encoding: "utf8", mode: 0o600 });
		await fs.chmod(promptPath, 0o600).catch(() => {});
	} catch (error) {
		process.stderr.write(`Failed to capture Pi effective system prompt: ${error instanceof Error ? error.message : String(error)}\n`);
	}
}

export default function childSubagentExtension(pi: ExtensionAPI) {
	let shutdownRequested = false;
	const applyInheritedActiveTools = () => {
		if (!hasInheritedActiveTools) return;
		pi.setActiveTools(Array.from(new Set(inheritedActiveTools)));
	};

	pi.on("session_start", async () => {
		applyInheritedActiveTools();
	});

	pi.on("before_agent_start", async (event) => {
		applyInheritedActiveTools();
		const sections = [event.systemPrompt];
		if (delegatedPrompt.trim()) {
			sections.push(`Direct delegated guidance:\n${delegatedPrompt.trim()}`);
		}
		sections.push(`Subagent execution rules:
- You are handling a delegated subtask for a parent agent.
- You are a subagent, not the top-level agent.
- Stay tightly scoped to the assigned task and return a definitive result.
- Prefer concise, high-signal findings over long narration.
- Never call subagent_start from within a subagent. Nested delegation is disabled. If further delegation seems necessary, tell the parent agent instead.
- Your final answer should be useful to another agent that did not watch your full work.
- Current delegated depth: ${subagentDepth}`);
		return { systemPrompt: sections.filter(Boolean).join("\n\n") };
	});

	pi.on("agent_start", async (_event, ctx) => {
		await captureEffectivePrompt(ctx.getSystemPrompt());
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (shutdownRequested) return;
		shutdownRequested = true;
		ctx.shutdown();
	});
}
