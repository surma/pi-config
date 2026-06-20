/**
 * List Models Extension
 *
 * Provides a `list_models` tool that enumerates all models known to pi,
 * indicating which are available (have configured auth) in this session.
 *
 * This is a standalone discovery tool — other extensions (subagents,
 * model switchers, etc.) can reference it in their descriptions so the
 * agent knows how to find valid model identifiers.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

interface ModelInfo {
	ref: string;
	provider: string;
	id: string;
	name: string;
	available: boolean;
	reasoning: boolean;
	input: string[];
	contextWindow: number;
	maxTokens: number;
}

function formatModelRef(provider: string, modelId: string): string {
	return `${provider}/${modelId}`;
}

function getKnownModels(ctx: ExtensionContext): ModelInfo[] {
	const available = new Set(
		ctx.modelRegistry
			.getAvailable()
			.map((model) => formatModelRef(model.provider, model.id).toLowerCase()),
	);
	return [...ctx.modelRegistry.getAll()]
		.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id))
		.map((model) => ({
			ref: formatModelRef(model.provider, model.id),
			provider: model.provider,
			id: model.id,
			name: model.name,
			available: available.has(formatModelRef(model.provider, model.id).toLowerCase()),
			reasoning: !!model.reasoning,
			input: [...model.input],
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		}));
}

const ListModelsSchema = Type.Object({
	includeUnavailable: Type.Optional(
		Type.Boolean({
			default: true,
			description: "Include known but unavailable models in the listing",
		}),
	),
	search: Type.Optional(
		Type.String({
			description: "Optional case-insensitive substring filter over provider/model and name",
		}),
	),
});

export default function listModelsExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "list_models",
		label: "List Models",
		description:
			"List the exact model ids accepted by this session, and whether they are available here.",
		promptSnippet:
			"List available model ids accepted by this session.",
		parameters: ListModelsSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const includeUnavailable = params.includeUnavailable ?? true;
			const search = params.search?.trim().toLowerCase();
			let models = getKnownModels(ctx).filter((model) => includeUnavailable || model.available);
			if (search) {
				models = models.filter(
					(model) =>
						model.ref.toLowerCase().includes(search) ||
						model.name.toLowerCase().includes(search) ||
						model.provider.toLowerCase().includes(search) ||
						model.id.toLowerCase().includes(search),
				);
			}
			if (models.length === 0) {
				const scope = includeUnavailable ? "known" : "available";
				const suffix = search ? ` matching "${params.search}"` : "";
				return {
					content: [{ type: "text", text: `No ${scope} models found${suffix}.` }],
					details: { models: [] },
				};
			}

			const availableCount = models.filter((model) => model.available).length;
			const lines = [
				`${models.length} model${models.length === 1 ? "" : "s"} (${availableCount} available)`,
				...models.map((model) => {
					const flags = [
						model.available ? "available" : "unavailable",
						model.reasoning ? "reasoning" : undefined,
						model.input.includes("image") ? "image" : undefined,
					]
						.filter(Boolean)
						.join(", ");
					return `${model.available ? "✓" : "·"} ${model.ref}${model.name && model.name !== model.id ? ` — ${model.name}` : ""}${flags ? ` (${flags})` : ""}`;
				}),
			];
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { models },
			};
		},
	});
}
