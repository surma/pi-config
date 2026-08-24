#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const mode = process.env.E2E_FAKE_MODE || "success";
const logPath = process.env.E2E_LOG_PATH;
const markerPath = process.env.E2E_MARKER_PATH;
const controlPath = process.env.E2E_CONTROL_PATH;
const floodCount = Number.parseInt(process.env.E2E_FLOOD_COUNT || "600", 10) || 600;
const abortResponseDelay = Number.parseInt(process.env.E2E_ABORT_RESPONSE_DELAY || "40", 10) || 40;

function log(record) {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(record)}\n`);
}

function mark(value) {
  if (markerPath) appendFileSync(markerPath, `${value}\n`);
}

function output(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function respond(command, data) {
  output({
    type: "response",
    id: command.id,
    command: command.type,
    success: true,
    ...(data === undefined ? {} : { data }),
  });
}

const sessionIndex = args.indexOf("--session");
const sessionDirIndex = args.indexOf("--session-dir");
let sessionFile = sessionIndex >= 0 ? args[sessionIndex + 1] : undefined;
const sessionDir =
  sessionDirIndex >= 0
    ? args[sessionDirIndex + 1]
    : process.env.PI_SUBAGENT_SESSION_DIR;
if (!sessionFile && sessionDir) sessionFile = join(sessionDir, "child-session.jsonl");
if (sessionFile) {
  mkdirSync(join(sessionFile, ".."), { recursive: true });
  if (!existsSync(sessionFile)) writeFileSync(sessionFile, '{"type":"session"}\n');
}
if (process.env.PI_SUBAGENT_HEALTH_PATH && mode !== "extension-error") {
  mkdirSync(dirname(process.env.PI_SUBAGENT_HEALTH_PATH), { recursive: true });
  writeFileSync(process.env.PI_SUBAGENT_HEALTH_PATH, "pi-subagent-child-extension-ready/v1\n");
}

log({ event: "start", pid: process.pid, args, mode, sessionFile });
if (mode === "pause-stdin") {
  process.stdin.pause();
  mark("stdin-paused");
}
if (mode === "huge-record") {
  process.stdout.write("x".repeat(5 * 1024 * 1024));
  mark("huge-record-sent");
  process.stdout.end();
}
if (mode === "large-transcript" && sessionFile) {
  const text = "transcript-" + "x".repeat(300 * 1024);
  writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text }] },
    })}\n`,
  );
}

let run = Number.parseInt(process.env.PI_SUBAGENT_RUN_ID_BASE || "0", 10) || 0;
let activeRun;
let promptCount = 0;
let messageBusy = false;
let reloadReleased = false;
let input = "";

function appendSession(message) {
  if (!sessionFile) return;
  appendFileSync(
    sessionFile,
    `${JSON.stringify({ type: "message", message })}\n`,
  );
}

function assistantMessage(runId, text) {
  return {
    role: "assistant",
    provider: "provider",
    model: "model",
    responseId: `response-${runId}`,
    timestamp: 1000 + runId,
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage: {
      input: 3,
      output: 2,
      cacheRead: 1,
      cacheWrite: 0,
      cost: { total: 0.01 },
    },
  };
}

function settleRun(runId, text, outcome = "succeeded") {
  const assistant = assistantMessage(runId, text);
  output({
    type: "message_start",
    message: {
      ...assistant,
      content: [],
    },
  });
  output({
    type: "message_update",
    message: assistant,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
  });
  output({ type: "message_end", message: assistant });
  appendSession({ role: "assistant", content: [{ type: "text", text }] });
  output({ type: "agent_end", runId, messages: [assistant], willRetry: false });
  output({ type: "agent_settled", runId, runOutcome: outcome });
  activeRun = undefined;
}

function floodRun(runId, prefix = "flood") {
  const responseId = `flood-response-${runId}`;
  const timestamp = 2000 + runId;
  const first = {
    role: "assistant",
    provider: "provider",
    model: "model",
    responseId,
    timestamp,
    content: [],
  };
  output({ type: "message_start", message: first });
  let finalText = "";
  for (let index = 0; index < floodCount; index++) {
    finalText = `${prefix}-${runId}-${index}`;
    output({
      type: "message_update",
      message: {
        ...first,
        content: [{ type: "text", text: finalText }],
      },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: finalText },
    });
  }
  const assistant = {
    ...first,
    content: [{ type: "text", text: finalText }],
    stopReason: "stop",
    usage: {
      input: 3,
      output: floodCount,
      cacheRead: 1,
      cacheWrite: 0,
      cost: { total: 0.01 },
    },
  };
  output({ type: "message_end", message: assistant });
  appendSession({ role: "assistant", content: [{ type: "text", text: finalText }] });
  output({ type: "agent_end", runId, messages: [assistant], willRetry: false });
  output({ type: "agent_settled" });
  activeRun = undefined;
  mark("flood-done");
}

