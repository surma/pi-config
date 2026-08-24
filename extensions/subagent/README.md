# Subagent extension

This extension gives a parent Pi persistent child Pi processes through the native Pi RPC protocol.

## Child processes

`subagent_start` launches `pi --mode rpc`. The child loads `child.ts` and uses a private session directory.

The child starts with `--offline` and `--approve`. Set `PI_SUBAGENT_PI_BIN` when tests or development need a specific Pi executable.

The child process stays alive after a run settles. The parent can send another prompt, steer a current run, interrupt a run, or terminate the process.

A child cannot start another delegated child.

Native lifecycle events define run state:

- `agent_start` begins a low-level run.
- `agent_end` ends one low-level attempt.
- `agent_settled` marks the point where Pi will not continue the run automatically.

The parent does not treat `agent_end` as completion. A settled run returns the child to idle, while the process remains alive.

Parent tool handlers must preserve Pi cancellation through every child wait. They must race unbounded storage and process waits against that signal, then use bounded cleanup.

## Child-extension health

The child extension publishes an out-of-band health marker after its startup hook registers.

The default marker path is:

```text
<session-dir>/child-extension-health-<incarnation>.marker
```

The parent can override that path with `PI_SUBAGENT_HEALTH_PATH`. The parent must use a unique path for each child incarnation.

The marker contains exactly these UTF-8 bytes:

```text
pi-subagent-child-extension-ready/v1
```

The file includes one final line-feed character. The marker has a strict 128-byte read bound and uses mode `0600` under a mode `0700` directory.

The marker does not use child stdout. It therefore cannot corrupt the RPC JSONL stream.

The parent must verify the exact marker after RPC process startup and before it sends the first prompt. A missing, malformed, oversized, or unreadable marker means that startup failed.

The child bounds marker file operations and cancels them during session shutdown. The parent must preserve the same startup deadline when it waits for health.

A successful `get_state` response does not prove that `child.ts` loaded. The parent must check both health and RPC readiness.

## Ownership and leases

The process-local controller owns live child transports and runtime state.

A persisted parent session is optional. It adds a registry and lease for durable status and resume, but it does not gate ephemeral child launch.

When durable ownership exists, the extension stores its state below the configured Pi agent directory:

```text
<sessions>/subagents/controllers/<owner-key>/
  lease.json
  registry.json
```

A child ID identifies one logical child. A random incarnation identifies one child process instance.

A durable controller loads only registry entries for its exact owner. An ephemeral controller keeps live ownership in memory and does not promise recovery after process loss.

A durable lease expires after 30 seconds. Another controller can reclaim it after a five-second stale grace period. Renewal requires the exact owner and controller record.

The same controller ID survives a Pi reload. A process-wide runtime map preserves live RPC transports and memory ownership while the replacement extension reloads.

A fresh process cannot adopt an unavailable child. Reconciliation marks an unavailable durable entry as stopped.

Each child checks its lease with serialized checks. A check reads at most 4 KiB. A stale check result cannot fence a newer monitor generation.

A successfully read invalid, expired, missing, or replaced record makes the child self-fence. Temporary read errors receive three consecutive retries before the child self-fences.

When durable ownership exists, the parent also terminates local children after lease loss.

## Storage and durable state

Each logical child uses this private directory:

```text
<agent-dir>/sessions/subagents/<child-id>/
  pi-effective-system-prompt.txt
  child-session.jsonl
```

The child captures the effective system prompt. The Pi session file remains the authority for transcript inspection and resume.

The controller registry stores process identity, ownership, diagnostics, the monotonic run cursor, the last settled run ID, settlement status, and caller output status.

The child does not persist a second copy of settled assistant output. The durable run cursor prevents a resumed process from reusing an earlier run ID.

## RPC protocol

The transport uses strict LF-only JSONL framing. It strips one optional trailing carriage return from each record.

It uses UTF-8 decoding that supports a character split across stream chunks. Unicode line separators inside JSON strings do not split records.

Requests receive generated IDs. The transport resolves responses by ID, so responses can arrive out of order. Events remain asynchronous and pass to the lifecycle dispatcher.

The parent sends these RPC commands:

- `get_state` captures the child session path and effective model state.
- `prompt` starts the initial or next child run.
- `follow_up` queues another run while a run is active.
- `steer` queues guidance during a run.
- `abort` requests a cooperative abort.

When the child is idle, the parent sends `prompt` because native `follow_up` and `steer` queue only active runs.

A production Pi `abort` response arrives only after the child session reaches idle. The response does not replace `agent_settled` as the lifecycle event boundary.

Production `agent_settled` normally has this bare shape:

```json
{"type":"agent_settled"}
```

It normally has no run ID or outcome. The parent records the abort request before it sends `abort` and keeps that evidence until the dispatcher accepts native settlement.

A late abort response does not clear the pending abort evidence. A native settlement without a final assistant message can still classify the run as aborted.

`subagent_start` observes run acceptance for at most one second. It does not wait for the model response.

Termination sends RPC `abort`, then `SIGTERM`, then `SIGKILL` with bounded waits. The extension has no watchdog that guesses whether a child stalled.

## Lifecycle and process-close evidence

The lifecycle separates process state from run state. A successful, failed, or aborted native settlement updates `runOutcome`, `lastSettledRunId`, and `settlement.status` to `settled`.

The process remains `alive` and the run becomes `idle` after settlement.

