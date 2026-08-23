import * as fs from "node:fs/promises";
import { dirname } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { persistRunResult } from "./result-store.js";

const childId = process.env.PI_SUBAGENT_CHILD_ID || "unknown-child";
const incarnation = process.env.PI_SUBAGENT_INCARNATION || "unknown-incarnation";
const delegatedPrompt = process.env.PI_SUBAGENT_SYSTEM_PROMPT || "";
const promptPath = process.env.PI_SUBAGENT_PROMPT_PATH;
const sessionDir = process.env.PI_SUBAGENT_SESSION_DIR;
const leaseFilePath = process.env.PI_SUBAGENT_LEASE_PATH;
const leaseOwnerSessionFile = process.env.PI_SUBAGENT_OWNER_SESSION_FILE;
const leaseOwnerSessionId = process.env.PI_SUBAGENT_OWNER_SESSION_ID;
const leaseControllerInstanceId = process.env.PI_SUBAGENT_CONTROLLER_INSTANCE_ID;
const CHILD_LEASE_CHECK_INTERVAL_MS = 5_000;
const subagentDepth = Math.max(
	1,
	Number.parseInt(process.env.PI_SUBAGENT_DEPTH || "1", 10) || 1,
);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface ChildLeaseIdentity {
	ownerSessionFile: string;
	ownerSessionId: string;
	controllerInstanceId: string;
}

export function isValidChildLeaseRecord(
	value: unknown,
	identity: ChildLeaseIdentity,
	at = Date.now(),
): boolean {
	if (!isRecord(value)) return false;
	return (
		value.ownerSessionFile === identity.ownerSessionFile &&
		value.ownerSessionId === identity.ownerSessionId &&
		value.controllerInstanceId === identity.controllerInstanceId &&
		typeof value.expiresAt === "number" &&
		Number.isFinite(value.expiresAt) &&
		at <= value.expiresAt
	);
}

const childLeaseIdentity =
	leaseFilePath &&
	leaseOwnerSessionFile &&
	leaseOwnerSessionId &&
	leaseControllerInstanceId
		? {
				ownerSessionFile: leaseOwnerSessionFile,
				ownerSessionId: leaseOwnerSessionId,
				controllerInstanceId: leaseControllerInstanceId,
			}
		: undefined;
let leaseMonitorTimer: NodeJS.Timeout | undefined;
let leaseMonitorGeneration = 0;
let leaseMonitorActive = false;

function stopLeaseMonitor(): void {
	leaseMonitorActive = false;
	leaseMonitorGeneration++;
	if (leaseMonitorTimer) {
		clearInterval(leaseMonitorTimer);
		leaseMonitorTimer = undefined;
	}
}

async function checkLease(generation: number): Promise<void> {
	if (
		!leaseMonitorActive ||
		generation !== leaseMonitorGeneration ||
		!leaseFilePath ||
		!childLeaseIdentity
	)
		return;
	let record: unknown;
	try {
		record = JSON.parse(await fs.readFile(leaseFilePath, "utf8"));
	} catch {
		record = undefined;
	}
	if (
		!leaseMonitorActive ||
		generation !== leaseMonitorGeneration ||
		!childLeaseIdentity
	)
		return;
	if (isValidChildLeaseRecord(record, childLeaseIdentity)) return;
	stopLeaseMonitor();
	try {
		process.kill(process.pid, "SIGTERM");
	} catch {
		// The process can exit between validation and the self-fence signal.
	}
}

function startLeaseMonitor(): void {
	if (!leaseFilePath || !childLeaseIdentity) return;
	stopLeaseMonitor();
	leaseMonitorActive = true;
	const generation = leaseMonitorGeneration;
	void checkLease(generation);
	const timer = setInterval(() => void checkLease(generation), CHILD_LEASE_CHECK_INTERVAL_MS);
	timer.unref();
	leaseMonitorTimer = timer;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!isRecord(part) || part.type !== "text") return "";
			return typeof part.text === "string" ? part.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

