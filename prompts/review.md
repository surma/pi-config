---
description: Multi-model review swarm with TLA validation and deduplication
---
Review the following code, files, or context: $@

Use the subagent tool with the `tasks` parameter to run exactly one independent review swarm in parallel.

Before spawning subagents, if model overrides require exact ids, use `subagent_models` to resolve the closest exact available ids for these requested models. Resolve the ids once up front and note any substitutions you had to make:
- Anthropic: Claude Opus 4.6
- OpenAI: GPT 5.4
- Google: Gemini 3 Pro

Launch review subagents with the same review brief but different models. Prefer the built-in `reviewer` agent with per-call `model` overrides if available; otherwise launch ad hoc read-only review subagents.

Important TLA execution rules:
- Make a single `subagent_run({tasks:[...]})` call for the initial swarm.
- Do not spawn extra subagents just to reformat, summarize, shorten, compare, or break ties between reports. That is the TLA's job.
- Only launch a follow-up subagent if the user explicitly asks for more delegation, or if an initial slot fails for a technical reason before producing a usable review (for example: invalid model id, unavailable model, timeout, crash, or transport failure).
- If a slot fails technically, retry only that failed slot once and note it. Otherwise continue with the successful reports.

Each subagent should work independently and produce a thorough, high-signal code review that covers:
- bugs and correctness issues
- security issues
- missing edge cases or error handling
- maintainability problems
- worthwhile optimizations
- specific proposed fixes

Require each subagent to:
- cite concrete evidence with file paths and line numbers where possible
- explain why the issue matters
- avoid weak speculation
- clearly label uncertainty
- return at most 6 main findings, sorted by importance
- prefer fewer strong findings over many weak ones
- include a brief coverage note: files inspected, highest-risk areas checked, and anything notable they could not verify
- report docs/README/prompt contract mismatches only when those materials are in scope or the mismatch materially affects runtime or user expectations

After all subagents finish, act as the Top-Level Agent (TLA):
1. Aggregate all findings.
2. Validate each finding yourself by reading the relevant files and lines directly.
3. Discard anything unsupported, incorrect, or too speculative.
4. Group duplicate or substantially similar findings into a single merged issue.
5. Choose the best proposed fix across all subagents, or write a better one yourself if needed.
6. If the subagent reports are uneven, verbose, or differently formatted, normalize them yourself rather than asking more subagents.
7. Return only the grouped findings that survived validation.

Do not merely concatenate the subagent reports. Synthesize them.

Format the final answer as a grouped list. For each validated finding, use exactly this structure:

### <short issue description>
**Seen by**: Claude Opus 4.6, GPT 5.4, Gemini 3 Pro
**Evidence**: concise prose that cites affected files and line numbers and explains why the code is a real problem.

```js
// path/to/file:line-line
// minimal snippet(s), only what is needed to support the claim
```

**Best fix**: strongest fix chosen by the TLA.

Formatting rules:
- Do not include a `TLA validation` line. Anything unvalidated should not appear in the main list.
- Under `Seen by`, list only the subagents that actually reported the issue, as a comma-separated list. If only one saw it, list one. Do not use checkboxes.
- Under `Evidence`, cite precise files and line numbers and keep the rationale tight and specific.
- Include at least one minimal code snippet per finding when a code snippet will help substantiate the issue.
- Keep snippets short and focused; do not dump large unrelated blocks.
- Use docs/README snippets only for validated contract mismatches.

If no findings survive validation, say so plainly. Then optionally include a short `Unvalidated leads` section with the most notable discarded findings and why they were discarded.