A process close before the current run settles updates `settlement.status` to `closed_without_settlement`. The status preserves the nullable exit code, exit signal, bounded stderr tail, bounded diagnostics, and final error.

The parent does not emit a success, failure, or abort wake for a close without settlement.

An initial close with no run keeps settlement status `pending`. A close after a settled run preserves `settled`. Explicit termination suppresses pending wakes for that child.

The inspector uses `processState` and `runState` as the coherent display model. Compatibility fields remain available for older serialized records.

An aborted settled child displays as alive and idle with an aborted outcome. It does not keep an inspector refresh timer.

## Reload event handling

`/reload` detaches runtime consumers while child processes remain active. Runtime callbacks carry the child incarnation and runtime identity.

A consumer must verify that identity before it mutates a handle. A stale runtime cannot update a replacement incarnation.

Reload drains queued records in bounded batches. A failed consumer retains its record for a later retry instead of discarding it.

The caller must schedule another drain turn after each batch. It must not drain an unbounded queue synchronously or start one full registry write for every stream delta.

## Transcript inspection

`subagent_status` reads the child Pi session JSONL file. The transcript reader accepts complete LF-framed records only.

It filters the transcript to user messages, assistant messages, and normalized error messages.

Each page uses a zero-based `messageOffset`. The default page size is three messages. The maximum page size is twenty messages.

Each message is limited to 8 KiB. Each page is limited to 32 KiB of text.

The reader reports one of these statuses:

- `available`: the snapshot has valid complete records.
- `missing`: no session path exists, or the file does not exist.
- `incomplete`: the file has a non-empty trailing fragment without LF.
- `unreadable`: one or more complete records are malformed, or the file cannot be read.

The inspector reads at most the most recent 512 KiB of transcript data. It keeps recent records and reports when earlier records fall outside that bound.

The inspector reads at most the first 64 KiB of the captured effective prompt. It reports prompt truncation instead of reading the complete file before display bounds apply.

Each inspector file operation has a deadline and an AbortSignal. Selection changes and inspector disposal cancel stale reads. A stalled read cannot block the next selected child indefinitely.

The inspector sanitizes all untrusted text before terminal rendering. These bounds do not weaken terminal sanitization.

The reader preserves a requested offset when the current page has no messages. A later append can then make that offset visible.

Transcript text and file presence do not prove that a run settled.

## Caller output

`subagent_start` accepts an optional `outputPath`. A relative path resolves against the caller session current working directory.

On settlement, the parent writes the final captured assistant text to that path without delaying event handling or wake queueing:

- Missing parent directories are created with mode `0700`.
- The output file uses mode `0600`.
- Empty text creates a valid empty file.
- An existing path returns `collision` and remains unchanged.
- A concurrent publisher returns `collision` and never overwrites the first file.
- Other filesystem errors return `failed` with a bounded error message.
- A same-directory temporary file is written and synced before exclusive hard-link publication.

The output status is independent of `runOutcome`. A failed or aborted run can still write caller output.

Reusing a path for another settled run returns `collision`.

## Settlement wakes

For each accepted `agent_settled` run, the parent queues one non-durable steering wake.

The queue accepts only `run_settled` records with outcome `succeeded`, `failed`, or `aborted`. It suppresses duplicate records by owner, child, incarnation, and run ID.

It retries one failed send and limits each flush to a bounded batch. A later batch runs in another event-loop turn.

Each wake uses `triggerTurn: true` and `deliverAs: "steer"`. Its content is exactly:

```text
Subagent <id> reached idle after run <runId>. Check subagent_status with numMessages=3.
```

The custom message details include the direct owner session file, owner session ID, child ID, incarnation, run ID, event kind, outcome, and a `settlements` array containing that record.

The parent queues each wake before optional registry persistence or caller output work. Shutdown, lease loss, and explicit child termination suppress unsent wakes.

Reload queues accept at most 512 records. Overflow retains the queued records, rejects later records, and emits one terminal diagnostic. The parent must fence that runtime instead of silently dropping lifecycle events.

The queue sends records separately. It does not promise durability, recovery after process loss, or notification for process stalls or close events.

## Tools

The extension registers eight tools:

- `subagent_start {task, model, thinking, name?, cwd?, systemPrompt?, outputPath?}` starts a persistent child. The response confirms acceptance only.
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

The inspector shows lifecycle state, RPC readiness, live assistant text, tool activity, transcript history, settlement evidence, process-close evidence, and caller output state.

It sanitizes untrusted text before rendering it.

## Resume

`subagent_resume` applies only to a stopped child with a nonempty saved session file. It keeps the logical child ID and creates a new incarnation.

The new process starts its run counter from the durable logical cursor. A resume task starts the next run. Without a task, the resumed child starts idle.

The previous incarnation cannot mutate the resumed handle. The new process receives a new transport and process ID.

A durable resume requires the owner lease. An ephemeral controller can resume only while its process-local ownership remains active.

## Verification

Run the deterministic suite from this directory:

```sh
PI_TEST_PACKAGE_DIR=/path/to/pi-0.84.1 ./test.sh
```

The suite covers lifecycle dispatch, transcript projection and pagination, caller output publication, settlement notifications, owner leases, registry isolation, strict RPC framing, correlated responses, bounded termination, launch arguments, all eight tools, reload, resume, process-close evidence, abort acceptance, child-extension health helpers, and the inspector.
