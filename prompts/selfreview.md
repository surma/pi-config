---
description: Post-edit cleanup pass — three specialist agents review recent changes for reuse, quality, and efficiency, then fix issues directly
---
Review all changed files for reuse, quality, and efficiency. Fix any issues found.

Optional extra context or scope hint: $@

## Phase 1: Identify changes

Run `git diff` (or `git diff HEAD` if there are staged changes) to see what changed. If there are no git changes, review the most recently modified files that the user mentioned or that you edited earlier in this conversation.

## Phase 2: Launch three review agents in parallel

Use the subagent tool with the `tasks` parameter to launch all three agents concurrently in a single `subagent_run` call. Pass each agent the full diff (or the file list, if the diff is huge) so it has the complete context. Prefer the built-in `reviewer` agent; otherwise launch ad hoc read-only review subagents.

Each agent must attach a suggested severity rating from 1-10 to every finding (1 = trivial nit, 10 = critical / data loss / security breach / production outage), with a one-clause justification. The TLA treats this as a suggestion, not a final verdict. Each agent should sort its findings by suggested severity, highest first.

### Agent 1: Code reuse review

For each change:
1. **Search for existing utilities and helpers** that could replace newly written code. Look for similar patterns elsewhere in the codebase — common locations are utility directories, shared modules, and files adjacent to the changed ones.
2. **Flag any new function that duplicates existing functionality.** Suggest the existing function to use instead.
3. **Flag any inline logic that could use an existing utility** — hand-rolled string manipulation, manual path handling, custom environment checks, ad-hoc type guards, and similar patterns are common candidates.

### Agent 2: Code quality review

Review the same changes for hacky patterns:
1. **Redundant state**: state that duplicates existing state, cached values that could be derived, observers/effects that could be direct calls.
2. **Parameter sprawl**: adding new parameters to a function instead of generalizing or restructuring existing ones.
3. **Copy-paste with slight variation**: near-duplicate code blocks that should be unified with a shared abstraction.
4. **Leaky abstractions**: exposing internal details that should be encapsulated, or breaking existing abstraction boundaries.
5. **Stringly-typed code**: using raw strings where constants, enums (string unions), or branded types already exist in the codebase.
6. **Unnecessary JSX nesting**: wrapper Boxes/elements that add no layout value — check if inner component props (flexShrink, alignItems, etc.) already provide the needed behavior.
7. **Nested conditionals**: ternary chains (`a ? x : b ? y : ...`), nested if/else, or nested switch 3+ levels deep — flatten with early returns, guard clauses, a lookup table, or an if/else-if cascade.
8. **Unnecessary comments**: comments explaining WHAT the code does (well-named identifiers already do that), narrating the change, or referencing the task/caller — delete; keep only non-obvious WHY (hidden constraints, subtle invariants, workarounds).

### Agent 3: Efficiency review

Review the same changes for efficiency:
1. **Unnecessary work**: redundant computations, repeated file reads, duplicate network/API calls, N+1 patterns.
2. **Missed concurrency**: independent operations run sequentially when they could run in parallel.
3. **Hot-path bloat**: new blocking work added to startup or per-request/per-render hot paths.
4. **Recurring no-op updates**: state/store updates inside polling loops, intervals, or event handlers that fire unconditionally — add a change-detection guard so downstream consumers aren't notified when nothing changed. Also: if a wrapper function takes an updater/reducer callback, verify it honors same-reference returns (or whatever the "no change" signal is) — otherwise callers' early-return no-ops are silently defeated.
5. **Unnecessary existence checks**: pre-checking file/resource existence before operating (TOCTOU anti-pattern) — operate directly and handle the error.
6. **Memory**: unbounded data structures, missing cleanup, event listener leaks.
7. **Overly broad operations**: reading entire files when only a portion is needed, loading all items when filtering for one.

## Phase 3: Fix issues

Wait for all three agents to complete. Aggregate their findings and act as the TLA:

1. Assign a final severity rating /10 to each finding. Subagent suggestions are inputs — you make the call. When subagents disagree, pick the rating you can defend; do not just average. Override aggressively when a subagent over- or under-rates.
2. Sort by final severity, highest first. Break ties by blast radius, then by confidence.
3. Fix issues in severity order. High-severity findings must be addressed; low-severity findings (roughly ≤ 3/10) may be skipped if not worth the churn.
4. If a finding is a false positive, note it and skip — do not argue with it.

When done, briefly summarize what was fixed and what was skipped, with the final severity rating next to each item (or confirm the code was already clean).