function startPrompt(message) {
  promptCount += 1;
  run += 1;
  const runId = run;
  activeRun = runId;
  const text = `result-${runId} ${String(message || "")}`;
  appendSession({ role: "user", content: [{ type: "text", text: String(message || "") }] });
  output({ type: "agent_start", runId });

  if (mode === "hang-prompt") return;
  if (mode === "close") {
    process.stderr.write("fake close diagnostic\n");
    mark("close-scheduled");
    setTimeout(() => process.exit(17), 100);
    return;
  }
  if (mode === "hang-message" || mode === "hang-abort" || mode === "message-race") {
    mark(promptCount === 1 ? "active" : `active-${promptCount}`);
    return;
  }
  if (mode === "production-abort" || mode === "slow-production-abort") {
    mark("active");
    return;
  }
  if (mode === "two-runs" && promptCount > 1) {
    mark("second-run-active");
    return;
  }
  if (mode === "reload-queue") {
    mark("reload-ready");
    const poll = setInterval(() => {
      if (reloadReleased) {
        clearInterval(poll);
        floodRun(runId, "reload");
      } else if (controlPath && existsSync(controlPath)) {
        try {
          reloadReleased = readFileSync(controlPath, "utf8").includes("emit");
        } catch {
          // The driver can replace the control file during cleanup.
        }
      }
    }, 5);
    poll.unref?.();
    return;
  }
  if (mode === "stream-flood" || mode === "persist-flood") {
    mark("flood-start");
    floodRun(runId, mode);
    return;
  }
  if (mode === "large-transcript") {
    settleRun(runId, text);
    return;
  }
  settleRun(runId, text);
}

function command(command) {
  if (command.type === "get_state") {
    if (mode === "hang-get-state" || (mode === "hang-resume-state" && run > 0)) return;
    if (mode === "extension-error") {
      output({
        type: "extension_error",
        extensionPath: "e2e-child-extension.ts",
        error: "fake child extension failed to load",
      });
    }
    const sendState = () =>
      respond(command, {
        sessionFile,
        sessionId: "child-session",
        model: { provider: "provider", id: "model" },
        thinkingLevel: "off",
      });
    if (mode === "resume-race" && run > 0) setTimeout(sendState, 100);
    else sendState();
    return;
  }
  if (command.type === "prompt") {
    if (mode !== "hang-prompt") respond(command);
    startPrompt(command.message);
    return;
  }
  if (command.type === "abort") {
    if (mode === "hang-abort" || mode === "hang-message") return;
    const settledRun = activeRun;
    if (settledRun === undefined) {
      respond(command);
      return;
    }
    if (mode === "production-abort" || mode === "slow-production-abort") {
      activeRun = undefined;
      output({ type: "agent_settled" });
      setTimeout(() => respond(command), abortResponseDelay);
      return;
    }
    respond(command);
    setTimeout(() => {
      output({ type: "agent_settled", runId: settledRun, runOutcome: "aborted" });
      activeRun = undefined;
    }, 20);
    return;
  }
  if (command.type === "steer" || command.type === "follow_up") {
    if (mode === "hang-message" || mode === "hang-abort") return;
    if (mode === "message-race") {
      if (messageBusy) {
        log({ event: "message-overlap", command: command.type });
      }
      messageBusy = true;
      log({ event: "message-start", command: command.type });
      setTimeout(() => {
        respond(command);
        messageBusy = false;
        log({ event: "message-end", command: command.type });
      }, 100);
      return;
    }
    respond(command);
    return;
  }
  respond(command);
}

if (mode !== "pause-stdin") {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
    for (;;) {
      const newline = input.indexOf("\n");
      if (newline < 0) break;
      const line = input.slice(0, newline).replace(/\r$/u, "");
      input = input.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        command(JSON.parse(line));
      } catch (error) {
        process.stderr.write(`${String(error)}\n`);
      }
    }
  });
}
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

// Keep intentionally stalled modes alive until bounded transport cleanup kills them.
if (mode === "huge-record" || mode === "pause-stdin") {
  // Keep the stalled child alive until the transport cleanup path kills it.
  setInterval(() => {}, 1_000);
}
