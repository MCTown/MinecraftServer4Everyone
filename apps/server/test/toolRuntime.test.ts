import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appConfig } from "../src/config.js";
import { getSqlite, initDatabase } from "../src/db/client.js";
import { ToolRuntime, backgroundableTools } from "../src/agent/toolRuntime.js";

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

test("only shell and Java install permit background execution", async () => {
  assert.deepEqual([...backgroundableTools].sort(), ["install_java_version", "run_shell_command"]);
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
  const runtime = new ToolRuntime(() => finished.resolve());
  await runtime.execute(input("cancel"), new AbortController().signal, (signal) => new Promise((_resolve, reject) => {
    if (signal.aborted) reject(new Error("aborted"));
    else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }));
  assert.equal(runtime.cancelScope("cancel"), 1);
  await finished.promise;
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
