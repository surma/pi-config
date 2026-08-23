# Subagent extension

This extension gives a parent Pi persistent child Pi processes through the Pi RPC protocol.

## Child processes

`subagent_start` launches a child with `pi --mode rpc`. The child loads `child.ts` and uses a private session directory. The parent sends JSON commands through stdin. The parent receives strict LF-delimited JSONL events through stdout.

Every child starts with `--offline` and `--approve`. The extension uses `devx pi` when an executable `devx` exists. The `PI_SUBAGENT_PI_BIN` environment variable selects another Pi executable for tests or development.

The child process stays alive after a run settles. The parent can send another prompt, steer a current run, interrupt a run, or terminate the process. A child cannot start another delegated child.

The parent uses native Pi lifecycle events as the settlement authority:

- `agent_start` begins a low-level run.
- `agent_end` ends one low-level attempt. Pi can still retry, compact, or process queued messages.
- `agent_settled` marks the point where Pi will not continue the run automatically.

The parent does not treat `agent_end` as completion. A settled run returns the live child to idle. The process remains alive and can accept another run.

RPC responses confirm command acceptance, queueing, or handling. They do not confirm run completion. `subagent_start` waits at most one second for the child to expose run acceptance, then returns the current state. It does not wait for the model response.

Termination sends RPC `abort`, then `SIGTERM`, then `SIGKILL` with bounded waits. The extension has no watchdog that guesses whether a child stalled.

## Ownership and leases

The extension stores controller state below the configured Pi agent directory:

```text
<sessions>/subagents/controllers/<owner-key>/
  lease.json
  registry.json
```

The parent session file and session ID define the durable owner. A random process-wide controller ID identifies the live controller. A renewable lease grants mutation authority. A child ID identifies one logical child. A random incarnation identifies one child process instance.

A controller loads only registry entries for its exact owner. It does not adopt entries from another owner. A controller without a persisted parent session file and session ID does not create a lease or launch a child.

The lease expires after 30 seconds. Another controller can reclaim it after a five-second stale grace period. Renewal requires the exact owner and controller record. Renewal never recreates a missing lease or overwrites another controller.

The same controller ID survives a Pi reload. A process-wide runtime map preserves live RPC transports while the replacement extension reloads its registry. A fresh process cannot adopt an unavailable child. Reconciliation marks an unavailable alive entry as stopped.

Every event and close callback carries a runtime identity. The parent accepts a callback only when its runtime object and incarnation match the current handle. A replaced or stale process cannot mutate the current child state.

Each child checks its lease record every five seconds. A missing, corrupt, expired, or replaced record makes the child send `SIGTERM` to itself. The parent also terminates local children after lease loss.

## Storage and durable state

Each logical child uses this private directory:

```text
<agent-dir>/sessions/subagents/<child-id>/
  pi-effective-system-prompt.txt
  child-session.jsonl
```

The child captures the effective system prompt. The Pi session file is the authority for transcript inspection and resume. The controller registry stores process identity, ownership, diagnostics, the monotonic run cursor, the last settled run ID, settlement status, and caller output status.

The child does not persist a second copy of settled assistant output. The durable run cursor prevents a resumed process from reusing an earlier run ID. The parent does not scan output files to choose a next run ID.

## RPC protocol

The transport uses strict LF-only JSONL framing. It strips one optional trailing carriage return from each record. It uses `StringDecoder` so a UTF-8 character can span stream chunks. Unicode line separators inside JSON strings do not split records.

Requests receive generated IDs. The transport resolves responses by ID, so responses can arrive out of order. Events remain asynchronous and pass to the lifecycle dispatcher.

The parent sends these RPC commands:

- `get_state` captures the child session path and effective model state.
- `prompt` starts the initial or next child run.
- `follow_up` queues another run while a run is active. When the child is idle, the parent sends `prompt` because native `follow_up` queues only active runs.
- `steer` queues guidance during a run. When the child is idle, the parent sends `prompt` for the same reason.
- `abort` requests a cooperative abort.

A successful `abort` response means that Pi accepted the request. The child remains alive until native `agent_settled` reports the aborted run. The parent supports an abort settlement without a final assistant message.

## Lifecycle and process-close evidence

The lifecycle separates process state from run state. A successful, failed, or aborted native settlement updates `runOutcome`, `lastSettledRunId`, and `settlement.status` to `settled`. The process remains `alive` and the run becomes `idle`.

A process close before the current run settles updates `settlement.status` to `closed_without_settlement`. The status preserves the nullable exit code, exit signal, bounded stderr tail, bounded diagnostics, and final error. The parent does not emit a success, failure, or abort wake for a close without settlement.

An initial child close with no run stays `pending` for settlement status. A close after a settled run preserves `settled`. Explicit termination suppresses pending wakes for that child.

