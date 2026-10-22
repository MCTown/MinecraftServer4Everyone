import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ProcessManager } from "../src/services/processManager.js";
import { createAgentTools } from "../src/agent/tools.js";
import type { AgentToolContext } from "../src/agent/toolKit.js";
import type { ServerRecord } from "../src/types.js";
import type { ConsoleLogEntry } from "../src/types.js";
import { eventBus } from "../src/services/eventBus.js";

const id = "server-shutdown-test";
function harness(status: ServerRecord["status"] = "stopping") {
  let current = { id, status, directory: "/nonexistent/shutdown-test" } as ServerRecord;
  const manager = new ProcessManager({ requireServer: async () => current } as never,
    { listAll: () => [{ text: "Saving chunks" }] } as never, {} as never, {} as never);
  const internals = manager as unknown as {
    running: { serverId: string; rootPid: number } | null;
    findActiveServerProcesses: (...args: unknown[]) => Promise<{ pid: number; name: string }[]>;
    collectSystemProcesses: () => Promise<unknown[]>;
  };
  let inspections = 0;
  let remaining: { pid: number; name: string }[] = [];
  internals.findActiveServerProcesses = async () => { inspections++; return remaining; };
  return { manager, internals, get inspections() { return inspections; },
    remaining: (value: typeof remaining) => { remaining = value; },
    status: (value: ServerRecord["status"]) => {
      current = { ...current, status: value };
      eventBus.emit("serverStatus", { serverId: id, status: value });
    } };
}

test("waitForStopped waits for the matching shutdown event, not stopping or another server", async () => {
  const h = harness();
  const listeners = eventBus.listenerCount("serverStatus");
  let settled = false;
  const waiting = h.manager.waitForStopped(id).then((result) => { settled = true; return result; });
  eventBus.emit("serverStatus", { serverId: "other-server", status: "stopped" });
  h.status("stopping");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(h.inspections, 0);
  h.status("stopped");
  const result = await waiting;
  assert.equal(result.stopped, true);
  assert.equal(result.status, "stopped");
  assert.equal(h.inspections, 1);
  assert.equal(eventBus.listenerCount("serverStatus"), listeners);
});

test("already stopped or crashed resolves only after checking for associated processes", async () => {
  for (const status of ["stopped", "crashed"] as const) {
    const h = harness(status);
    assert.equal((await h.manager.waitForStopped(id)).status, status);
    assert.equal(h.inspections, 1);
  }
});

test("orphaned, residual children and still tracked processes cannot report shutdown success", async () => {
  const orphaned = harness("orphaned");
  await assert.rejects(orphaned.manager.waitForStopped(id), /后台残留进程.*不会自动强杀/s);
  const children = harness("stopped");
  children.remaining([{ pid: 12345, name: "java" }]);
  await assert.rejects(children.manager.waitForStopped(id), /java\(12345\)/);
  const tracked = harness("stopped");
  tracked.internals.running = { serverId: id, rootPid: 12345 };
  await assert.rejects(tracked.manager.waitForStopped(id), /受跟踪根 PID：12345/);
});

test("a shutdown event cannot be lost while the initial server snapshot is pending", async () => {
  const h = harness();
  let resolveSnapshot: (server: ServerRecord) => void = () => undefined;
  const snapshot = new Promise<ServerRecord>((resolve) => { resolveSnapshot = resolve; });
  const original = (h.manager as unknown as { serverService: { requireServer: () => Promise<ServerRecord> } }).serverService;
  let reads = 0;
  original.requireServer = async () => ++reads === 1 ? snapshot : { id, status: "stopped" } as ServerRecord;
  const waiting = h.manager.waitForStopped(id);
  h.status("stopped");
  assert.equal((await waiting).stopped, true);
  resolveSnapshot({ id, status: "stopping" } as ServerRecord);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.inspections, 1);
});

test("a new launch fences an in-flight terminal process inspection", async () => {
  const h = harness("stopped");
  let finishInspection: () => void = () => undefined;
  h.internals.findActiveServerProcesses = () => new Promise((resolve) => { finishInspection = () => resolve([]); });
  const waiting = h.manager.waitForStopped(id);
  const rejected = assert.rejects(waiting, /重新启动/);
  await new Promise((resolve) => setImmediate(resolve));
  h.status("starting");
  finishInspection();
  await rejected;
});

test("timeout includes shutdown diagnostics and never calls stop or kill", async () => {
  const h = harness();
  h.manager.stop = async () => { assert.fail("wait must not stop a process"); };
  h.manager.kill = async () => { assert.fail("wait must not kill a process"); };
  const listeners = eventBus.listenerCount("serverStatus");
  await assert.rejects(h.manager.waitForStopped(id, { timeoutMs: 1_000 }), /停止超时.*状态：stopping.*不会自动强杀.*Saving chunks/s);
  assert.equal(eventBus.listenerCount("serverStatus"), listeners);
});

test("pre-aborted and active cancellations clean up without changing the process", async () => {
  for (const preAborted of [true, false]) {
    const h = harness();
    const controller = new AbortController();
    const listeners = eventBus.listenerCount("serverStatus");
    if (preAborted) controller.abort();
    const waiting = h.manager.waitForStopped(id, { signal: controller.signal });
    controller.abort();
    await assert.rejects(waiting, /已取消.*不改变进程状态/);
    assert.equal(eventBus.listenerCount("serverStatus"), listeners);
  }
});

