# subagent

A Pi extension for isolated, background-first subagents.

## What it does

- starts delegated work in persistent `pi --mode rpc` child processes
- returns from `subagent_start` after a bounded startup handshake, not after the task finishes
- exposes the child’s authoritative Pi session path, captured **Pi effective system prompt** path, and result Markdown path when a result exists
- reports actual model and thinking from child RPC `get_state`, rather than claiming the requested values were used
- labels non-empty results as `final` only for successful completion and as `partial` for killed/error children
- supports detailed inspection, bounded waiting, native Pi steering, and deadline-driven termination
- keeps only a bounded in-memory handle list; clearing handles never deletes session, prompt, or result artifacts

Each child runs in a private directory below Pi agent data (`<agent-dir>/sessions/subagents/<id>/`, permissions `0700`). Prompt and result sidecars use `0600` permissions. The session path returned by `get_state.sessionFile` is authoritative even before its JSONL exists. Pi may create that file only after it persists the first assistant message, so an early failure or kill can legitimately leave **no persisted transcript yet**.

## Tools

- `subagent_start`
  - only use when the user explicitly asks to delegate work
  - starts one background child with `{ agent?, name?, task, cwd?, model?, thinking?, tools?, systemPrompt? }`
  - returns the ID, PID, actual model/thinking, allocated session path, prompt path, and timestamps after startup succeeds
  - nested delegation is blocked
- `subagent_list`
  - accepts `{ includeFinished?: boolean }`, defaulting to `true`
  - returns compact retained handles with actual model/thinking and artifact paths
- `subagent_status`
  - accepts `{ id }`
  - returns detailed lifecycle, requested versus actual model/thinking, activity, usage, errors, artifact paths, and `resultKind` (`none`, `final`, or `partial`)
- `subagent_wait`
  - accepts exactly one target: `{ id, timeoutSeconds }` or `{ all: true, timeoutSeconds }`
  - `timeoutSeconds` is required, finite, and at least one second
  - always returns `{ outcome: "completed" | "timedOut" | "canceled", handles }`
  - timeouts and cancellation only stop waiting; they never kill children
  - `all:true` snapshots active handles when called
- `subagent_steer`
  - accepts `{ id, message }`
  - waits for Pi’s correlated RPC acknowledgement, not task completion
- `subagent_kill`
  - accepts `{ id }`
  - idempotently requests Pi abort, then escalates by deadline to process-group TERM/KILL on POSIX (with immediate-PID fallback)
  - preserves partial session, prompt, and result artifacts whenever they already exist

Use the shared `list_models` tool to discover exact accepted model IDs. There is no subagent-specific model-discovery tool.

## Model and thinking selection

For both values, precedence is:

1. per-call override
2. predefined-agent frontmatter
3. current parent session

The extension resolves and validates the selected model before spawning. It passes model and thinking separately to the child, then exposes the child’s actual `get_state.model` and `get_state.thinkingLevel` in every successful start/list/status record. An unavailable model or a startup `get_state` response without model or session path fails launch and cleans up the child.

## Starter and custom agents

This extension ships with `scout` and `reviewer`.

Agent lookup order is:

1. built-ins in `extensions/subagent/agents/`
2. user overrides in `~/.pi/agent/subagents/`
3. project overrides in the nearest `.pi/subagents/`

Higher-priority locations override lower ones by name. Existing active-tool inheritance is preserved; an agent or call can narrow it with `tools`.

```md
---
name: cheap-scout
description: Fast reconnaissance agent for broad code search
tools: read,grep,find,ls
model: anthropic/claude-haiku-4-5
thinking: low
---

You are a fast reconnaissance specialist...
```

`thinking` must be one of `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. Invalid selected-agent frontmatter is reported as a structured discovery diagnostic containing the agent, source path, field, and message; it is never silently ignored.

## Lifecycle

Children survive parent-turn abort, canceled waits, and wait timeouts. They end only when they complete, receive `subagent_kill` or `/subagents-kill-all`, or Pi emits the extension’s single `session_shutdown` lifecycle event (`quit`, `reload`, `new`, `resume`, or `fork`). There is no foreground run, swarm, or chain API: start sibling children independently, then explicitly inspect or bounded-wait before starting dependent work.

The child extension has no `update_status` tool and no progress-reporting prompt requirement. Activity comes from RPC/process events: current and last tool, streaming state, message output, usage, timestamps, errors, and exit state.

## Commands

- `/subagents` opens a TUI-only selectable inspector:
  - overview with metadata and paths
  - complete captured **Pi effective system prompt**, agent/source/source path provenance, and delegated task
  - read-only, live JSONL transcript that tolerates a partial final record
  - `s` opens steering input for active children
  - `x` confirms kill for active children
  - `c` clears only terminal handles and keeps all artifacts
- `/subagents-toggle` enables or disables the compact active-child widget
- `/subagents-kill-all` terminates all active children while retaining artifacts

When `ctx.mode !== "tui"`, `/subagents` prints a useful compact list with actual model/thinking and session paths. It never switches the parent session to inspect a child.

## Prompt-capture accuracy

The prompt sidecar is labeled **Pi effective system prompt** and is captured in the child at `agent_start` using `ctx.getSystemPrompt()`, after composed `before_agent_start` rules. A later `before_provider_request` hook can theoretically alter provider wire payloads, so the sidecar is not represented as an exact provider-wire capture.
