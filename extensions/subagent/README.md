# Subagent extension

This extension gives a parent Pi persistent child Pi processes through the Pi RPC protocol.

## Child processes

`subagent_start` launches a child with `pi --mode rpc`. The child receives the extension in `child.ts` and uses a private session directory. The parent sends prompts and control messages through stdin. The parent receives strict LF-delimited JSONL events through stdout.

Every child starts with `--offline` and `--approve`. The extension uses `devx pi` when an executable `devx` exists. The `PI_SUBAGENT_PI_BIN` environment variable can select another Pi executable for tests or development.

The child process remains alive after a run settles. The parent can send another prompt, steer the current run, interrupt a run, or terminate the process. A child process cannot start another delegated child.

The parent creates no terminal UI or screen-scraping transport. RPC process close is the only process-liveness signal. Termination sends RPC `abort`, then `SIGTERM`, then `SIGKILL` with bounded waits.

## Ownership and leases

The extension stores controller state below the configured Pi agent directory:

```text
<sessions>/subagents/controllers/<owner-key>/
  lease.json
  registry.json
```

The parent session file and session ID define the durable owner. A random process-wide controller ID identifies the live controller. A renewable lease grants mutation authority. A child ID identifies one logical child. A random incarnation identifies one child process instance.

A controller loads only registry entries for its exact owner. It does not adopt entries from another owner. A controller without a persisted parent session file and session ID does not create a lease or launch a child.

The lease expires after 30 seconds. Another controller can reclaim it after a five-second stale grace period. Renewal requires the exact existing owner and controller record. Renewal never recreates a missing lease or overwrites another controller.

The same controller ID survives a Pi reload. The global runtime map preserves live RPC transports while the replacement extension reloads its registry. A fresh process cannot adopt an unavailable child process. It marks such a registry entry stopped during reconciliation.

Each child checks its lease record every five seconds. A missing, corrupt, expired, or replaced record makes the child send `SIGTERM` to itself. The parent also terminates local children when it detects lease loss. This bounds child survival after a suspended controller.

## Storage

Each logical child uses this private directory:

```text
<agent-dir>/sessions/subagents/<child-id>/
  pi-effective-system-prompt.txt
  child-session.jsonl
  result.md
  runs/<run-id>/
    result.md
    result.json
```

The child captures the effective system prompt. The Pi session file supports resume after the child process stops. The compatibility `result.md` file mirrors the latest settled output.

Each run stores an immutable result pair. The Markdown file contains the exact output. The JSON file contains the run ID, outcome, incarnation, and settlement time. Concurrent publishers keep the first complete pair.

`subagent_result` reads one exact run. It never falls back to a newer or latest run. Empty output remains a valid result with its actual outcome.

## RPC protocol

The transport uses strict LF-only JSONL framing. It strips one optional trailing carriage return from each record. It uses `StringDecoder` so a UTF-8 character can span stream chunks. Unicode line separators inside JSON strings do not split records.

Requests receive generated IDs. The transport resolves responses by ID, so responses can arrive out of order. Events remain asynchronous and pass to the lifecycle dispatcher.

The parent handles these RPC commands:

- `get_state` captures the child session and model state.
- `prompt` starts the initial or next child run.
- `follow_up` queues another child run while a run is active. When the child is idle, the parent sends `prompt` because native `follow_up` only queues active runs.
- `steer` queues guidance during a run. When the child is idle, the parent sends `prompt` for the same reason.
- `abort` cooperatively stops the current run.

The child extension persists exact output on `agent_settled`. The parent also persists a fallback result from the observed lifecycle state. The child process does not shut down when a run settles.

## Lifecycle and notifications

The lifecycle tracks process state separately from run state. A settled run returns the live child to idle. A later run receives a larger monotonic run ID. A process close stops the logical child and preserves its artifacts.

Settlement notifications batch nearby results. Each notification includes the child ID, exact run ID, outcome, incarnation, and a short preview. The notification starts a parent follow-up turn. Use `subagent_result` for exact output. Do not poll `subagent_status` or wait with sleep commands.

The extension suppresses notifications after shutdown, lease loss, or explicit child termination. It retains settled children until retention removes old stopped handles or `/subagents` clears them.

## Tools

The extension registers nine tools:

- `subagent_start {task, model, thinking, name?, cwd?, systemPrompt?}` starts a child with an explicit model and thinking level.
- `subagent_list {includeFinished?}` lists current and retained children.
- `subagent_status {id}` returns lifecycle, RPC, activity, usage, diagnostics, and artifact state.
- `subagent_result {id, runId}` returns one exact persisted result.
- `subagent_steer {id, message}` sends guidance during a child run.
- `subagent_follow_up {id, message}` queues another child run.
- `subagent_interrupt {id}` sends a cooperative abort while keeping the process alive.
- `subagent_kill {id}` terminates a child with bounded escalation.
- `subagent_resume {id, task?}` starts a new RPC incarnation from the saved child session.

The model and thinking fields are mandatory for `subagent_start`. Nested delegated children cannot call `subagent_start`.

## Commands

- `/subagents` opens the interactive inspector in TUI mode or prints summaries in other modes.
- `/subagents-toggle` toggles the compact active-child widget.
- `/subagents-kill-all` terminates all live children owned by the current controller.

The inspector shows lifecycle state, RPC readiness, live assistant text, tool activity, transcript history, and retained artifacts. It sanitizes untrusted text before rendering it.

## Resume

`subagent_resume` applies only to a stopped child with a nonempty saved session file. It keeps the logical child ID and creates a new incarnation. Before starting the new process, the parent scans numeric run directories. It reserves every existing numeric directory and starts above the highest one.

The new process starts its run counter from the prior logical cursor. A resume task starts the next run. Without a task, the resumed child starts idle.

A previous incarnation cannot mutate the resumed handle. The new process receives a new transport and a new process ID. The owner lease must remain available before resume starts.

## Verification

Run the deterministic suite from this directory:

```sh
PI_TEST_PACKAGE_DIR=/path/to/pi-0.84.1 ./test.sh
```

The suite covers lifecycle dispatch, result artifacts, settlement notifications, owner leases, registry isolation, strict RPC framing, correlated responses, bounded termination, launch arguments, all nine tools, resume, and the inspector.
