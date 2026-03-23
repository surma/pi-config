import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const agentName = process.env.PI_SUBAGENT_AGENT_NAME || "subagent";
const delegatedPrompt = process.env.PI_SUBAGENT_SYSTEM_PROMPT || "";
const hasInheritedActiveTools = process.env.PI_SUBAGENT_ACTIVE_TOOLS !== undefined;
const inheritedActiveTools = (process.env.PI_SUBAGENT_ACTIVE_TOOLS || "")
	.split(",")
	.map((value) => value.trim())
	.filter(Boolean);
const subagentDepth = Math.max(1, Number.parseInt(process.env.PI_SUBAGENT_DEPTH || "1", 10) || 1);

export default function childSubagentExtension(pi: ExtensionAPI) {
	const applyInheritedActiveTools = () => {
		if (!hasInheritedActiveTools) return;
		pi.setActiveTools(Array.from(new Set([...inheritedActiveTools, "update_status"])));
	};

	pi.registerTool({
		name: "update_status",
		label: "Update Status",
		description:
			"Report a short progress update to the parent agent. Call this regularly when you start a new phase, switch approach, begin a tool-heavy step, discover an important finding, or are about to finish. Keep it brief and concrete.",
		promptSnippet: "Report concise progress updates back to the parent agent.",
		parameters: Type.Object({
			message: Type.String({ description: "A short description of what you are currently doing" }),
		}),
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: `Status updated: ${params.message}` }],
				details: { message: params.message },
			};
		},
	});

	pi.on("session_start", async () => {
		applyInheritedActiveTools();
	});

	pi.on("before_agent_start", async (event) => {
		applyInheritedActiveTools();
		const sections = [event.systemPrompt];
		if (delegatedPrompt.trim()) {
			sections.push(`Delegated subagent role (${agentName}):\n${delegatedPrompt.trim()}`);
		}
		sections.push(`Subagent execution rules:
- You are handling a delegated subtask for a parent agent.
- You are a subagent, not the top-level agent.
- Stay tightly scoped to the assigned task and return a definitive result.
- Prefer concise, high-signal findings over long narration.
- Never call subagent_run or subagent_start from within a subagent. Nested delegation is disabled. If further delegation seems necessary, tell the parent agent instead.
- Call update_status({message}) regularly with short, concrete progress updates.
- Before your final answer, call update_status with a near-final summary of what you concluded.
- Your final answer should be useful to another agent that did not watch your full work.
- Current delegated depth: ${subagentDepth}`);
		return { systemPrompt: sections.filter(Boolean).join("\n\n") };
	});

	pi.on("agent_end", async (_event, ctx) => {
		ctx.shutdown();
	});
}
