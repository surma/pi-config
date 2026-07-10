export interface ToolActivity {
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

export interface FinalizedAssistantIdentity {
	fallbackKey: string;
	timestamp: number;
	responseId?: string;
}

export interface AssistantLiveState {
	resultText: string;
	currentAssistantText: string;
	latestAssistantText: string;
	assistantMessageGeneration: number;
	finalizedAssistantIdentities: FinalizedAssistantIdentity[];
	assistantMessageActive?: boolean;
	assistantMessageKey?: string;
	assistantMessageFallbackKey?: string;
	assistantMessageResponseId?: string;
	assistantMessageTimestamp?: number;
	finalizedAssistantMessageGeneration?: number;
	finalizedAssistantMessageKey?: string;
	finalizedAssistantFallbackKey?: string;
	finalizedAssistantResponseId?: string;
	finalizedAssistantTimestamp?: number;
	assistantTextTruncated: boolean;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const block = part as Record<string, unknown>;
			return block.type === "text" && typeof block.text === "string" ? block.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

export function boundedDisplay(text: string, max: number, tailOnly = false): { text: string; truncated: boolean } {
	if (text.length <= max) return { text, truncated: false };
	if (tailOnly) return { text: `… [earlier output truncated] …\n${text.slice(-max)}`, truncated: true };
	const half = Math.floor(max / 2);
	return {
		text: `${text.slice(0, half)}\n… [display truncated] …\n${text.slice(-half)}`,
		truncated: true,
	};
}

interface AssistantMessageIdentity {
	key: string;
	fallbackKey: string;
	timestamp: number;
	responseId?: string;
}

// FIFO tombstones keep the last 256 finalized identities independent from the active/latest display state.
export const MAX_FINALIZED_ASSISTANT_IDENTITIES = 256;

/** Pi starts some provider streams before responseId is populated; these public AssistantMessage fields are the stable fallback. */
function assistantMessageFallbackKey(message: Record<string, unknown> | undefined): string | undefined {
	if (!message) return undefined;
	const timestamp = message.timestamp;
	if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return undefined;
	return JSON.stringify([timestamp, message.api ?? "", message.provider ?? "", message.model ?? ""]);
}

function assistantMessageIdentity(message: Record<string, unknown> | undefined): AssistantMessageIdentity | undefined {
	const fallbackKey = assistantMessageFallbackKey(message);
	if (!fallbackKey) return undefined;
	const responseId = typeof message?.responseId === "string" && message.responseId ? message.responseId : undefined;
	return {
		key: responseId ? `response:${responseId}` : `fallback:${fallbackKey}`,
		fallbackKey,
		timestamp: message!.timestamp as number,
		responseId,
	};
}

export function assistantMessageKey(message: Record<string, unknown> | undefined): string | undefined {
	return assistantMessageIdentity(message)?.key;
}

function matchesIdentity(
	identity: AssistantMessageIdentity,
	known: { fallbackKey?: string; responseId?: string },
	allowResponseIdUpgrade: boolean,
): boolean {
	if (known.responseId && identity.responseId) return known.responseId === identity.responseId;
	if (known.responseId && !identity.responseId) return false;
	if (!known.responseId && identity.responseId && !allowResponseIdUpgrade) return false;
	return !!known.fallbackKey && known.fallbackKey === identity.fallbackKey;
}

function matchesRetainedFinalizedIdentity(
	identity: AssistantMessageIdentity,
	known: FinalizedAssistantIdentity,
): boolean {
	// A public responseId proves distinct same-timestamp messages. Without one,
	// the fallback identity is intentionally ambiguous and therefore retained.
	if (identity.responseId) return known.responseId === identity.responseId;
	return known.fallbackKey === identity.fallbackKey;
}

function wasFinalized(state: AssistantLiveState, identity: AssistantMessageIdentity): boolean {
	return state.finalizedAssistantIdentities.some((known) => matchesRetainedFinalizedIdentity(identity, known));
}

function rememberFinalizedIdentity(state: AssistantLiveState, identity: AssistantMessageIdentity): void {
	if (wasFinalized(state, identity)) return;
	state.finalizedAssistantIdentities.push({
		fallbackKey: identity.fallbackKey,
		timestamp: identity.timestamp,
		responseId: identity.responseId,
	});
	if (state.finalizedAssistantIdentities.length > MAX_FINALIZED_ASSISTANT_IDENTITIES) {
		state.finalizedAssistantIdentities.splice(
			0,
			state.finalizedAssistantIdentities.length - MAX_FINALIZED_ASSISTANT_IDENTITIES,
		);
	}
}

export function assistantMessageMatchesFinalized(
	state: AssistantLiveState,
	message: Record<string, unknown> | undefined,
): boolean {
	const identity = assistantMessageIdentity(message);
	return !!identity && matchesIdentity(
		identity,
		{ fallbackKey: state.finalizedAssistantFallbackKey, responseId: state.finalizedAssistantResponseId },
		false,
	);
}

export function startAssistantMessage(
	state: AssistantLiveState,
	message: Record<string, unknown> | undefined,
): boolean {
	const identity = assistantMessageIdentity(message);
	if (!identity || state.assistantMessageActive || wasFinalized(state, identity)) return false;
	if (state.finalizedAssistantTimestamp !== undefined) {
		if (identity.timestamp < state.finalizedAssistantTimestamp) return false;
		if (
			identity.timestamp === state.finalizedAssistantTimestamp &&
			(!identity.responseId || !state.finalizedAssistantResponseId || identity.responseId === state.finalizedAssistantResponseId)
		) return false;
	}
	state.assistantMessageGeneration += 1;
	state.assistantMessageActive = true;
	state.assistantMessageKey = identity.key;
	state.assistantMessageFallbackKey = identity.fallbackKey;
	state.assistantMessageResponseId = identity.responseId;
	state.assistantMessageTimestamp = identity.timestamp;
	state.currentAssistantText = "";
	state.assistantTextTruncated = false;
	return true;
}

export function updateAssistantMessage(
	state: AssistantLiveState,
	message: Record<string, unknown> | undefined,
	max: number,
): boolean {
	if (!state.assistantMessageActive) return false;
	const identity = assistantMessageIdentity(message);
	if (!identity || wasFinalized(state, identity) || !matchesIdentity(
		identity,
		{ fallbackKey: state.assistantMessageFallbackKey, responseId: state.assistantMessageResponseId },
		true,
	)) return false;
	if (!state.assistantMessageResponseId && identity.responseId) {
		state.assistantMessageResponseId = identity.responseId;
		state.assistantMessageKey = identity.key;
	}
	const bounded = boundedDisplay(extractText(message?.content), max);
	state.currentAssistantText = bounded.text;
	state.assistantTextTruncated = bounded.truncated;
	return true;
}

export function finalizeAssistantMessage(
	state: AssistantLiveState,
	message: Record<string, unknown> | undefined,
	max: number,
): boolean {
	if (!updateAssistantMessage(state, message, max)) return false;
	const fullText = extractText(message?.content);
	if (fullText) {
		state.latestAssistantText = state.currentAssistantText;
		state.resultText = fullText;
	}
	state.assistantMessageActive = false;
	state.finalizedAssistantMessageGeneration = state.assistantMessageGeneration;
	state.finalizedAssistantMessageKey = state.assistantMessageKey;
	state.finalizedAssistantFallbackKey = state.assistantMessageFallbackKey;
	state.finalizedAssistantResponseId = state.assistantMessageResponseId;
	state.finalizedAssistantTimestamp = state.assistantMessageTimestamp;
	const identity = assistantMessageIdentity(message);
	if (identity) rememberFinalizedIdentity(state, identity);
	return true;
}

export function updateToolActivity(tool: ToolActivity, result: unknown, max: number, at: number): void {
	if (!result || typeof result !== "object") return;
	const value = result as { content?: unknown; details?: Record<string, unknown> };
	const bounded = boundedDisplay(extractText(value.content), max, true);
	tool.output = bounded.text;
	tool.outputTruncated = bounded.truncated;
	const progress = value.details?.progress;
	if (typeof progress === "number" && Number.isFinite(progress)) tool.progress = progress;
	tool.updatedAt = at;
}
