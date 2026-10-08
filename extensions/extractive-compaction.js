// ../nix/store/a2mzaapx3y947d8l3rgv43nr2xs9v459-extractive-compaction/src/extension.ts
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  CONFIG_DIR_NAME
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ../nix/store/a2mzaapx3y947d8l3rgv43nr2xs9v459-extractive-compaction/src/decisions.ts
import { setTimeout as wait } from "node:timers/promises";
var DECISIONS_ENDPOINT = "https://proxy.shopify.ai/vendors/openai-shopify-shopapp-chatgpt-prod/v1/decisions";
var DECISIONS_MODEL = "gpt-6-luna";
var MAX_QUESTIONS_PER_REQUEST = 200;
var MAX_INPUT_TIMES_QUESTIONS = 4e6;
var CHARS_PER_TOKEN = 4;
var RESERVED_HEADERS = /* @__PURE__ */ new Set(["authorization", "content-type"]);
async function extraHeaders(provider) {
  if (!provider) return {};
  let supplied;
  try {
    supplied = await provider();
  } catch {
    return {};
  }
  return Object.fromEntries(
    Object.entries(supplied ?? {}).filter(
      ([name, value]) => typeof value === "string" && !RESERVED_HEADERS.has(name.toLowerCase())
    )
  );
}
var REQUEST_TIMEOUT_MS = 6e4;
function createDecisionsClient(tokenProvider, headersProvider) {
  let token;
  const tokenAfter = (rejected) => {
    if (token === void 0 || token === rejected) token = tokenProvider();
    return token;
  };
  const send = async (body, bearer, signal) => {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    return fetch(DECISIONS_ENDPOINT, {
      method: "POST",
      headers: {
        ...await extraHeaders(headersProvider),
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json"
      },
      body,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
  };
  return {
    async post(body, signal) {
      const attempted = tokenAfter();
      const response = await send(body, await attempted, signal);
      if (response.status !== 401) return response;
      return send(body, await tokenAfter(attempted), signal);
    }
  };
}
function questionsPerRequest(input) {
  const inputTokens = Math.max(1, input.length / CHARS_PER_TOKEN);
  return Math.max(1, Math.min(MAX_QUESTIONS_PER_REQUEST, Math.floor(MAX_INPUT_TIMES_QUESTIONS / inputTokens)));
}
var RETRY_DELAYS_MS = [1e3, 4e3, 15e3];
var CONCURRENCY = 8;
async function askPredicates(input, questions, client, signal, sleep = (ms, s) => wait(ms, void 0, { signal: s })) {
  const stats = { requests: 0, retries: 0, refusals: 0, billedInputTokens: 0 };
  const probabilities = /* @__PURE__ */ new Map();
  const size = questionsPerRequest(input);
  const queue = [];
  for (let start = 0; start < questions.length; start += size) queue.push(questions.slice(start, start + size));
  const ask = async (batch) => {
    const body = JSON.stringify({
      model: DECISIONS_MODEL,
      input,
      questions: batch.map((question) => ({ type: "predicate", ...question }))
    });
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      stats.requests++;
      let response;
      let failure;
      try {
        response = await client.post(body, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        failure = error;
      }
      if (response?.ok) {
        const data = await response.json();
        if (typeof data.usage?.input_tokens === "number") stats.billedInputTokens += data.usage.input_tokens;
        const refused = /* @__PURE__ */ new Set();
        for (const answer of data.answers ?? []) {
          if (typeof answer.name !== "string") continue;
          if (answer.type === "refusal") refused.add(answer.name);
          else if (typeof answer.probability === "number") probabilities.set(answer.name, answer.probability);
        }
        stats.refusals += refused.size;
        const missing = batch.filter((question) => !probabilities.has(question.name) && !refused.has(question.name));
        if (missing.length > 0) throw new Error(`the decisions response has no answer for ${missing[0].name}`);
        return;
      }
      if (response?.status === 504 && batch.length > 1) {
        const middle = Math.ceil(batch.length / 2);
        await ask(batch.slice(0, middle));
        await ask(batch.slice(middle));
        return;
      }
      const retryable = response === void 0 || response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= RETRY_DELAYS_MS.length) {
        if (response) {
          const text = await response.text().catch(() => "");
          throw new Error(`decisions request failed: HTTP ${response.status} ${text.slice(0, 200)}`.trim());
        }
        throw failure instanceof Error ? failure : new Error(String(failure));
      }
      stats.retries++;
      const retryAfter = (Number(response?.headers.get("retry-after")) || 0) * 1e3;
      await sleep(Math.max(retryAfter, RETRY_DELAYS_MS[attempt]), signal);
    }
  };
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < queue.length) {
      try {
        await ask(queue[next++]);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  return { probabilities, stats };
}

// ../nix/store/a2mzaapx3y947d8l3rgv43nr2xs9v459-extractive-compaction/src/facts.ts
function deriveFacts(messages) {
  const skills = /* @__PURE__ */ new Set();
  const filesRead = /* @__PURE__ */ new Set();
  const filesEdited = /* @__PURE__ */ new Set();
  const failedToolCallIds = /* @__PURE__ */ new Set();
  for (const message of messages) {
    if (message.role === "toolResult" && message.isError) {
      failedToolCallIds.add(message.toolCallId);
    }
  }
  const touch = (set, path) => {
    if (typeof path === "string" && path !== "") {
      set.delete(path);
      set.add(path);
    }
  };
  for (const message of messages) {
    if (message.role === "user") {
      const texts = typeof message.content === "string" ? [message.content] : message.content.filter((part) => part.type === "text").map((part) => part.text);
      for (const text of texts) {
        for (const match of text.matchAll(/<skill name="([^"]+)"/g)) {
          skills.delete(match[1]);
          skills.add(match[1]);
        }
      }
    } else if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type !== "toolCall" || failedToolCallIds.has(part.id)) continue;
        const path = part.arguments?.path;
        if (part.name === "read") touch(filesRead, path);
        else if (part.name === "write" || part.name === "edit") touch(filesEdited, path);
      }
    }
  }
  return { skills: [...skills], filesRead: [...filesRead], filesEdited: [...filesEdited] };
}
function mergeFacts(previous, current) {
  const merge = (a, b) => {
    const currentSet = new Set(b);
    return [...(a ?? []).filter((item) => !currentSet.has(item)), ...b];
  };
  return {
    skills: merge(previous?.skills, current.skills),
    filesRead: merge(previous?.filesRead, current.filesRead),
    filesEdited: merge(previous?.filesEdited, current.filesEdited)
  };
}
var EMPTY_FACTS = { skills: [], filesRead: [], filesEdited: [] };

