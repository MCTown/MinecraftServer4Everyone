#!/usr/bin/env node
import process from "node:process";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { observeWorkflow, executionTimings } from "./benchmark-timing.mjs";

function usage() {
  console.error(`Usage: npm run benchmark -- --task <task> [options]

Options:
  --task-file <path>     Read the task from a UTF-8 file (instead of --task)
  --base-url <url>       MCTAgent HTTP entrypoint (default: http://127.0.0.1:1143)
  --password <password>  Panel password (default: MCTAGENT_PASSWORD or ilovemct)
  --server-id <id>       Use an existing server (dangerous; not recommended)
  --name <name>          Name for a newly-created benchmark server
  --model <name>         Per-server model override
  --mode <full|basic>    Benchmark prompt condition (default: full)
  --reasoning <level>    minimal|low|medium|high (default: high)
  --timeout-ms <n>       End-to-end timeout (default: 1800000)
  --json                 Final JSON on stdout; live step timings on stderr`);
  process.exit(2);
}

function args(argv) {
  const result = { mode: "full", reasoning: "high", timeoutMs: 1_800_000, json: false };
  for (let i = 2; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--json") { result.json = true; continue; }
    if (!item.startsWith("--")) usage();
    const key = item.slice(2).replaceAll("-", "_");
    const value = argv[++i];
    if (!value || value.startsWith("--")) usage();
    result[key] = value;
  }
  if (result.task && result.task_file) usage();
  if (result.task_file) result.task = readFileSync(result.task_file, "utf8");
  if (!result.task) usage();
  if (!result.server_id && !result.name) result.name = `benchmark-${new Date().toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14)}`;
  if (!/^(full|basic)$/.test(result.mode)) usage();
  if (!/^(minimal|low|medium|high)$/.test(result.reasoning)) usage();
  result.timeoutMs = Number(result.timeout_ms ?? result.timeoutMs);
  if (!Number.isFinite(result.timeoutMs) || result.timeoutMs <= 0) usage();
  return result;
}

const options = args(process.argv);
const baseUrl = (options.base_url ?? "http://127.0.0.1:1143").replace(/\/$/, "");
const password = options.password ?? process.env.MCTAGENT_PASSWORD ?? "ilovemct";
const startedAt = Date.now();
let cookie = "";

async function request(path, init = {}) {
  const headers = { ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) };
  if (cookie) headers.cookie = cookie;
  const method = init.method ?? "GET";
  // Observation polling must not fail a whole deployment on one transient
  // transport error. Retry only reads; mutations stay single-shot so a lost
  // response can never replay a stop/cancel/request.
  const attempts = method === "GET" ? 4 : 1;
  for (let attempt = 1; ; attempt += 1) {
    let response;
    try {
      response = await fetch(`${baseUrl}${path}`, { ...init, headers });
    } catch (error) {
      if (attempt >= attempts) throw error;
      log(`retry ${method} ${path} after transport error (${attempt}/${attempts - 1}): ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      continue;
    }
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${typeof body === "string" ? body : JSON.stringify(body)}`);
    return body;
  }
}

function log(message) { console.error(`[benchmark] ${message}`); }

async function main() {
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password })
  });
  const loginText = await login.text();
  if (!login.ok) throw new Error(`login failed (${login.status}): ${loginText}`);
  cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  if (!cookie) throw new Error("login succeeded but no session cookie was returned");

  let serverId = options.server_id;
  if (!serverId) {
    const server = await request("/api/servers", { method: "POST", body: JSON.stringify({ name: options.name }) });
    serverId = server.id;
    log(`created isolated server ${serverId}`);
  }
  if (options.model) {
    await request(`/api/servers/${encodeURIComponent(serverId)}/agent/model`, { method: "POST", body: JSON.stringify({ modelName: options.model }) });
  }

  const requestId = crypto.randomUUID();
  const accepted = await request(`/api/servers/${encodeURIComponent(serverId)}/agent/requests`, {
    method: "POST",
    body: JSON.stringify({ requestId, content: options.task, reasoningEffort: options.reasoning, benchmark: { mode: options.mode } })
  });
  const rootTurnId = accepted.turnId;
  log(`started ${rootTurnId} (${options.mode}) on ${serverId}`);

  let latest;
  let related = [];
  let finished = false;
  const workflowTimings = new Map();
  const reported = new Set();
  let lastHeartbeat = 0;
  while (Date.now() - startedAt < options.timeoutMs) {
    const executions = await request(`/api/servers/${encodeURIComponent(serverId)}/agent/executions`);
    related = executions.filter((item) => item.id === rootTurnId || item.workflowRun?.id === rootTurnId || item.workflowRun?.previousTurnId === rootTurnId);
    latest = related[0];
    if (!latest) throw new Error(`root execution ${rootTurnId} disappeared`);
    const status = latest.status;
    const stages = observeWorkflow(workflowTimings, latest);
    for (const stage of stages) {
      const key = `${stage.id}:${stage.status}`;
      if (!reported.has(key)) {
        log(`${stage.label} [${stage.status}] elapsed=${(stage.durationMs / 1000).toFixed(1)}s`);
        reported.add(key);
      }
    }
    if (Date.now() - lastHeartbeat >= 15000) {
      log(`total=${((Date.now() - startedAt) / 1000).toFixed(1)}s; ${stages.filter((s) => !s.finishedAt).map((s) => `${s.label} ${(s.durationMs / 1000).toFixed(1)}s`).join("; ") || status}`);
      lastHeartbeat = Date.now();
    }
    if (["failed", "cancelled", "interrupted"].includes(status)) { finished = true; break; }
    if (status === "completed" && !latest.workflowRun?.nextTurnId && related.every((item) => item.status === "completed")) { finished = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!finished) {
    log(`timeout after ${options.timeoutMs}ms; cancelling active benchmark`);
    await request(`/api/servers/${encodeURIComponent(serverId)}/agent/cancel`, { method: "POST" });
  }
  const details = await Promise.all(related.map((turn) => request(`/api/servers/${encodeURIComponent(serverId)}/agent/executions/${encodeURIComponent(turn.id)}`)));
  const timings = { workflow: [...workflowTimings.values()], executions: executionTimings(details) };
  for (const turn of timings.executions) {
    for (const step of turn.steps) log(`step ${step.id} [${step.status}] ${(step.durationMs / 1000).toFixed(1)}s (model + tools)`);
    for (const call of turn.toolCalls) log(`tool ${call.name} [${call.status}] ${(call.durationMs / 1000).toFixed(1)}s`);
  }

  const result = {
    benchmark: { mode: options.mode, model: options.model ?? null, serverId, rootTurnId, task: options.task },
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    wallTimeMs: Date.now() - startedAt,
    status: finished ? latest.status : "timed_out",
    timings,
    details,
    executions: related.map(({ checkpoint, ...item }) => item),
    latest: { ...latest, checkpoint: undefined }
  };
  console.log(JSON.stringify(result, null, options.json ? 0 : 2));
  if (!finished || latest.status !== "completed") process.exitCode = 1;
}

main().catch((error) => { if (options.json) console.log(JSON.stringify({ status: "runner_failed", error: String(error) })); else console.error(`[benchmark] ${error.message}`); process.exitCode = 1; });
