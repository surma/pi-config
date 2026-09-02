# Compaction

This repository no longer implements compaction. Compaction is delegated to
[pi-vcc](https://github.com/sting8k/pi-vcc).

## What was removed

- `extensions/token-window-reminder.ts` — the reminder ladder, the
  `compaction_handoff` tool, and the `session_before_compact` handler
- `extensions/lib/compaction-settings.ts`
- `tests/token-window-reminder/`

## Why

The removed pipeline asked the model to write its own hand-off. Measured across
one production session, that tool call cost a median of 7,847 output tokens and
up to 16,275.

That is the failure mode it died of. Once context passed roughly 97%, fewer
tokens remained than the call needed, so the model could not emit it. Each failed
turn appended a reminder and more thinking, so headroom only shrank. One session
sat between 89% and 98.5% of its window for four days and needed manual rescue
three times, twice by switching to a model with a larger window.

pi-vcc cannot fail that way. It builds the summary by extraction rather than
generation, so it needs no output budget and no API call. It runs in 30-470ms
regardless of how full the context is.

## What is lost

This is a real trade, not a pure win.

The hand-off carried reasoning that extraction cannot reproduce: requirements
with provenance, established facts separated from working assumptions,
authorization grants that survive a boundary, and generation counters that
detected laundered claims. pi-vcc produces a good transcript. The hand-off
produced a briefing.

Partly offsetting that, pi-vcc keeps history reachable. Its `vcc_recall` tool
reads the raw session JSONL, so material dropped by compaction stays searchable
within the session. The old pipeline discarded it.

## Required companion change

Removing these files does not install pi-vcc. Until the package is added, Pi
falls back to its own LLM summarizer, which is safe but is not the intent.

pi-vcc is an npm package, and this repository is consumed declaratively through
nixenv. Add it there:

```nix
programs.pi.extraPackages = [ "npm:@sting8k/pi-vcc" ];
```

`extraPackages` already exists in `modules/home-manager/pi/default-config.nix`
and is the same mechanism used for `npm:pi-mcp-adapter`.

## Configuration

pi-vcc scaffolds `~/.pi/agent/pi-vcc-config.json` on first load:

```json
{
  "overrideDefaultCompaction": true,
  "smartKeepTail": true,
  "continueAfterThresholdCompact": true,
  "debug": false
}
```

`continueAfterThresholdCompact` preserves the behavior `agent-done-noti.ts`
depends on: a compaction may queue one follow-up message before the agent
settles, so `agent_end` alone does not mean the agent is done.
