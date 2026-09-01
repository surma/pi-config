#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [childScript, pidPath] = process.argv.slice(2);
if (!childScript || !pidPath) throw new Error("Usage: e2e-parent-death.mjs CHILD_SCRIPT PID_PATH");

const child = spawn(process.execPath, [childScript], {
  stdio: ["pipe", "ignore", "ignore"],
});
if (!child.pid) throw new Error("The fixture child did not provide a process id.");
writeFileSync(pidPath, String(child.pid));
setInterval(() => {}, 1_000);
