# subagent

A pi extension for isolated subagents and easy swarms.

## What it does

- runs delegated work in separate `pi --mode rpc` subprocesses
- injects a child-only `update_status(message)` tool
- shows active/recent subagents in a persistent widget
- supports:
  - one-off subagent runs
  - small parallel swarms
  - sequential chains
  - background start/list/wait/kill flows

## Tools

- `subagent_run`
  - single predefined: `{ agent, task }`
  - single ad hoc: `{ task, systemPrompt?, tools?, model? }`
  - parallel swarm: `{ tasks: [{ agent?, task, systemPrompt?, tools?, model? }, ...] }`
  - chain: `{ chain: [{ agent?, task, systemPrompt?, tools?, model? }, ...] }`
- `subagent_start`
- `subagent_list`
- `subagent_wait`
- `subagent_kill`

## Starter agents

This extension ships with:

- `scout`
- `planner`
- `worker`
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

## Commands

- `/subagents` shows tracked subagent status in a notification
- `/subagents-toggle` shows/hides the persistent subagent widget
- `/subagents-kill-all` aborts all running subagents

## Notes

- children are ephemeral: they auto-exit after finishing their delegated task
- this is intentionally **subagents + easy swarms**, not a full agent-team system
- the widget is shown by default, but can be hidden with `/subagents-toggle`
- widget/list ordering is stable by creation time so live updates stay in place
- `subagent_run` allows up to 64 parallel tasks, while execution concurrency remains capped separately
