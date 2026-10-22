import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appConfig } from "../src/config.js";
import { getSqlite, initDatabase } from "../src/db/client.js";
import { ToolRuntime, backgroundableTools } from "../src/agent/toolRuntime.js";
import { ExecutionStore } from "../src/agent/executionStore.js";

let root: string;
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "tool-runtime-"));
  appConfig.dataDir = root;
  initDatabase();
});
after(async () => { getSqlite().close(); await rm(root, { recursive: true, force: true }); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const input = (scopeId: string, background = true, name = "run_shell_command") => ({ scopeId, background, name,
  turnId: "turn-test", stepId: "step-test", toolCallId: crypto.randomUUID(), arguments: {} });

test("only explicitly supported shell, Java and Loader tools permit background execution", async () => {
  assert.deepEqual([...backgroundableTools].sort(), ["deploy_mrpack_server_from_server_slot", "install_java_version", "run_shell_command", "setup_forge_server", "setup_neoforge_server"]);
  const runtime = new ToolRuntime(() => undefined);
  let executed = false;
  await assert.rejects(runtime.execute(input("denied", true, "list_server_files"), new AbortController().signal, async () => {
    executed = true;
    return "unexpected";
  }), /不允许后台/);
  assert.equal(executed, false);
});

test("background receipt returns before execution; result and inbox are durable and linked", async () => {
  const finished = deferred<void>();
  const result = deferred<string>();
  const runtime = new ToolRuntime(() => finished.resolve());
  const receipt = JSON.parse(await runtime.execute(input("background"), new AbortController().signal, () => result.promise));
  assert.equal(receipt.status, "background");
  assert.equal(runtime.jobs("background")[0]!.status, "running");
  assert.equal(runtime.inbox("background").length, 0);
  result.resolve("search result");
  await finished.promise;
  const [item] = runtime.inbox("background");
  assert.equal(item!.sourceJobId, receipt.jobId);
  assert.equal(item!.sourceTurnId, "turn-test");
  assert.equal(item!.delivery, "steer");
  assert.match(item!.text, /search result/);
  assert.equal(runtime.jobs("background")[0]!.status, "completed");
});

test("running foreground observation can detach without cancellation and notify later", async () => {
  const result = deferred<string>();
  const started = deferred<void>();
  const finished = deferred<void>();
  const runtime = new ToolRuntime(() => finished.resolve());
  const controller = new AbortController();
  let jobSignal!: AbortSignal;
  const observation = runtime.execute(input("detach", false), controller.signal, (signal) => {
    jobSignal = signal;
    started.resolve();
    return result.promise;
  });
  await started.promise;
  assert.equal(runtime.background("detach").backgrounded, 1);
  assert.equal(JSON.parse(await observation).status, "background");
  controller.abort();
  assert.equal(jobSignal.aborted, false);
  result.resolve("done later");
  await finished.promise;
  assert.match(runtime.inbox("detach")[0]!.text, /done later/);
});

test("other tools stay serial and cannot be detached", async () => {
  const result = deferred<string>();
  const runtime = new ToolRuntime(() => undefined);
  const observation = runtime.execute(input("mutation", false, "web_search"), new AbortController().signal, () => result.promise);
  assert.equal(runtime.background("mutation").backgrounded, 0);
  result.resolve("done");
  assert.equal(await observation, "done");
  assert.equal(runtime.inbox("mutation").length, 0);
});

test("cancel aborts jobs and queues late results without waking the model", async () => {
  const finished = deferred<void>();
  const runtime = new ToolRuntime(() => assert.fail("cancelled scope must not wake"));
  const receipt = JSON.parse(await runtime.execute(input("cancel"), new AbortController().signal, (signal) => new Promise((_resolve, reject) => {
    if (signal.aborted) reject(new Error("aborted"));
    else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  })));
  const terminal = runtime.wait("cancel", receipt.jobId, new AbortController().signal).then(() => finished.resolve());
  assert.equal(runtime.cancelScope("cancel"), 1);
  await finished.promise;
  await terminal;
  assert.equal(runtime.jobs("cancel")[0]!.status, "cancelled");
  assert.equal(runtime.inbox("cancel")[0]!.delivery, "queue");
});

test("restart interrupts detached jobs and produces one durable notification without replay", () => {
  const job = { ...input("restart"), id: "restart-job", status: "running", startedAt: new Date().toISOString() };
  getSqlite().prepare("INSERT INTO agent_tool_jobs(id, scope_id, status, payload) VALUES (?, ?, ?, ?)").run(job.id, job.scopeId, job.status, JSON.stringify(job));
  ToolRuntime.recoverInterrupted();
  ToolRuntime.recoverInterrupted();
  const runtime = new ToolRuntime(() => undefined);
  assert.equal(runtime.jobs("restart")[0]!.status, "interrupted");
  assert.equal(runtime.inbox("restart").length, 1);
  assert.match(runtime.inbox("restart")[0]!.text, /未自动重放/);
});

test("restart keeps explicitly cancelled background work from steering the session", () => {
  const job = { ...input("cancelled-restart"), id: "cancelled-restart-job", status: "running", suppressWake: true, startedAt: new Date().toISOString() };
  getSqlite().prepare("INSERT INTO agent_tool_jobs(id, scope_id, status, payload) VALUES (?, ?, ?, ?)").run(job.id, job.scopeId, job.status, JSON.stringify(job));
  ToolRuntime.recoverInterrupted();
  const runtime = new ToolRuntime(() => undefined);
  assert.equal(runtime.inbox("cancelled-restart")[0]!.delivery, "queue");
});

test("inbox preserves ordering, supports queue/steer, cancellation and durable delivery", () => {
  const runtime = new ToolRuntime(() => undefined);
  const first = runtime.enqueue("inbox", "first", "queue");
  const second = runtime.enqueue("inbox", "second");
  assert.deepEqual(runtime.inbox("inbox").map((item) => item.text), ["first", "second"]);
  runtime.updateInbox("inbox", first.id, "steer");
  runtime.cancelInbox("other-scope", first.id);
  assert.equal(runtime.inbox("inbox")[0]!.delivery, "steer");
  runtime.delivered(first, "consumer-turn");
  runtime.cancelInbox("inbox", second.id);
  assert.equal(runtime.inbox("inbox").length, 0);
  assert.equal(runtime.inbox("inbox", false)[0]!.deliveredTurnId, "consumer-turn");
});

test("completion notification has a stable identity and delivery ack survives restart reconciliation", async () => {
  const finished = deferred<void>(), result = deferred<string>();
  const runtime = new ToolRuntime(() => finished.resolve());
  const receipt = JSON.parse(await runtime.execute(input("ack"), new AbortController().signal, () => result.promise));
  assert.equal(receipt.notificationId, `inbox:${receipt.jobId}`);
  assert.equal(runtime.jobs("ack")[0]!.notificationState, "pending");
  result.resolve("done"); await finished.promise;
  assert.equal(runtime.jobs("ack")[0]!.notificationState, "admitted");
  runtime.delivered(runtime.inbox("ack")[0]!, "consumer");
  ToolRuntime.recoverInterrupted();
  assert.equal(runtime.jobs("ack")[0]!.notificationState, "delivered");
  assert.equal(runtime.inbox("ack").length, 0);
  assert.equal(runtime.inbox("ack", false).length, 1);
});

test("restart reconciles terminal jobs missing inbox admission without waking idle owners", () => {
  const job = { ...input("lost-notice"), id: "lost-notice-job", status: "completed", output: "saved outcome", startedAt: new Date().toISOString() };
  getSqlite().prepare("INSERT INTO agent_tool_jobs VALUES (?,?,?,?)").run(job.id, job.scopeId, job.status, JSON.stringify(job));
  ToolRuntime.recoverInterrupted(); ToolRuntime.recoverInterrupted();
  const runtime = new ToolRuntime(() => assert.fail("restart must not wake"));
  assert.equal(runtime.inbox(job.scopeId).length, 1);
  assert.equal(runtime.inbox(job.scopeId)[0]!.resume, false);
  assert.match(runtime.inbox(job.scopeId)[0]!.text, /saved outcome/);
});

test("per-job output uses exclusive cursors, retains full chunks and enforces scope ownership", async () => {
  const runtime = new ToolRuntime(() => undefined);
  await runtime.execute(input("output", false), new AbortController().signal, async (_signal, jobId) => {
    runtime.appendOutput(jobId, "stdout", "x".repeat(10000));
    runtime.appendOutput(jobId, "stderr", "最后错误"); return "done";
  });
  const job = runtime.jobs("output")[0]!;
  const first = runtime.output("output", job.id, 0, 2);
  const rest = runtime.output("output", job.id, first.cursor);
  assert.equal([...first.chunks, ...rest.chunks].map((chunk) => chunk.text).join(""), "x".repeat(10000) + "最后错误");
  assert.equal(runtime.output("output", job.id, rest.cursor).chunks.length, 0);
  assert.throws(() => runtime.output("other", job.id), /不存在/);
  assert.throws(() => runtime.cancelJob("other", job.id), /不存在/);
  assert.throws(() => runtime.output("output", job.id, -1), /无效/);
});

test("wait subscribes to completion, observer abort does not cancel job, targeted cancel is isolated", async () => {
  const runtime = new ToolRuntime(() => assert.fail("cancelled job must not wake"));
  const receipt = JSON.parse(await runtime.execute(input("target-cancel"), new AbortController().signal, (signal) => new Promise((_resolve, reject) => {
    if (signal.aborted) reject(new Error("aborted"));
    else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  })));
  const observer = new AbortController();
  const waiting = runtime.wait("target-cancel", receipt.jobId, observer.signal);
  observer.abort(); await assert.rejects(waiting, { name: "AbortError" });
  assert.equal(runtime.jobs("target-cancel")[0]!.status, "running");
  const terminal = runtime.wait("target-cancel", receipt.jobId, new AbortController().signal);
  assert.equal(runtime.cancelJob("target-cancel", receipt.jobId).cancelled, true);
  assert.equal((await terminal).status, "cancelled");
  assert.equal(runtime.inbox("target-cancel")[0]!.resume, false);
});

test("explicit output retention never prunes a live job or an unacknowledged completion", async () => {
  const result = deferred<string>(), finished = deferred<void>(), runtime = new ToolRuntime(() => finished.resolve());
  const receipt = JSON.parse(await runtime.execute(input("retention"), new AbortController().signal, async (_signal, id) => {
    runtime.appendOutput(id, "stdout", "keep until acknowledged"); return result.promise;
  }));
  await Promise.resolve();
  assert.equal(runtime.pruneOutput("retention", "2100-01-01").deletedChunks, 0);
  result.resolve("done"); await finished.promise;
  assert.equal(runtime.pruneOutput("retention", "2100-01-01").deletedChunks, 0);
  runtime.delivered(runtime.inbox("retention")[0]!, "consumer");
  assert.equal(runtime.pruneOutput("retention", "2100-01-01").deletedChunks, 1);
  assert.equal(runtime.getJob("retention", receipt.jobId).status, "completed");
});

test("duplicate installer submission reuses a live receipt rather than replaying installation", async () => {
  const result = deferred<string>(), finished = deferred<void>(), runtime = new ToolRuntime(() => finished.resolve());
  const first = JSON.parse(await runtime.execute(input("duplicate", true, "setup_neoforge_server"), new AbortController().signal, () => result.promise));
  const second = JSON.parse(await runtime.execute(input("duplicate", true, "setup_neoforge_server"), new AbortController().signal, async () => assert.fail("must not repeat installer")));
  assert.equal(first.jobId, second.jobId); assert.equal(runtime.jobs("duplicate").length, 1);
  result.resolve("done"); await finished.promise;
});

test("recovery attributes repeated provider tool-call IDs to their own step", () => {
  const store = new ExecutionStore(), runtime = new ToolRuntime(() => undefined);
  const turn = store.create("step-attribution", "recover", "high", "model", null);
  const job = { ...input(turn.scopeId), turnId: turn.id, stepId: "first-step", toolCallId: "reused-id", id: "attributed-job", status: "completed", output: "done", startedAt: new Date().toISOString() };
  getSqlite().prepare("INSERT INTO agent_tool_jobs VALUES (?,?,?,?)").run(job.id, job.scopeId, job.status, JSON.stringify(job));
  for (const stepId of ["first-step", "second-step"]) store.saveCall({ id: `${stepId}:reused-id`, turnId: turn.id, stepId, toolCallId: "reused-id", name: job.name, arguments: "{}", status: "running", startedAt: job.startedAt });
  ToolRuntime.recoverInterrupted();
  const calls = store.calls(turn.id);
  assert.equal(calls[0]!.status, "completed");
  assert.equal(JSON.parse(calls[0]!.output!).jobId, job.id);
  assert.equal(calls[1]!.status, "running");
  assert.equal(runtime.inbox(turn.scopeId).length, 1);
});
