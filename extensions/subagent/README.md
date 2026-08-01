# subagent

This extension gives a parent Pi persistent, visible child Pi sessions inside Zellij.

## Requirements

The parent Pi must run inside Zellij. The extension does not create or select a detached Zellij session.

If Zellij is unavailable, `subagent_start` returns this error:

```text
Subagent delegation requires running inside a Zellij session. Start pi inside zellij first.
```

The validated runtime versions are Zellij 0.44.3 and Pi 0.82.0. Revalidate lifecycle behavior and action flags after an upgrade.

## Child launch

`subagent_start` opens a tab in the current Zellij session. The tab runs a normal interactive Pi TUI.

The extension uses `devx pi` when an executable `devx` exists. Otherwise, it uses the current Pi executable.

Every child starts with `--offline`. The command loads `child.ts` through `-e`, so other extensions and provider proxies remain available.

The parent creates the listener before it opens the tab. The child connects to that listener and sends a fenced `hello` frame.

The initial task and later messages use IPC. The extension does not type prompts into a terminal or scrape the screen.

Nested children cannot start another delegated child.

## Authority and ownership

The extension separates durable ownership from live control.

- The canonical parent session file identifies the durable owner.
- The parent session ID validates that session file.
- A random process-wide controller ID identifies one live controller process.
- An exclusive renewable lease grants live control.
- The child ID identifies one logical child.
- A random incarnation identifies one child process.
- The saved child session file is the durable resume target.

The process-wide controller ID survives a real `/reload`. A fresh process gets a different controller ID.

Canonicalization resolves the nearest existing ancestor. Owner identity stays stable before and after the parent session file appears.

The lease expires after 30 seconds. Another controller can reclaim it only after an additional 5-second grace period.

The lease records a PID for diagnostics only. The extension never uses PID state as takeover authority.

A non-holder does not load children, bind sockets, poll panes, write the owner registry, or perform destructive actions.

A replacement holder can recover live children for the same owner. It preserves each pane's original launch-controller marker during validation.

## Storage

The extension derives `owner-key` from the canonical parent session file.

```text
<agent-dir>/sessions/subagents/controllers/<owner-key>/
  lease.json
  registry.json
  children/<child-id>/<incarnation>/bridge.sock
```

Per-child artifacts remain at this path:

```text
<agent-dir>/sessions/subagents/<child-id>/
```

These artifacts include the prompt, child event log, saved Pi session, and the latest-result compatibility file.

The shared `result.md` file atomically mirrors the latest settled run after exact persistence succeeds. Empty failed or aborted output replaces older content.

Each settled run also has durable exact artifacts:

```text
<agent-dir>/sessions/subagents/<child-id>/runs/<run-id>/
  result.md
  result.json
```

The Markdown file contains only the exact run output. The JSON file records the run outcome, incarnation, and settlement time.

The extension writes both files in a private temporary directory. An atomic directory rename publishes the complete immutable pair.

The first concurrent publisher wins. Later writers read that pair and never replace it.

Result persistence is best-effort. A settlement continues after a write failure, and diagnostics record the failure.

The extension creates private directories with mode `0700`. It creates lease, registry, prompt, result, and socket files with restrictive permissions.

Long socket paths use a private incarnation-specific directory below `/tmp`. The extension never changes permissions on the shared temporary directory.

The legacy global registry remains untouched:

```text
<agent-dir>/sessions/subagents/registry.json
```

The extension never reads, writes, deletes, or automatically adopts entries from that file. Old unfenced children remain orphaned for safety.

## IPC fences

Every child frame carries these values:

- the canonical owner session file
- the owner session ID
- the launch-controller ID
- the child ID
- the child incarnation
- the connection ID

Parent frames carry the same owner and incarnation identity. The child validates them before it accepts a parent action.

The parent validates frame identity before each state change. It also checks the current lease on disk before an authorized mutation.

Each child handle serializes its IPC mutations. This queue preserves wire order across asynchronous lease checks.

A new connection cannot change its identity after `hello`. Delayed frames from an old incarnation cannot mutate a resumed child.

Pane markers contain the full identity and socket path. Every targeted Zellij action revalidates the tab, pane, command, and markers.

## Results and waits

The child streams structured lifecycle events to the parent. Existing assistant events provide the final response.

A successful settled `subagent_wait` returns the exact response for its resolved run in both locations:

```text
content[0].text
details.result
```

The extension saves each response in an immutable `runs/<run-id>` artifact pair. A later run never overwrites that pair.

`subagent_result` retrieves one exact run by child ID and run ID. It never falls back to the latest result.

The tool returns these stable status and reason combinations:

| Status | Reason | Meaning |
| --- | --- | --- |
| `unknown_child` | `unknown_child` | The child ID is unknown. |
| `pending` | `run_active` | The requested run is the current active run. |
| `missing` | `artifact_missing` | A known historical run has no artifact pair. |
| `missing` | `run_not_known` | The requested run is newer than the child run cursor. |
| `incomplete` | `artifact_incomplete` | Only one file exists in the final run directory. |
| `invalid_metadata` | `metadata_invalid` | The metadata file is invalid or describes another run. |
| `unreadable` | `artifact_unreadable` | The tool cannot read one or both files. |
| `available` | `result_available` | The complete exact result is available. |