async function captureEffectivePrompt(prompt: string): Promise<void> {
	if (!promptPath) return;
	try {
		await fs.mkdir(dirname(promptPath), { recursive: true, mode: 0o700 });
		await fs.chmod(dirname(promptPath), 0o700).catch(() => {});
		await fs.writeFile(promptPath, prompt, { encoding: "utf8", mode: 0o600 });
		await fs.chmod(promptPath, 0o600).catch(() => {});
	} catch (error) {
		process.stderr.write(
			`Failed to capture Pi effective system prompt: ${error instanceof Error ? error.message : String(error)}\n`,
		);
	}
}

function delegatedSystemPrompt(systemPrompt: string): string {
	const sections = [systemPrompt];
	if (delegatedPrompt.trim())
		sections.push(`Direct delegated guidance:\n${delegatedPrompt.trim()}`);
	sections.push(`Subagent execution rules:
- You are handling a delegated subtask for a parent agent.
- You are a subagent, not the top-level agent.
- Stay tightly scoped to the assigned task and return a definitive result.
- Prefer concise, high-signal findings over long narration.
- Never call subagent_start from within a subagent. Nested delegation is disabled. If further delegation seems necessary, tell the parent agent instead.
- Your final answer should be useful to another agent that did not watch your full run.
- Current delegated depth: ${subagentDepth}`);
	return sections.filter(Boolean).join("\n\n");
}

export default function childSubagentExtension(pi: ExtensionAPI) {
	let context: ExtensionContext | undefined;
	let runId =
		Number.parseInt(process.env.PI_SUBAGENT_RUN_ID_BASE || "0", 10) || 0;
	let resultText = "";
	let stopReason: string | undefined;
	let errorMessage: string | undefined;

	pi.on("session_start", async (_event, ctx) => {
		context = ctx;
		startLeaseMonitor();
		await captureEffectivePrompt(ctx.getSystemPrompt());
	});

	pi.on("session_shutdown", async () => {
		stopLeaseMonitor();
	});

	pi.on("before_agent_start", async (event) => {
		const systemPrompt = delegatedSystemPrompt(event.systemPrompt);
		await captureEffectivePrompt(systemPrompt);
		return { systemPrompt };
	});

	pi.on("agent_start", async (_event, ctx) => {
		context = ctx;
		runId++;
		resultText = "";
		stopReason = undefined;
		errorMessage = undefined;
		await captureEffectivePrompt(ctx.getSystemPrompt());
	});

	pi.on("message_end", async (event) => {
		const message = event.message as unknown as Record<string, unknown>;
		if (message.role !== "assistant") return;
		resultText = textFromContent(message.content);
		if (typeof message.stopReason === "string") stopReason = message.stopReason;
		if (typeof message.errorMessage === "string")
			errorMessage = message.errorMessage;
	});

	pi.on("agent_end", async (event) => {
		const details = event as unknown as Record<string, unknown>;
		const messages = details.messages;
		if (!Array.isArray(messages)) return;
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index];
			if (!isRecord(message) || message.role !== "assistant") continue;
			resultText = textFromContent(message.content);
			if (typeof message.stopReason === "string") stopReason = message.stopReason;
			if (typeof message.errorMessage === "string")
				errorMessage = message.errorMessage;
			break;
		}
	});

	pi.on("agent_settled", async (event) => {
		const details = event as unknown as Record<string, unknown>;
		const reportedOutcome = details.runOutcome;
		const outcome =
			reportedOutcome === "succeeded" ||
			reportedOutcome === "failed" ||
			reportedOutcome === "aborted"
				? reportedOutcome
				: stopReason === "aborted"
					? "aborted"
					: errorMessage || stopReason === "error"
						? "failed"
						: "succeeded";
		if (sessionDir && runId > 0) {
			try {
				await persistRunResult(sessionDir, {
					runId,
					outcome,
					incarnation,
					settledAt: Date.now(),
					result: resultText,
				});
			} catch (error) {
				process.stderr.write(
					`Failed to persist exact result for child ${childId} run ${runId}: ${error instanceof Error ? error.message : String(error)}\n`,
				);
			}
		}
		// The RPC host owns the process lifetime. Settlement must not shut it down.
		void context;
	});
}
