import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const projectRoot = process.cwd();
const pidFile = process.env.MCSA_PID_FILE ?? path.join(projectRoot, ".runtime", "minecraft-server-agent.pid");
const npmExecPath = process.env.npm_execpath;
const runNpmWithNode = npmExecPath && /\.[cm]?js$/i.test(npmExecPath);
const npm = runNpmWithNode ? process.execPath : "npm";
const startArgs = process.argv.includes("--connector-only") ? ["run", "start:connector"] : ["start"];
const npmArgs = runNpmWithNode ? [npmExecPath, ...startArgs] : startArgs;

function readManagedPid() {
  if (!existsSync(pidFile)) return undefined;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForExit(pid, timeoutMs = 10000) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      if (!isAlive(pid) || Date.now() - startedAt >= timeoutMs) {
        resolve(!isAlive(pid));
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}

function descendantPids(rootPid) {
  try {
    const rows = execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter(([pid, parentPid]) => Number.isInteger(pid) && Number.isInteger(parentPid));
    const children = new Map();
    for (const [pid, parentPid] of rows) {
      const siblings = children.get(parentPid) ?? [];
      siblings.push(pid);
      children.set(parentPid, siblings);
    }
    const result = [];
    const visit = (pid) => {
      for (const childPid of children.get(pid) ?? []) {
        visit(childPid);
        result.push(childPid);
      }
    };
    visit(rootPid);
    return result;
  } catch {
    return [];
  }
}

function signalProcessTree(pid, signal) {
  for (const childPid of descendantPids(pid)) {
    try { process.kill(childPid, signal); } catch { /* already exited */ }
  }
  try { process.kill(pid, signal); } catch { /* already exited */ }
}

async function stopManagedProcess() {
  const pid = readManagedPid();
  if (!pid || !isAlive(pid)) return;

  console.log(`[restart] stopping managed process ${pid}`);
  signalProcessTree(pid, "SIGTERM");
  if (await waitForExit(pid)) return;

  console.warn(`[restart] process ${pid} did not stop gracefully; sending SIGKILL`);
  signalProcessTree(pid, "SIGKILL");
  await waitForExit(pid, 2000);
}

await stopManagedProcess();
console.log("[restart] starting with public entrypoint http://0.0.0.0:1143");
const child = spawn(npm, npmArgs, {
  cwd: projectRoot,
  env: { ...process.env, PROXY_HOST: "0.0.0.0", PROXY_PORT: "1143" },
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) console.error(`[restart] start process exited with ${signal}`);
  process.exitCode = typeof code === "number" ? code : 1;
});
