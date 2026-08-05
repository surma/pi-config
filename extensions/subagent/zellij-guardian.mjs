#!/usr/bin/env node
/* Plain Node program. It does not load Pi or TypeScript modules. */
import { spawn } from "node:child_process";

const [sessionName, generation, capability, binary = "zellij"] = process.argv.slice(2);
if (
	!/^pi[A-Za-z0-9_-]{22}$/.test(sessionName || "") ||
	!/^[0-9a-f]{32}$/.test(generation || "") ||
	!/^[0-9a-f]{64}$/.test(capability || "")
) {
	process.exitCode = 64;
} else {
	const timeoutMs = Number(process.env.PI_SUBAGENT_GUARDIAN_TIMEOUT_MS || 2500);
	const graceMs = Number(process.env.PI_SUBAGENT_GUARDIAN_GRACE_MS || 500);
	const retries = Number(process.env.PI_SUBAGENT_GUARDIAN_RETRIES || 3);
	let disarmed = false;
	let finishing = false;

	function client(args) {
		return new Promise((resolve) => {
			let proc;
			try { proc = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], shell: false }); }
			catch { resolve({ code: null, stdout: "", stderr: "" }); return; }
			let stdout = "";
			let stderr = "";
			let ended = false;
			let killTimer;
			const timer = setTimeout(() => {
				if (ended) return;
				proc.kill("SIGTERM");
				killTimer = setTimeout(() => { if (!ended) proc.kill("SIGKILL"); }, graceMs);
			}, timeoutMs);
			proc.stdout.setEncoding("utf8");
			proc.stderr.setEncoding("utf8");
			proc.stdout.on("data", (chunk) => { stdout += chunk; });
			proc.stderr.on("data", (chunk) => { stderr += chunk; });
			proc.on("close", (code) => {
				ended = true;
				clearTimeout(timer);
				if (killTimer) clearTimeout(killTimer);
				resolve({ code, stdout, stderr });
			});
			proc.on("error", () => {});
		});
	}
	async function absent() {
		const result = await client(["list-sessions", "--short", "--no-formatting"]);
		const emptyList = result.code === 1 &&
			result.stdout.trim() === "" &&
			result.stderr.trim() === "No active zellij sessions found.";
		if (emptyList) return true;
		if (result.code !== 0) return false;
		return !result.stdout.split("\n").map((name) => name.trim()).includes(sessionName);
	}
	async function cleanup() {
		for (let attempt = 0; attempt < retries; attempt++) {
			await client(["delete-session", "--force", sessionName]);
			if (await absent()) return true;
		}
		return false;
	}
	async function finishAfterEof() {
		if (finishing) return;
		finishing = true;
		process.exitCode = disarmed || await cleanup() ? 0 : 1;
	}
	let input = "";
	const control = process.stdin;
	control.setEncoding("utf8");
	control.on("data", (chunk) => {
		input += chunk;
		for (;;) {
			const end = input.indexOf("\n");
			if (end < 0) break;
			const line = input.slice(0, end);
			input = input.slice(end + 1);
			try {
				const frame = JSON.parse(line);
				if (!disarmed && frame.type === "disarm" && frame.generation === generation && frame.capability === capability) {
					disarmed = true;
					// Include both independent fences in the acknowledgement. The write
					// callback proves the frame reached the pipe before we await EOF.
					process.stdout.write(`${JSON.stringify({ type: "ack", generation, capability })}\n`, (error) => {
						if (error) process.exitCode = 1;
					});
				}
			} catch {}
		}
	});
	control.on("end", () => { void finishAfterEof(); });
	control.on("error", () => { void finishAfterEof(); });
	process.stdout.write(`${JSON.stringify({ type: "ready", generation, capability })}\n`);
}
