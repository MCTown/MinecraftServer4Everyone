import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ProcessManager } from "../src/services/processManager.js";
import { createAgentTools } from "../src/agent/tools.js";
import type { AgentToolContext } from "../src/agent/toolKit.js";
import { eventBus } from "../src/services/eventBus.js";

const server = { id: "server-startup-test", status: "running" } as never;
const serverService = { requireServer: async () => server } as never;

function logs() {
  return { listAll: () => [] } as never;
}

function processManager() {
  return new ProcessManager(serverService, logs(), {} as never, {} as never);
}

afterEach(() => {
  eventBus.removeAllListeners("console");
  eventBus.removeAllListeners("serverStatus");
});

test("waitForStartup resolves on the matching server Done log and ignores other servers", async () => {
  const waiting = processManager().waitForStartup("server-startup-test", { timeoutMs: 2_000 });
  eventBus.emit("console", { serverId: "other-server", stream: "stdout", text: "Done (1.0s)!", createdAt: new Date().toISOString(), id: "other" });
  setTimeout(() => eventBus.emit("console", { serverId: "server-startup-test", stream: "stdout", text: "[Server thread/INFO]: Done (14.149s)! For help, type \"help\"", createdAt: new Date().toISOString(), id: "match" }), 10);
  const result = await waiting;
  assert.equal(result.ready, true);
  assert.match(result.matchedLog, /Done \(14\.149s\)!/);
  assert.ok(result.elapsedMs < 1_000);
});

test("waitForStartup rejects when the server exits before the startup marker", async () => {
  const waiting = processManager().waitForStartup("server-startup-test", { timeoutMs: 2_000 });
  setTimeout(() => eventBus.emit("serverStatus", { serverId: "server-startup-test", status: "crashed" }), 10);
  await assert.rejects(waiting, /完成启动前已退出/);
});

test("waitForStartup rejects on timeout and respects cancellation", async () => {
  await assert.rejects(processManager().waitForStartup("server-startup-test", { timeoutMs: 1_000 }), /超时/);
  const controller = new AbortController();
  const waiting = processManager().waitForStartup("server-startup-test", { timeoutMs: 2_000, signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting, /已取消/);
});

test("wait_for_server_startup passes the bounded timeout and Agent signal to ProcessManager", async () => {
  let received: { timeoutMs?: number; signal?: AbortSignal } | undefined;
  const signal = new AbortController().signal;
  const tool = createAgentTools({
    getServerId: () => "server-startup-test",
    signal,
    processManager: { waitForStartup: async (_serverId: string, options: typeof received) => { received = options; return { ready: true }; } } as never
  } as unknown as AgentToolContext).find((item) => item.definition.function.name === "wait_for_server_startup")!;
  const result = await tool.execute({ timeoutSeconds: 601 });
  assert.deepEqual(JSON.parse(result), { ready: true });
  assert.equal(received?.timeoutMs, 600_000);
  assert.equal(received?.signal, signal);
});