// ../nix/store/a2mzaapx3y947d8l3rgv43nr2xs9v459-extractive-compaction/src/recall.ts
var RECALL_TOOL_NAME = "recall";
var RECALL_MAX_RESULTS = 10;
var RECALL_MAX_TOKENS = 4e3;
var RECALL_DESCRIPTION = {
  tool: "Search the complete original session on disk. Summary lines quote the session word for word: search for a line, or an exact phrase from one, to read the entry it came from.",
  query: "Text to search for in the original session, such as a summary line or an exact phrase",
  page: "1-based page of search results, when the response says more entries exist"
};
function recall(entries, args) {
  const resultsByCallId = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "toolResult") {
      resultsByCallId.set(entry.message.toolCallId, entry.message);
    }
  }
  const words = [...new Set((args.query ?? "").toLowerCase().split(/\s+/).filter((word) => word !== ""))];
  if (words.length === 0) {
    return "Provide a query to search the original session.";
  }
  const items = entries.map((entry) => ({
    label: entryLabel(entry),
    text: entryText(entry, resultsByCallId),
    summary: entry.type === "compaction" || entry.type === "branch_summary"
  })).filter((item) => item.text !== "");
  const lower = items.map((item) => item.text.toLowerCase());
  const page = Math.max(1, Math.floor(args.page ?? 1));
  const phrase = new RegExp(
    (args.query ?? "").trim().split(/\s+/).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"),
    "i"
  );
  const exact = items.map((item, i) => ({ i, at: item.summary ? void 0 : phrase.exec(item.text)?.index })).filter((hit) => hit.at !== void 0).reverse();
  if (exact.length === 1) {
    if (page > 1) return `No results on page ${page}: 1 entry contains the query. Use page 1.`;
    const { label, text } = items[exact[0].i];
    return entryAround(`[${label}] `, text, exact[0].at);
  }
  const exactEntries = new Set(exact.map((hit) => hit.i));
  const df = words.map((word) => lower.reduce((n, text) => n + (text.includes(word) ? 1 : 0), 0));
  const scored = items.map((item, i) => {
    let score = 0;
    for (let w = 0; w < words.length; w++) {
      if (lower[i].includes(words[w])) score += Math.log(1 + items.length / df[w]);
    }
    return { score, i };
  }).filter((item) => item.score > 0 && !exactEntries.has(item.i));
  scored.sort((a, b) => b.score - a.score);
  const matches = [
    ...exact.map(({ i, at }) => `[${items[i].label}] ${snippet(items[i].text, at)}`),
    ...scored.map(({ i }) => `[${items[i].label}] ${snippet(items[i].text, firstWordHit(lower[i], words))}`)
  ];
  if (matches.length === 0) {
    return `No session entries match "${args.query}".`;
  }
  let start = 0;
  for (let previousPage = 1; previousPage < page && start < matches.length; previousPage++) {
    start += takePage(matches, start).length;
  }
  const taken = takePage(matches, start);
  if (taken.length === 0) {
    return `No results on page ${page}: ${matches.length} entries match. Use a smaller page number.`;
  }
  const shown2 = taken.join("\n\n");
  const remaining = matches.length - start - taken.length;
  if (remaining > 0) {
    return `${shown2}

[${remaining} more matching entries not shown \u2014 this list is capped at ${RECALL_MAX_RESULTS} results and ${RECALL_MAX_TOKENS} tokens per page. Narrow the query to see fewer, more relevant entries, search for an exact phrase from one result to read its whole entry, or call again with page ${page + 1} for the next ones.]`;
  }
  return shown2;
}
function takePage(matches, start) {
  const taken = [];
  let tokens = 0;
  for (const match of matches.slice(start)) {
    if (taken.length >= RECALL_MAX_RESULTS) break;
    const matchTokens = estimateTokens(match);
    if (tokens + matchTokens > RECALL_MAX_TOKENS) {
      if (taken.length === 0) taken.push(withTokenCap("", match));
      break;
    }
    taken.push(match);
    tokens += matchTokens;
  }
  return taken;
}
function withTokenCap(prefix, text) {
  const prefixTokens = estimateTokens(prefix);
  if (estimateTokens(text) + prefixTokens <= RECALL_MAX_TOKENS) {
    return prefix + text;
  }
  const limit = (RECALL_MAX_TOKENS - prefixTokens) * 4;
  return `${prefix}${text.slice(0, limit)}
[entry truncated at ${RECALL_MAX_TOKENS} tokens \u2014 the full entry is longer. Use a query to find the specific part you need.]`;
}
function firstWordHit(lower, words) {
  let pos = -1;
  for (const word of words) {
    const at = lower.indexOf(word);
    if (at !== -1 && (pos === -1 || at < pos)) pos = at;
  }
  return pos;
}
function entryAround(prefix, text, at) {
  const limit = (RECALL_MAX_TOKENS - estimateTokens(prefix)) * 4;
  if (text.length <= limit) return prefix + text;
  return `${prefix}${windowAround(text, at, limit)}
[entry truncated at ${RECALL_MAX_TOKENS} tokens around the match \u2014 the full entry is longer. Search for an exact phrase from another part of it to read that part.]`;
}
function windowAround(text, pos, chars) {
  if (text.length <= chars) return text;
  if (pos === -1) return `${text.slice(0, chars)}
[entry truncated]`;
  const start = Math.max(0, Math.min(Math.floor(pos - chars / 2), text.length - chars));
  const end = start + chars;
  return `${start > 0 ? "\u2026 " : ""}${text.slice(start, end)}${end < text.length ? " \u2026" : ""}`;
}
var SNIPPET_CHARS = 900;
function snippet(text, pos) {
  return windowAround(text, pos, SNIPPET_CHARS);
}
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}
function entryLabel(entry) {
  if (entry.type === "compaction") return "summary";
  if (entry.type === "branch_summary") return "branch summary";
  if (entry.type !== "message") return entry.type;
  switch (entry.message.role) {
    case "toolResult":
      return "tool result";
    case "bashExecution":
      return "bash";
    default:
      return entry.message.role;
  }
}
function entryText(entry, resultsByCallId) {
  switch (entry.type) {
    case "message": {
      const message = entry.message;
      switch (message.role) {
        case "user":
          return typeof message.content === "string" ? message.content : textOfParts(message.content);
        case "assistant": {
          const parts = [];
          for (const part of message.content) {
            if (part.type === "text") parts.push(part.text);
            else if (part.type === "toolCall" && part.name !== RECALL_TOOL_NAME) {
              parts.push(`toolCall ${part.name} ${JSON.stringify(part.arguments)}`);
              const result = resultsByCallId.get(part.id);
              if (result) parts.push(`result: ${textOfParts(result.content)}`);
            }
          }
          return parts.filter((text) => text !== "").join("\n");
        }
        case "toolResult":
          return message.toolName === RECALL_TOOL_NAME ? "" : textOfParts(message.content);
        case "bashExecution":
          return `${message.command}
${message.output}`;
        default:
          return "";
      }
    }
    case "compaction":
      return entry.summary;
    case "branch_summary":
      return entry.summary;
    default:
      return "";
  }
}
function textOfParts(parts) {
  return parts.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}