test("a failed initial lookup or process inspection rejects and removes listeners", async () => {
  const h = harness("stopped");
  const listeners = eventBus.listenerCount("serverStatus");
  h.internals.findActiveServerProcesses = async () => { throw new Error("process inspection failed"); };
  await assert.rejects(h.manager.waitForStopped(id), /process inspection failed/);
  assert.equal(eventBus.listenerCount("serverStatus"), listeners);
  const manager = new ProcessManager({ requireServer: async () => { throw new Error("server not found"); } } as never, {} as never, {} as never, {} as never);
  await assert.rejects(manager.waitForStopped(id), /server not found/);
  assert.equal(eventBus.listenerCount("serverStatus"), listeners);
});

test("strict shutdown inspection fails closed when the process list cannot be read", async () => {
  const h = harness("stopped");
  // Use the actual process matching/inspection implementation, but no system command.
  h.internals.findActiveServerProcesses = (ProcessManager.prototype as unknown as typeof h.internals).findActiveServerProcesses.bind(h.manager);
  (h.manager as unknown as { runBufferedProcess: () => Promise<never> }).runBufferedProcess = async () => { throw new Error("ps unavailable"); };
  await assert.rejects(h.manager.waitForStopped(id), /无法读取系统进程列表/);
});

test("wait_for_server_stopped bounds timeouts and forwards the Agent signal without mutations", async () => {
  const signal = new AbortController().signal;
  const calls: { timeoutMs?: number; signal?: AbortSignal }[] = [];
  const tool = createAgentTools({ getServerId: () => id, signal,
    processManager: { waitForStopped: async (serverId: string, options: typeof calls[number]) => {
      assert.equal(serverId, id); calls.push(options); return { serverId, stopped: true };
    } } as never } as unknown as AgentToolContext).find((item) => item.definition.function.name === "wait_for_server_stopped")!;
  for (const timeoutSeconds of [undefined, 0, 601, NaN, Infinity]) {
    assert.equal(JSON.parse(await tool.execute({ timeoutSeconds })).stopped, true);
  }
  assert.deepEqual(calls.map((call) => call.timeoutMs), [180_000, 5_000, 600_000, 180_000, 180_000]);
  assert.ok(calls.every((call) => call.signal === signal));
});

test("real isolated managed process supports graceful stop, event wait and subsequent start", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp("/tmp/opencode/shutdown-process-");
  let server = { id: "server-real-shutdown-test", directory, status: "stopped", javaPath: "java", javaVersion: null,
    minMemory: "128M", maxMemory: "128M", jarFile: "", startArgs: "",
    startupCommand: `"${process.execPath}" "${path.join(directory, "fixture.cjs")}"` } as ServerRecord;
  let entries: ConsoleLogEntry[] = [];
  const manager = new ProcessManager({
    requireServer: async () => ({ ...server }), getServer: async () => ({ ...server }),
    setStatus: async (_id: string, status: ServerRecord["status"]) => { server = { ...server, status }; }
  } as never, {
    listAll: () => entries, clear: () => { entries = []; },
    append: (serverId: string, stream: ConsoleLogEntry["stream"], text: string) => {
      const entry = { id: String(entries.length), serverId, stream, text, createdAt: new Date().toISOString() };
      entries.push(entry); eventBus.emit("console", entry);
      return entry;
    }
  } as never, { getAgentDownloadProxyUrl: () => undefined } as never, {} as never);
  try {
    await mkdir(path.join(directory, "server"));
    await writeFile(path.join(directory, "fixture.cjs"), `
const readline = require('node:readline');
console.log('Done (0.01s)!');
readline.createInterface({ input: process.stdin }).on('line', line => {
  if (line === 'list') console.log('There are 0 of a max of 20 players online: ');
  if (line === 'stop') { console.log('Saving chunks'); setTimeout(() => process.exit(0), 30); }
});
`);
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal((await manager.start(server.id)).status, "running");
      await manager.waitForStartup(server.id, { timeoutMs: 5_000 });
      assert.ok(manager.getConsoleSnapshot(server.id).entries.some((entry) => entry.text.includes("Done")));
      entries.push({ id: "shell-only", serverId: server.id, stream: "stdout", text: "Shell output is not server evidence", createdAt: new Date().toISOString() });
      assert.ok(!manager.getConsoleSnapshot(server.id).entries.some((entry) => entry.id === "shell-only"));
      assert.equal((await manager.sendCommandAndWait(server.id, "list", { responseType: "players", timeoutMs: 5_000 })).status, "matched");
      assert.ok((await manager.inspectRuntime(server.id)).owned);
      assert.equal((await manager.stop(server.id)).status, "stopping");
      const stopped = await manager.waitForStopped(server.id, { timeoutMs: 5_000 });
      assert.equal(stopped.status, "stopped");
      assert.equal(manager.getActiveServerId(), null);
      assert.equal(manager.getConsoleSnapshot(server.id).launch, null);
      assert.deepEqual(manager.getConsoleSnapshot(server.id).entries, []);
      assert.equal(await manager.hasActiveServerProcesses(server.id), false);
    }
  } finally {
    // Failure cleanup is limited to this test's unique managed fixture.
    if (manager.getActiveServerId() === server.id) {
      await manager.kill(server.id);
      await manager.waitForStopped(server.id, { timeoutMs: 5_000 });
    }
    await rm(directory, { recursive: true, force: true });
  }
});
