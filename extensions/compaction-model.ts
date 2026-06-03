import { compact as compactWithModel } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// =============================================================================
// Editable knobs
// =============================================================================
//
// This extension does ONE thing: when pi decides to compact (auto-compaction at
// a run boundary, or /compact), it swaps the model used to GENERATE the summary
// for a large-context model. That lets the whole conversation fit in the
// summarizer's window, so the summary stays faithful regardless of the main
// model's size.
//
// It deliberately initiates NOTHING. It never calls ctx.compact(), never starts
// a run, and never listens to turn_end / session_compact / agent_end. It only
// answers pi's own `session_before_compact` event — pi has already decided to
// compact, so there is no second compaction and no run-loop race. (Extension-
// initiated compaction is the exact pattern that once killed Escape handling;
// avoid it at all costs.)
//
// First candidate found in the model registry wins. If none is available or its
// auth fails, we return nothing and pi falls back to its own default compaction.
const COMPACTION_MODEL_CANDIDATES = [
	{ provider: "anthropic", id: "claude-sonnet-4-6" },
	{ provider: "anthropic", id: "claude-sonnet-4-5" },
	{ provider: "anthropic", id: "claude-sonnet-4-20250514" },
] as const;

export default function compactionModel(pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		const model = COMPACTION_MODEL_CANDIDATES.map((candidate) =>
			ctx.modelRegistry.find(candidate.provider, candidate.id),
		).find((candidate) => candidate !== undefined);
		if (!model) {
			if (ctx.hasUI) ctx.ui.notify("Compaction model not found; using default compaction.", "warning");
			return;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			if (ctx.hasUI) ctx.ui.notify(`Compaction auth failed: ${auth.error}; using default compaction.`, "warning");
			return;
		}
		if (!auth.apiKey) {
			if (ctx.hasUI) ctx.ui.notify(`No API key for ${model.provider}; using default compaction.`, "warning");
			return;
		}

		try {
			if (ctx.hasUI) ctx.ui.notify(`Compacting with ${model.provider}/${model.id}...`, "info");
			return {
				compaction: await compactWithModel(
					event.preparation,
					model,
					auth.apiKey,
					auth.headers,
					event.customInstructions,
					event.signal,
				),
			};
		} catch (error) {
			if (!event.signal.aborted && ctx.hasUI) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Compaction with ${model.id} failed: ${message}; using default compaction.`, "warning");
			}
			return;
		}
	});
}
