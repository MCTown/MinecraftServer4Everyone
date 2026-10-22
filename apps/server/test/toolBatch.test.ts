import assert from "node:assert/strict";
import { test } from "node:test";
import { runToolBatch } from "../src/agent/toolBatch.js";
import { ResourceScheduler, toolResources } from "../src/agent/resourceScheduler.js";

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };

test("read calls start eagerly, results stay ordered, mutations are barriers", async () => {
  const gate = deferred<void>(), started = deferred<void>(), order: string[] = [];
  const calls = ["list_server_files", "read_server_text_file", "write_server_text_file", "get_current_server_config"];
  const batch = runToolBatch(calls, (name) => name, async (name) => {
    order.push(name);
    if (name === calls[0]) await gate.promise;
    if (name === calls[1]) started.resolve();
    return name;
  });
  await started.promise;
  assert.deepEqual(order, calls.slice(0, 2));
  gate.resolve();
  assert.deepEqual(await batch, calls);
  assert.deepEqual(order, calls);
});

test("failed batch waits for siblings to settle before releasing the step", async () => {
  const gate = deferred<void>(), started = deferred<void>(); let settled = false;
  const batch = runToolBatch(["list_server_files", "read_server_text_file"], (name) => name, async (name) => {
    if (name === "list_server_files") throw new Error("failed");
    started.resolve(); await gate.promise; settled = true;
  });
  await started.promise; assert.equal(settled, false); gate.resolve();
  await assert.rejects(batch, /failed/); assert.equal(settled, true);
});

test("resource ownership isolates instances and branches, serializes writes and removes aborted waiters", async () => {
  const scheduler = new ResourceScheduler(), signal = new AbortController().signal;
  const release = await scheduler.acquire(["server:a:loader"], signal);
  const releaseIndependent = await scheduler.acquire(["server:a:mcdr", "server:b:*"], signal);
  const cancelled = new AbortController();
  const blocked = scheduler.acquire(["server:a:*"], cancelled.signal);
  cancelled.abort(); await assert.rejects(blocked, { name: "AbortError" });
  let entered = false;
  const next = scheduler.acquire(["server:a:*"], signal).then((release) => { entered = true; return release; });
  await Promise.resolve(); assert.equal(entered, false);
  release(); await Promise.resolve(); assert.equal(entered, false);
  releaseIndependent(); (await next)(); release();
  assert.deepEqual(toolResources("a", "run_shell_command", {}), ["server:a:*"]);
  assert.deepEqual(toolResources("a", "run_shell_command", { workflowStepId: "configure_mcdr" }), ["server:a:mcdr"]);
});