Only an `available` result includes `outcome`. Empty output remains an available result with its actual outcome.

Settlement notifications report completed runs while their child processes remain alive. Notifications batch nearby settlements and direct the parent to `subagent_result`.

Use `subagent_wait` only when the parent requires explicit synchronization with a finite deadline. Do not poll it for routine completion.

Use `subagent_status` for live lifecycle and diagnostic information. Do not poll it for routine completion.

`subagent_wait` uses settlement cursors. An explicit `afterRunId` requires a later settled run.

Without a cursor, an existing successful result returns immediately. Otherwise, the wait starts from the current settlement cursor.

A completed wait does not terminate the child. The child remains available for later turns.

## Resume

`subagent_resume` applies only to a stopped child with a nonempty saved Pi session file.

The extension launches Pi with this exact saved file:

```text
--session <absolute-child-session-file>
```

Resume keeps the logical child ID. It creates a new incarnation, socket, tab, pane, process, and connection.

The resumed child starts its run counter from the prior parent cursor. Run and settlement IDs therefore remain monotonic.

Resume clears the prior kill fence and stale settlement state. It preserves the monotonic run and settlement cursors.

The full owner and incarnation fence makes logical ID reuse safe. Old frames and old pane identities cannot affect the new incarnation.

## Liveness

The extension uses one controller-wide timer while an owned child remains alive.

Each tick requests one `zellij action list-panes --json -a` snapshot. The controller reconciles every live child against that snapshot.

A successful snapshot can prove that a matching pane disappeared or exited. The controller then marks the child stopped.

An IPC close requests the same probe immediately. The IPC close alone does not prove process death.

If the Zellij probe fails, the controller preserves the current state. A later successful probe can reconcile it.

Stopped children leave the active widget. Their metadata, history, and artifacts remain available until retention or explicit cleanup removes them.

## Parent lifecycle

The extension treats parent lifecycle events as follows:

| Event | Behavior |
| --- | --- |
| `/reload` | The same process keeps its controller ID and lease, then reattaches live children. |
| `/new` | The new owner does not adopt the prior owner's children. |
| `/resume` | The new owner does not adopt the prior owner's children. |
| `/fork` or `/clone` | The new owner does not adopt the prior owner's children. |
| Normal quit | The controller closes only owned, identity-matching child tabs. |
| Hard parent crash | The lease expires, then a same-owner controller can recover after the grace period. |

A settled child remains alive and interactive. Settlement never calls `ctx.shutdown()`.

## Tools

The extension registers ten tools.

- `subagent_start {task, model, thinking, name?, cwd?, systemPrompt?}`
  - The model and thinking level are mandatory.
  - The tool starts a visible child and waits for a bounded IPC handshake.
- `subagent_list {includeFinished?}`
  - The tool lists current and retained children for the active owner.
- `subagent_status {id}`
  - The tool returns lifecycle, activity, identity, usage, diagnostics, and artifact paths.
- `subagent_result {id, runId}`
  - The tool returns the exact persisted output and actual outcome for one settled run.
- `subagent_wait {id?|all?, timeoutSeconds, afterRunId?}`
  - The tool waits for a settlement cursor or a stopped process.
- `subagent_steer {id, message}`
  - The tool sends guidance during the current child turn.
- `subagent_follow_up {id, message}`
  - The tool sends another child turn.
- `subagent_interrupt {id}`
  - The tool sends `Esc` to a revalidated pane and keeps the child process alive.
- `subagent_kill {id}`
  - The tool interrupts, escalates, and closes only the revalidated child tab.
- `subagent_resume {id, task?}`
  - The tool reopens the exact saved child conversation in a new process incarnation.

## Commands

- `/subagents` opens the interactive inspector.
- `/subagents-toggle` toggles the compact active-child widget.
- `/subagents-kill-all` terminates all live children that this controller owns.

## State authorities

The extension uses separate authorities for separate facts.

- Companion IPC events and snapshots define live run state, output, tools, usage, and errors.
- A successful Zellij snapshot defines process liveness.
- The owner lease defines control authority.
- The Pi session JSONL defines durable conversation history.
- `child-events.log` and `dump-screen` provide diagnostics only.

## Verification

Run the deterministic suite from this directory:

```sh
PI_TEST_PACKAGE_DIR=/path/to/pi-0.82.0 ./test.sh
```

The suite covers per-run results, settlement notifications, waits, owner isolation, lease races, frame fences, resume, lifecycle, liveness, and UI behavior.

A separate disposable integration gate must use a real Pi and a real Zellij session. It must set a disposable `PI_CODING_AGENT_DIR`.

The integration gate must not use a normal user registry, session, socket, process, tab, or pane.

## Residual risks

- Pi lifecycle and Zellij action behavior remain version-specific.
- A hard crash can bypass shutdown callbacks. Lease expiry and reconciliation provide recovery.
- A small same-user race remains between pane revalidation and the following Zellij action.
- IPC assumes same-user local trust. Multi-user control requires authentication and a different protocol.
