import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const mode = process.argv[2] === "start" ? "start" : "dev";
const npmExecPath = process.env.npm_execpath;
const runNpmWithNode = npmExecPath && /\.[cm]?js$/i.test(npmExecPath);
const npm = runNpmWithNode ? process.execPath : "npm";
const projectRoot = process.cwd();
const pidFile = process.env.MCSA_PID_FILE ?? path.join(projectRoot, ".runtime", "minecraft-server-agent.pid");
const publicHost = "0.0.0.0";
const publicPort = 1143;
const internalServerHost = process.env.APP_HOST ?? "127.0.0.1";
const internalWebHost = process.env.NUXT_HOST ?? process.env.NITRO_HOST ?? "127.0.0.1";
const children = [];
let shuttingDown = false;

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function removePidFile() {
  try {
    if (Number(readFileSync(pidFile, "utf8").trim()) === process.pid) unlinkSync(pidFile);
  } catch {
    // The file may already have been removed after a normal shutdown.
  }
}

function claimPidFile() {
  mkdirSync(path.dirname(pidFile), { recursive: true });
  try {
    const existingPid = Number(readFileSync(pidFile, "utf8").trim());
    if (existingPid !== process.pid && processIsAlive(existingPid)) {
      throw new Error(`服务已在运行（PID ${existingPid}）。请先执行 npm run restart。`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("服务已在运行")) throw error;
  }
  writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

function canListen(host, port) {
  return new Promise((resolve) => {
    const probe = createServer();
    const fail = () => {
      probe.removeAllListeners();
      resolve(false);
    };
    probe.once("error", fail);
    probe.listen({ host, port }, () => {
      probe.close(() => resolve(true));
    });
  });
}

function parsePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} 不是有效端口：${value}`);
  }
  return port;
}

async function resolveInternalPort(value, fallback, host, label) {
  if (value !== undefined && value !== "") {
    const port = parsePort(value, label);
    if (!(await canListen(host, port))) {
      throw new Error(`${label} ${host}:${port} 已被占用。请更换 ${label}，或使用 npm run restart。`);
    }
    return port;
  }

  for (let offset = 0; offset < 100; offset += 1) {
    const port = fallback + offset;
    if (port === publicPort) continue;
    if (await canListen(host, port)) return port;
  }
  throw new Error(`无法为${label}找到可用端口（尝试 ${fallback}-${fallback + 99}）。`);
}

function npmArgs(args) {
  return runNpmWithNode ? [npmExecPath, ...args] : args;
}

function spawnOptions(env) {
  return {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    detached: process.platform !== "win32",
    shell: process.platform === "win32" && !runNpmWithNode,
    stdio: ["inherit", "pipe", "pipe"]
  };
}

function withDefaults(defaults) {
  return Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, process.env[key] ?? value]));
}

function pipeWithPrefix(name, stream, target) {
  let pending = "";
  stream.on("data", (chunk) => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) target.write(`[${name}] ${line}\n`);
  });
  stream.on("end", () => {
    if (pending) target.write(`[${name}] ${pending}\n`);
  });
}

function startProcess(name, command, args, env) {
  let child;
  try {
    child = spawn(command, args, spawnOptions(env));
  } catch (error) {
    console.error(`[${name}] failed to start: ${error.message}`);
    shutdown(1);
    return;
  }

  children.push(child);
  pipeWithPrefix(name, child.stdout, process.stdout);
  pipeWithPrefix(name, child.stderr, process.stderr);

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`[${name}] exited with ${signal ?? code}`);
    shutdown(typeof code === "number" && code !== 0 ? code : 1);
  });

  child.on("error", (error) => {
    if (shuttingDown) return;
    console.error(`[${name}] failed to start: ${error.message}`);
    shutdown(1);
  });
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  removePidFile();
  for (const child of children) {
    if (child.killed || child.exitCode !== null) continue;
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      try {
        // Children launched by npm (tsx/Nuxt) share this detached process
        // group, so stopping the group prevents orphaned internal servers.
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill();
      }
    }
  }
  setTimeout(() => process.exit(code), 500).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function main() {
  claimPidFile();

  // Only the proxy is public. Internal ports are selected dynamically so a
  // stale dev server or another local service cannot break npm start.
  const serverPort = await resolveInternalPort(process.env.APP_PORT, 8787, internalServerHost, "APP_PORT");
  const webPort = await resolveInternalPort(process.env.NUXT_PORT ?? process.env.NITRO_PORT, 3000, internalWebHost, "NUXT_PORT");

  startProcess("server", npm, npmArgs(["run", mode, "--workspace", "@mc-agent/server"]), {
    APP_HOST: internalServerHost,
    APP_PORT: String(serverPort)
  });

  startProcess("web", npm, npmArgs(["run", mode, "--workspace", "@mc-agent/web"]), {
    NUXT_HOST: internalWebHost,
    NUXT_PORT: String(webPort),
    NITRO_HOST: internalWebHost,
    NITRO_PORT: String(webPort)
  });

  startProcess("proxy", process.execPath, ["proxy.js"], {
    PROXY_HOST: publicHost,
    PROXY_PORT: String(publicPort),
    PROXY_API_TARGET: `http://127.0.0.1:${serverPort}`,
    PROXY_WEB_TARGET: `http://127.0.0.1:${webPort}`
  });

  console.log(`[run] public entrypoint: http://${publicHost}:${publicPort}`);
  console.log(`[run] internal server: ${internalServerHost}:${serverPort}`);
  console.log(`[run] internal web: ${internalWebHost}:${webPort}`);
}

main().catch((error) => {
  console.error(`[run] ${error instanceof Error ? error.message : String(error)}`);
  removePidFile();
  process.exitCode = 1;
});
