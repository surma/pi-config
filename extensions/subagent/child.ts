import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const agentName = process.env.PI_SUBAGENT_AGENT_NAME || "subagent";
const delegatedPrompt = process.env.PI_SUBAGENT_SYSTEM_PROMPT || "";

export default function childSubagentExtension(pi: ExtensionAPI) {
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

	pi.on("before_agent_start", async (event) => {
		const sections = [event.systemPrompt];
		if (delegatedPrompt.trim()) {
			sections.push(`Delegated subagent role (${agentName}):\n${delegatedPrompt.trim()}`);
		}
		sections.push(`Subagent execution rules:
- You are handling a delegated subtask for a parent agent.
- Stay tightly scoped to the assigned task and return a definitive result.
- Prefer concise, high-signal findings over long narration.
- Call update_status({message}) regularly with short, concrete progress updates.
- Before your final answer, call update_status with a near-final summary of what you concluded.
- Your final answer should be useful to another agent that did not watch your full work.`);
		return { systemPrompt: sections.filter(Boolean).join("\n\n") };
	});

	pi.on("agent_end", async (_event, ctx) => {
		ctx.shutdown();
	});
}
