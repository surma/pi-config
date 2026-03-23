# subagent

A pi extension for isolated subagents and easy swarms.

## What it does

- runs delegated work in separate session-isolated `pi --mode rpc` subprocesses while loading the usual extensions/plugins
- injects a child-only `update_status(message)` tool
- inherits the parent session's active tool set, then optionally narrows it per agent/task
- shows active subagents in a widget and keeps recent handles available via commands
- supports:
  - one-off subagent runs
  - small parallel swarms
  - sequential chains
  - background start/list/wait/kill flows

## Tools

- `subagent_models`
  - list the exact model ids accepted by subagent model overrides in the current session
- `subagent_run`
  - only for cases where the user explicitly asks for subagent delegation
  - unavailable from inside a delegated subagent (nested delegation is blocked)
  - single predefined: `{ agent, task }`
  - single ad hoc: `{ task, systemPrompt?, tools?, model? }`
  - parallel swarm: `{ tasks: [{ agent?, task, systemPrompt?, tools?, model? }, ...] }`
  - chain: `{ chain: [{ agent?, task, systemPrompt?, tools?, model? }, ...] }`
- `subagent_start`
  - only for cases where the user explicitly asks for a background subagent
  - unavailable from inside a delegated subagent (nested delegation is blocked)
- `subagent_list`
- `subagent_wait`
- `subagent_kill`

## Starter agents

This extension ships with:

- `scout`
- `reviewer`

## Custom agents

Agent files are Markdown with YAML frontmatter.

Lookup order:

1. built-in agents in this extension directory
2. user overrides in `~/.pi/agent/subagents/`
3. project overrides in nearest `.pi/subagents/`

Higher-priority locations override lower ones by name.

### Example

```md
---
name: cheap-scout
description: Fast reconnaissance agent for broad code search
tools: read,grep,find,ls
model: anthropic/claude-haiku-4-5
---

You are a fast reconnaissance specialist...
```

## Ad hoc subagents

You can also spawn a subagent without a predefined agent file by omitting `agent` and passing a task with optional overrides.

Example shape:

```json
{
  "task": "Review the API surface and summarize it",
  "systemPrompt": "You are a concise API review specialist.",
  "tools": ["read", "grep", "find", "ls"],
  "model": "openai/gpt-4.1-nano"
}
```

## Different models per subagent

Yes.

There are two ways to control the child model:

1. `model:` in the predefined agent frontmatter
2. `model` in the tool call itself

Per-call `model` wins over the predefined agent’s `model`.

If neither is provided, the child inherits the **current parent session model**.

Children stay session-isolated (`--no-session`) but now load the same extensions/plugins as the parent environment.

Use `subagent_models` to inspect the exact child model ids accepted by subagent model overrides before setting one.
Unknown or unavailable override models are rejected before the subagent is spawned.
Model overrides should use exact ids returned by `subagent_models` rather than fuzzy or fallback matches.

## Commands

- `/subagents` opens a scrollable overlay with tracked subagent status (or prints a summary without UI)
- `/subagents-toggle` enables/disables the persistent subagent widget for active subagents
- `/subagents-kill-all` aborts all running subagents

## Notes

- children are ephemeral: they auto-exit after finishing their delegated task
- aborting the parent agent also aborts all active subagents
- aborting `subagent_wait` stops waiting but does not kill the background subagent(s)
- this is intentionally **subagents + easy swarms**, not a full agent-team system
- the widget is shown by default for active subagents, but can be disabled with `/subagents-toggle`
- widget/list ordering is stable by reverse creation time so the newest subagents stay visible at the top
- `subagent_run` allows up to 64 parallel tasks, while execution concurrency remains capped separately
