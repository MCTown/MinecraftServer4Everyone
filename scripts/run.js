import { spawn } from "node:child_process";
import process from "node:process";

const mode = process.argv[2] === "start" ? "start" : "dev";
const npmExecPath = process.env.npm_execpath;
const runNpmWithNode = npmExecPath && /\.[cm]?js$/i.test(npmExecPath);
const npm = runNpmWithNode ? process.execPath : "npm";
const serverPort = process.env.APP_PORT ?? "8787";
const webPort = process.env.NUXT_PORT ?? process.env.NITRO_PORT ?? "3000";
const children = [];
let shuttingDown = false;

function npmArgs(args) {
  return runNpmWithNode ? [npmExecPath, ...args] : args;
}

function spawnOptions(env) {
  return {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
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
  shuttingDown = true;
  for (const child of children) {
    if (child.killed || child.exitCode !== null) continue;
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      child.kill();
    }
  }
  setTimeout(() => process.exit(code), 500).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

startProcess("server", npm, npmArgs(["run", mode, "--workspace", "@mc-agent/server"]), withDefaults({
  APP_HOST: "0.0.0.0",
  APP_PORT: serverPort
}));

startProcess("web", npm, npmArgs(["run", mode, "--workspace", "@mc-agent/web"]), withDefaults({
  NUXT_HOST: "0.0.0.0",
  NUXT_PORT: webPort,
  NITRO_HOST: "0.0.0.0",
  NITRO_PORT: webPort
}));

startProcess("proxy", process.execPath, ["proxy.js"], withDefaults({
  PROXY_HOST: "0.0.0.0",
  PROXY_PORT: process.env.PROXY_PORT ?? process.env.PORT ?? "1143",
  PROXY_API_TARGET: `http://127.0.0.1:${serverPort}`,
  PROXY_WEB_TARGET: `http://127.0.0.1:${webPort}`
}));