// ../nix/store/a2mzaapx3y947d8l3rgv43nr2xs9v459-extractive-compaction/src/render.ts
var RECALL_LINE = `This summary is a selection, not the whole conversation: the ${RECALL_TOOL_NAME} tool can search and read the complete original session on disk.`;
var FACTS_SHOWN_LIMIT = 8;
function renderFacts(facts) {
  const line = (label, names) => {
    if (names.length === 0) return [];
    const shown2 = names.slice(-FACTS_SHOWN_LIMIT);
    const more = names.length - shown2.length;
    return [`[${label}] ${shown2.join(", ")}${more > 0 ? `, +${more} more` : ""}`];
  };
  return [
    ...line("skills used", facts.skills),
    ...line("files read", facts.filesRead),
    ...line("files edited", facts.filesEdited)
  ];
}

// ../nix/store/a2mzaapx3y947d8l3rgv43nr2xs9v459-extractive-compaction/src/paragraphs.ts
var FENCE_RE = /^\s*```/;
function splitIntoParagraphs(text) {
  const paragraphs = [];
  let current = [];
  const flush = () => {
    const joined = current.map((line) => line.trim()).join(" ").trim();
    if (joined !== "") paragraphs.push(joined);
    current = [];
  };
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      flush();
      const fence = [line];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        fence.push(lines[i]);
        i++;
      }
      if (i < lines.length) fence.push(lines[i]);
      paragraphs.push(fence.join("\n"));
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return paragraphs;
}

// ../nix/store/a2mzaapx3y947d8l3rgv43nr2xs9v459-extractive-compaction/src/transcript.ts
var SKILL_RE = /<skill\b[^>]*>[\s\S]*?(?:<\/skill>|$)/g;
function oneLine(value) {
  return value.replace(/\s+/g, " ").trim();
}
function toolTarget(argumentsValue) {
  if (argumentsValue === null || typeof argumentsValue !== "object") return void 0;
  const args = argumentsValue;
  for (const key of ["path", "filePath", "file_path"]) {
    if (typeof args[key] === "string") return oneLine(args[key]);
  }
  if (typeof args.command === "string") return oneLine(args.command).slice(0, 200);
  return void 0;
}
function userText(text, entryId) {
  if (text.trimStart().startsWith("<system_reminder>")) return [];
  const units = [];
  let cursor = 0;
  for (const match of text.matchAll(SKILL_RE)) {
    units.push(...prose("user", text.slice(cursor, match.index), entryId));
    const name = /\bname="([^"]+)"/.exec(match[0])?.[1];
    units.push({ speaker: "tool", text: name ? `skill ${name} loaded` : "skill loaded", entryId });
    cursor = (match.index ?? 0) + match[0].length;
  }
  units.push(...prose("user", text.slice(cursor), entryId));
  return units;
}
function prose(speaker, text, entryId) {
  if (text.trim() === "") return [];
  return splitIntoParagraphs(text).map((paragraph) => ({ speaker, text: paragraph, entryId }));
}
function messageUnits(message, entryId, toolCalls) {
  switch (message.role) {
    case "user":
      return typeof message.content === "string" ? userText(message.content, entryId) : message.content.flatMap((part) => part.type === "text" ? userText(part.text, entryId) : []);
    case "assistant": {
      const units = [];
      for (const part of message.content) {
        if (part.type === "text") units.push(...prose("assistant", part.text, entryId));
        else if (part.type === "toolCall") toolCalls.set(part.id, { name: part.name, arguments: part.arguments });
      }
      return units;
    }
    case "toolResult": {
      const pending = toolCalls.get(message.toolCallId);
      toolCalls.delete(message.toolCallId);
      const name = message.toolName || pending?.name || "tool";
      const target = toolTarget(pending?.arguments);
      const text = `${name}${target ? ` ${target}` : ""}${message.isError ? " failed" : ""}`;
      return [{ speaker: "tool", text, entryId }];
    }
    // Bash executions, extension messages, summaries, and unknown roles (session
    // files contain "system" messages, for example) add no unit.
    default:
      return [];
  }
}
function extractUnits(entries) {
  const toolCalls = /* @__PURE__ */ new Map();
  const units = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    units.push(...messageUnits(entry.message, entry.id, toolCalls));
  }
  return units;
}
function isCandidateSpeaker(speaker) {
  return speaker !== "tool";
}

// ../nix/store/a2mzaapx3y947d8l3rgv43nr2xs9v459-extractive-compaction/src/summary.ts
var CARRY_BUDGET_TOKENS = 12e3;
var SHOWN_CHARS = 4e3;
function flatten(text) {
  return text.replace(/\s+/g, " ").trim();
}
function shown(text) {
  const flat = flatten(text);
  return flat.length <= SHOWN_CHARS ? flat : `${flat.slice(0, SHOWN_CHARS)} \u2026 [${flat.length - SHOWN_CHARS} more chars]`;
}
var KEPT_TAIL_MARKER = "=== KEPT TAIL: everything below this line stays in the context unchanged ===";
var TRANSCRIPT_HEADER = [
  "This is a conversation between a user and a coding agent, prepared for compaction.",
  "Compaction replaces everything above the kept-tail line with a short summary that quotes selected paragraphs word for word. Everything below that line stays in the agent's context unchanged.",
  'Ids in brackets, such as [p12], mark the paragraphs that the summary can quote. A line that starts with "tool:" names a tool call and its target; its output is left out. Long paragraphs are shortened.'
].join("\n");
function buildTranscript(carried, before, tail) {
  const key = (line2) => `${line2.speaker}\0${flatten(line2.text)}`;
  const latest = /* @__PURE__ */ new Map();
  const items = [...carried, ...before];
  items.forEach((item, index) => {
    if (isCandidateSpeaker(item.speaker) && flatten(item.text) !== "") latest.set(key(item), index);
  });
  const candidates = [];
  const lines = [TRANSCRIPT_HEADER, ""];
  const line = (item, index) => {
    if (latest.get(key(item)) !== index) return `${item.speaker}: ${shown(item.text)}`;
    const id = `p${candidates.length}`;
    candidates.push({ id, speaker: item.speaker, text: item.text });
    return `[${id}] ${item.speaker}: ${shown(item.text)}`;
  };
  if (carried.length > 0) {
    lines.push("=== EARLIER SUMMARY: paragraphs kept by the previous compaction ===");
    carried.forEach((item, index) => lines.push(line(item, index)));
    lines.push("", "=== CONVERSATION SINCE THE EARLIER SUMMARY ===");
  }
  before.forEach((item, index) => lines.push(line(item, carried.length + index)));
  lines.push("", KEPT_TAIL_MARKER);
  for (const item of tail) lines.push(`${item.speaker}: ${shown(item.text)}`);
  return { input: lines.join("\n"), candidates };
}
function keepQuestion(id) {
  return `Must paragraph [${id}] stay in the summary so that the agent can continue the work correctly after compaction? Yes if it says something the agent still needs that the kept tail does not repeat: the user's goal or task, a rule, preference, or constraint that is still in force, a decision and its reason, an open question or problem, a correction of something earlier, or a fact, result, or finished piece of work that later work depends on. No if it only narrates or plans the next step, greets, acknowledges, or checks status, if the kept tail repeats it, or if a later message replaced, undid, or resolved it.`;
}
function lineTokens(line) {
  return Math.ceil(renderLine(line).length / 4);
}
function renderLine(line) {
  return `- [${line.speaker}] ${flatten(line.text)}`;
}
function selectLines(candidates, probabilities, budget) {
  const ranked = candidates.map((candidate, order) => ({ candidate, order, probability: probabilities.get(candidate.id) ?? 0 })).sort((a, b) => b.probability - a.probability || b.order - a.order);
  const kept = /* @__PURE__ */ new Set();
  let remaining = budget;
  for (const { candidate, order } of ranked) {
    const tokens = lineTokens(candidate);
    if (tokens > remaining) continue;
    kept.add(order);
    remaining -= tokens;
  }
  return candidates.filter((_, order) => kept.has(order)).map(({ speaker, text }) => ({ speaker, text }));
}
function renderSummary(lines, facts = EMPTY_FACTS) {
  return [
    RECALL_LINE,
    ...renderFacts(facts),
    ...lines.length > 0 ? ["## Kept from the conversation", ...lines.map(renderLine)] : []
  ].join("\n");
}
var FACTS_LINE_RE = /^\[(?:skills used|files read|files edited)\] /;
function summaryParagraphs(summary) {
  const paragraphs = [];
  let current = [];
  const flush = () => {
    const text = current.join(" ").trim();
    if (text !== "") paragraphs.push(text);
    current = [];
  };
  for (const line of summary.split("\n")) {
    const trimmed = line.trim();
    const item = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(trimmed);
    if (trimmed === "" || trimmed.startsWith("#") || trimmed === RECALL_LINE || FACTS_LINE_RE.test(trimmed)) {
      flush();
    } else if (item) {
      flush();
      current.push(item[1]);
    } else {
      current.push(trimmed);
    }
  }
  flush();
  return paragraphs;
}
function isSummaryLine(value) {
  if (value === null || typeof value !== "object") return false;
  const { speaker, text } = value;
  return typeof text === "string" && (speaker === "user" || speaker === "assistant" || speaker === "summary");
}
function previousCompaction(branchEntries) {
  for (let index = branchEntries.length - 1; index >= 0; index--) {
    const entry = branchEntries[index];
    if (entry.type !== "compaction") continue;
    const kept = branchEntries.findIndex((candidate) => candidate.id === entry.firstKeptEntryId);
    const details = entry.details;
    const lines = Array.isArray(details?.lines) && details.lines.every(isSummaryLine) ? details.lines.map(({ speaker, text }) => ({ speaker, text })) : summaryParagraphs(entry.summary).map((text) => ({ speaker: "summary", text }));
    const names = (value) => Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
    const facts = details?.facts ?? (details && (details.readFiles || details.modifiedFiles) ? { skills: [], filesRead: names(details.readFiles), filesEdited: names(details.modifiedFiles) } : void 0);
    return {
      startAtEntryId: branchEntries[kept >= 0 ? kept : index + 1]?.id,
      lines,
      facts
    };
  }
  return void 0;
}

