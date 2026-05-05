---
description: Multi-model review swarm with TLA validation and deduplication
---
Review the following code, files, or context: $@

Use the subagent tool with the `tasks` parameter to run exactly one independent review swarm in parallel.

Before spawning subagents, if model overrides require exact ids, use `subagent_models` to resolve the closest exact available ids for these requested models. Resolve the ids once up front and note any substitutions you had to make:
- Anthropic: Claude Opus 4.7
- OpenAI: GPT 5.5
- Google: Gemini 3.1 Pro

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
- claims that depend on surrounding reality — named components, wire paths, config knobs, endpoints, types, files, APIs, versions — and whether the surrounding context confirms them or they are unverified assumptions

Require each subagent to:
- cite concrete evidence with file paths and line numbers where possible
- explain why the issue matters
- avoid weak speculation
- clearly label uncertainty
- return at most 6 main findings, sorted by suggested severity (highest first)
- prefer fewer strong findings over many weak ones
- attach a suggested severity rating from 1-10 to each finding (1 = trivial nit, 10 = critical / data loss / security breach / production outage). Treat this as a suggestion to the TLA, not a final verdict. Briefly justify the rating in one short clause.
- include a brief coverage note: files inspected, highest-risk areas checked, and anything notable they could not verify
- for non-trivial claims that depend on context outside the artifact (referenced files, components, APIs, config, wire paths), attempt to verify the claim against the referenced material; if the material is unavailable or out of scope, flag the claim as an unverified assumption rather than implicitly accepting it. Flag unverified assumptions only when the assumption is load-bearing for the artifact's claim — do not list every type or symbol the reviewer didn't trace.
- when the artifact distinguishes versions, phases, branches, or current-vs-future state, audit present-tense claims for tense-alignment — present-tense descriptions of behavior that is actually future / planned / phase-gated are findings
- when the artifact under review IS a spec, design doc, README, or contract, treat consistency-with-the-surrounding-codebase as in-scope by default — those artifacts ARE claims about the world. When the artifact under review is code, suppress unrelated doc drift unless the mismatch materially affects runtime or user expectations.

Look specifically for these patterns when relevant:
- **Reuse**: new functions/inline logic that duplicates an existing utility in the codebase. Search adjacent files and shared/util directories before flagging code as fine.
- **Redundant state**: state that duplicates other state, cached values that could be derived, observers/effects that could be direct calls.
- **Parameter sprawl**: new parameters bolted onto a function instead of restructuring.
- **Copy-paste with variation**: near-duplicate blocks that want a shared abstraction.
- **Stringly-typed code**: raw strings where existing constants/enums/branded types apply.
- **Nested conditionals 3+ deep**: flatten with early returns or lookup tables.
- **No-op updates**: state/store writes in loops or handlers without change-detection; updater callbacks that don't honor same-reference returns.
- **TOCTOU existence checks**: pre-checking file/resource existence instead of operating and handling the error.
- **Hot-path bloat**: blocking work added to startup or per-request/per-render paths.
- **What-comments**: comments restating what the code does. Keep only non-obvious why.

After all subagents finish, act as the Top-Level Agent (TLA):
1. Aggregate all findings.
2. Validate each finding yourself by reading the relevant files and lines directly.
3. Discard anything unsupported, incorrect, or too speculative.
4. Group duplicate or substantially similar findings into a single merged issue.
5. Choose the best proposed fix across all subagents, or write a better one yourself if needed.
6. If the subagent reports are uneven, verbose, or differently formatted, normalize them yourself rather than asking more subagents.
7. Assign a final severity rating /10 to each surviving finding. Subagent suggestions are inputs — you make the call. When subagents disagree, pick the rating you can defend; do not just average. Override aggressively when a subagent over- or under-rates.
8. Sort the final list by severity, highest first. Break ties by blast radius, then by confidence.
9. Return only the grouped findings that survived validation.

Do not merely concatenate the subagent reports. Synthesize them.

Format the final answer as a grouped list. For each validated finding, use exactly this structure:

---

### <index>. [<severity>/10] <short issue description>
**Seen by**: Claude Opus 4.6, GPT 5.4, Gemini 3 Pro
**Severity**: <final TLA rating>/10 (suggested: Claude <n>, GPT <n>, Gemini <n>) — one-line rationale.
**Evidence**: concise prose that cites affected files and line numbers and explains why the code is a real problem.

```js
// path/to/file:line-line
// minimal snippet(s), only what is needed to support the claim
```

**Best fix**: strongest fix chosen by the TLA.

---

Formatting rules:
- Do not include a `TLA validation` line. Anything unvalidated should not appear in the main list.
- Under `Seen by`, list only the subagents that actually reported the issue, as a comma-separated list. If only one saw it, list one. Do not use checkboxes.
- Under `Evidence`, cite precise files and line numbers and keep the rationale tight and specific.
- Include at least one minimal code snippet per finding when a code snippet will help substantiate the issue.
- Keep snippets short and focused; do not dump large unrelated blocks.
- Use docs/README snippets only for validated contract mismatches.
- Every item must have a number in the header so that the user can refer to items easily by number.
- The header severity (`[<severity>/10]`) is the TLA's final rating, not an average of subagent suggestions.
- Under `Severity`, only list suggested ratings from subagents that actually reported the issue. If a subagent did not raise it, omit them from the suggested list.
- The final list must be ordered by severity, highest first.

If no findings survive validation, say so plainly. Then optionally include a short `Unvalidated leads` section with the most notable discarded findings and why they were discarded.
