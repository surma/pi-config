import type { ExtensionAPI, ExtensionContext, InputSource } from "@mariozechner/pi-coding-agent";

const PROXY_BASE_URL = process.env.PI_PROXY_BASE_URL ?? "https://vendors.llm.surma.technology";
const USAGE_TAG_PREFIX = ["pi", "coding-agent"] as const;

export default function (pi: ExtensionAPI) {
  let currentInputSource: InputSource = "interactive";

  function buildUsageTag(sessionId?: string) {
    return JSON.stringify([...USAGE_TAG_PREFIX, currentInputSource, sessionId ?? ""]);
  }

  function registerAllProviders(sessionId?: string) {
    const headers: Record<string, string> = {
      "Shopify-Usage-Tag": buildUsageTag(sessionId),
    };

    if (sessionId) {
      headers["X-Shopify-Session-Affinity-Header"] = "pi-session-id";
      headers["pi-session-id"] = sessionId;
    }

    pi.registerProvider("anthropic", {
      baseUrl: `${PROXY_BASE_URL}/apis/anthropic`,
      apiKey: "PI_PROXY_API_KEY",
      headers,
    });

    pi.registerProvider("openai", {
      baseUrl: `${PROXY_BASE_URL}/v1`,
      apiKey: "PI_PROXY_API_KEY",
      headers,
    });

    pi.registerProvider("google", {
      baseUrl: `${PROXY_BASE_URL}/googlevertexai-global/v1beta1/projects/shopify-ml-production/locations/global/publishers/google`,
      apiKey: "PI_PROXY_API_KEY",
      headers: {
        ...headers,
        Authorization: "PI_PROXY_AUTH_HEADER",
      },
    });

    pi.registerProvider("groq", {
      baseUrl: `${PROXY_BASE_URL}/groq/openai/v1`,
      apiKey: "PI_PROXY_API_KEY",
      headers,
    });

    pi.registerProvider("xai", {
      baseUrl: `${PROXY_BASE_URL}/xai/v1`,
      apiKey: "PI_PROXY_API_KEY",
      headers,
    });
  }

  async function refreshActiveModel(ctx: ExtensionContext) {
    const current = ctx.model;

    if (current) {
      const fresh = ctx.modelRegistry.find(current.provider, current.id);

      if (fresh) {
        await pi.setModel(fresh);
      }
    }
  }

  registerAllProviders();

  pi.on("input", async (event, ctx) => {
    currentInputSource = event.source;
    registerAllProviders(ctx.sessionManager.getSessionId());
    await refreshActiveModel(ctx);
  });

  async function onSessionChange(_event: unknown, ctx: ExtensionContext) {
    registerAllProviders(ctx.sessionManager.getSessionId());
    await refreshActiveModel(ctx);
  }

  pi.on("session_start", onSessionChange);
  pi.on("session_switch", onSessionChange);
  pi.on("session_fork", onSessionChange);
}