## Transcript inspection

`subagent_status` reads the child Pi session JSONL file. The transcript reader accepts complete LF-framed records only. It filters the transcript to user messages, assistant messages, and normalized error messages.

Each page uses a zero-based `messageOffset`. The default page size is three messages. The maximum page size is twenty messages. Each message is limited to 8 KiB. Each page is limited to 32 KiB of text.

The reader reports one of these statuses:

- `available`: the snapshot has valid complete records.
- `missing`: no session path exists, or the file does not exist.
- `incomplete`: the file has a non-empty trailing fragment without LF.
- `unreadable`: one or more complete records are malformed, or the file cannot be read.

The reader preserves a requested offset when the current page has no messages. A later append can then make that offset visible. Transcript text and file presence do not prove that a run settled.

## Caller output

`subagent_start` accepts an optional `outputPath`. A relative path resolves against the caller session current working directory, not the child working directory.

On settlement, the parent writes the final captured assistant text to that path without delaying event handling or wake queueing:

- Missing parent directories are created with mode `0700`.
- The output file uses mode `0600`.
- Empty text creates a valid empty file.
- An existing path returns `collision` and remains unchanged.
- A concurrent publisher returns `collision` and never overwrites the first file.
- Other filesystem errors return `failed` with a bounded error message.
- A same-directory temporary file is written and synced before exclusive hard-link publication.

The output status is independent of `runOutcome`. A failed or aborted run can still write caller output. Reusing a path for another settled run returns `collision`.

## Settlement wakes

For each accepted `agent_settled` run, the parent queues one non-durable steering wake. The queue accepts only `run_settled` records with outcome `succeeded`, `failed`, or `aborted`. It suppresses duplicate records by owner, child, incarnation, and run ID. It retries one failed send.

Each wake uses `triggerTurn: true` and `deliverAs: "steer"`. Its content is exactly:

```text
Subagent <id> reached idle after run <runId>. Check subagent_status with messages=3.
```

The custom message details include the direct owner session file, owner session ID, child ID, incarnation, run ID, event kind, outcome, and a `settlements` array containing that record. The queue sends records separately. It does not promise durability, recovery after process loss, or notification for process stalls or close events.

The parent queues the wake before optional registry persistence or caller output work. Shutdown, lease loss, and explicit child termination suppress unsent wakes.

## Tools

The extension registers eight tools:

- `subagent_start {task, model, thinking, name?, cwd?, systemPrompt?, outputPath?}` starts a child with an explicit model and thinking level. The response confirms acceptance only.
- `subagent_list {includeFinished?}` lists current and retained children.
- `subagent_status {id, messageOffset?, numMessages?}` returns bounded process and run diagnostics, settlement evidence, transcript pages, and caller output status.
- `subagent_steer {id, message}` accepts or queues guidance. The response does not mean completion.
- `subagent_follow_up {id, message}` accepts or queues another child run. The response does not mean completion.
- `subagent_interrupt {id}` accepts a cooperative abort while keeping the process alive.
- `subagent_kill {id}` terminates a child with bounded escalation.
- `subagent_resume {id, task?}` starts a new RPC incarnation from the saved child session.

The model and thinking fields are mandatory for `subagent_start`. Nested delegated children cannot call `subagent_start`.

The status details include `processState`, `runState`, `runOutcome`, `settlement.status`, `lastSettledRunId`, `exitCode`, `exitSignal`, `error`, `stderrTail`, `diagnostics`, transcript status and pages, and output path and status.

## Commands and inspector

- `/subagents` opens the interactive inspector in TUI mode or prints summaries in other modes.
- `/subagents-toggle` toggles the compact active-child widget.
- `/subagents-kill-all` terminates all live children owned by the current controller.

The inspector shows lifecycle state, RPC readiness, live assistant text, tool activity, transcript history, settlement evidence, process-close evidence, and caller output state. It sanitizes untrusted text before rendering it.

## Resume

`subagent_resume` applies only to a stopped child with a nonempty saved session file. It keeps the logical child ID and creates a new incarnation. The new process starts its run counter from the durable logical cursor. A resume task starts the next run. Without a task, the resumed child starts idle.

The previous incarnation cannot mutate the resumed handle. The new process receives a new transport and process ID. The owner lease must remain available before resume starts.

## Verification

Run the deterministic suite from this directory:

```sh
PI_TEST_PACKAGE_DIR=/path/to/pi-0.84.1 ./test.sh
```

The suite covers lifecycle dispatch, transcript projection and pagination, caller output publication, settlement notifications, owner leases, registry isolation, strict RPC framing, correlated responses, bounded termination, launch arguments, all eight tools, reload, resume, process-close evidence, abort acceptance, and the inspector.