// ../nix/store/a2mzaapx3y947d8l3rgv43nr2xs9v459-extractive-compaction/src/extension.ts
var execFileAsync = promisify(execFile);
var PROXY_KEY_ENV = "PI_PROXY_API_KEY";
async function devxToken() {
  const { stdout } = await execFileAsync("devx", ["llm-gateway", "print-token", "--key"]);
  return stdout.trim();
}
async function proxyToken(env = process.env, fallback = devxToken) {
  const key = env[PROXY_KEY_ENV]?.trim();
  return key ? key : fallback();
}
var CONFIG_FILENAME = "extractive-compaction.json";
function parseCarryBudget(raw) {
  if (raw === void 0 || raw.trim() === "") {
    return { budget: CARRY_BUDGET_TOKENS };
  }
  const fallback = (reason) => ({
    budget: CARRY_BUDGET_TOKENS,
    warning: `${CONFIG_FILENAME}: ${reason} \u2014 using the default carry budget (${CARRY_BUDGET_TOKENS} tokens).`
  });
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return fallback(`invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fallback("expected a JSON object");
  }
  const value = parsed.carryBudgetTokens;
  if (value === void 0) return { budget: CARRY_BUDGET_TOKENS };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return fallback(`carryBudgetTokens must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return { budget: value };
}
function resolveCarryBudget(ctx) {
  if (!ctx.isProjectTrusted()) return { budget: CARRY_BUDGET_TOKENS };
  let raw;
  try {
    raw = readFileSync(join(ctx.cwd, CONFIG_DIR_NAME, CONFIG_FILENAME), "utf8");
  } catch {
    return { budget: CARRY_BUDGET_TOKENS };
  }
  return parseCarryBudget(raw);
}
async function compactSession(event, client, notify, options) {
  if (event.signal.aborted) return void 0;
  if (event.customInstructions) return void 0;
  const { preparation, branchEntries } = event;
  try {
    const previous = previousCompaction(branchEntries);
    const startIndex = previous?.startAtEntryId === void 0 ? 0 : Math.max(0, branchEntries.findIndex((entry) => entry.id === previous.startAtEntryId));
    const cutIndex = branchEntries.findIndex((entry) => entry.id === preparation.firstKeptEntryId);
    const cut = cutIndex === -1 ? branchEntries.length : cutIndex;
    const beforeEntries = branchEntries.slice(startIndex, cut);
    const { input, candidates } = buildTranscript(
      previous?.lines ?? [],
      extractUnits(beforeEntries),
      extractUnits(branchEntries.slice(cut))
    );
    const { probabilities, stats } = candidates.length === 0 ? { probabilities: /* @__PURE__ */ new Map(), stats: { requests: 0, retries: 0, refusals: 0, billedInputTokens: 0 } } : await askPredicates(
      input,
      candidates.map((candidate) => ({ name: candidate.id, instructions: keepQuestion(candidate.id) })),
      client,
      event.signal
    );
    if (event.signal.aborted) return void 0;
    if (stats.retries > 0) {
      notify?.(`The decisions endpoint failed ${stats.retries} times during compaction; retries continued.`, "warning");
    }
    const lines = selectLines(candidates, probabilities, options?.carryBudgetTokens ?? CARRY_BUDGET_TOKENS);
    const facts = mergeFacts(previous?.facts, deriveFacts(messagesOf(beforeEntries)));
    return {
      compaction: {
        summary: renderSummary(lines, facts),
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        details: { lines, facts, decisions: { ...stats, candidates: candidates.length, inputChars: input.length } }
      }
    };
  } catch (error) {
    if (event.signal.aborted) return void 0;
    const message = error instanceof Error ? error.message : String(error);
    notify?.(`Compaction failed: ${message} \u2014 falling back to Pi's built-in compaction.`, "warning");
    return void 0;
  }
}
function messagesOf(entries) {
  return entries.filter((entry) => entry.type === "message").map((entry) => entry.message);
}
function extension_default(pi) {
  registerCompaction(pi);
}
function registerCompaction(pi, options = {}) {
  const client = options.client ?? createDecisionsClient(() => proxyToken(), options.headers);
  pi.registerTool({
    name: RECALL_TOOL_NAME,
    label: "Recall",
    description: RECALL_DESCRIPTION.tool,
    parameters: Type.Object({
      query: Type.String({ description: RECALL_DESCRIPTION.query }),
      page: Type.Optional(Type.Number({ description: RECALL_DESCRIPTION.page }))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return {
        content: [{ type: "text", text: recall(ctx.sessionManager.getEntries(), params) }],
        details: {}
      };
    }
  });
  pi.on("session_before_compact", async (event, ctx) => {
    if (event.signal.aborted) return void 0;
    const { budget, warning } = resolveCarryBudget(ctx);
    if (warning) ctx.ui.notify(warning, "warning");
    return compactSession(event, client, (message, type) => ctx.ui.notify(message, type), {
      carryBudgetTokens: budget
    });
  });
}
export {
  PROXY_KEY_ENV,
  compactSession,
  extension_default as default,
  parseCarryBudget,
  proxyToken,
  registerCompaction,
  resolveCarryBudget
};
