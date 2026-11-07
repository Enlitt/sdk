/**
 * The real process wiring for `enlitt`. The shebang is added by the build
 * (tsup banner), so this file has none. All behavior lives in `main.ts`.
 */
import { spawn } from "node:child_process";
import { hostname, homedir } from "node:os";

import { main } from "./main.js";
import type { CliDeps } from "./main.js";

/** Runs `git`; a missing git binary reads as exit code 127, never as a crash. */
function runGit(args: string[], cwd: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let child;
    try {
      child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve({ code: 127, stdout: "" });
      return;
    }
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => resolve({ code: 127, stdout: "" }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
  });
}

/** Opens `url` in the default browser, detached; resolves once the opener is spawned. */
function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  return new Promise((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), { stdio: "ignore", detached: true });
    child.on("error", reject);
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

const deps: CliDeps = {
  fetch: globalThis.fetch,
  env: process.env,
  cwd: process.cwd(),
  homedir: homedir(),
  platform: process.platform,
  hostname: hostname(),
  stdout: process.stdout,
  stderr: process.stderr,
  isTTY: {
    stdin: process.stdin.isTTY === true,
    stdout: process.stdout.isTTY === true,
    stderr: process.stderr.isTTY === true
  },
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  openBrowser,
  git: runGit
};

process.exitCode = await main(process.argv.slice(2), deps);
