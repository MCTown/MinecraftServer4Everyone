import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConsoleLogEntry } from "../src/types.js";
import { ProcessManager } from "../src/services/processManager.js";
import { eventBus } from "../src/services/eventBus.js";
import { createAgentTools } from "../src/agent/tools.js";
import type { AgentToolContext } from "../src/agent/toolKit.js";

const id = "server-command-test";
const reply = "[Server thread/INFO] [minecraft/MinecraftServer]: There are 0 of a max of 20 players online: ";
function harness() {
  const entries: ConsoleLogEntry[] = [];
  const manager = new ProcessManager({} as never, { listAll: () => entries } as never, {} as never, {} as never);
  const internals = manager as unknown as { running: object | null };
  internals.running = { serverId: id, launchId: "launch-one", startedAt: new Date().toISOString(), rootPid: 1, logs: entries };
  const writes: string[] = [];
  manager.sendCommand = (_server, command) => { writes.push(command); };
  const emit = (text: string, serverId = id, stream: ConsoleLogEntry["stream"] = "stdout") => {
    const entry = { serverId, id: String(entries.length), createdAt: new Date().toISOString(), stream, text };
    entries.push(entry); eventBus.emit("managedConsole", { launchId: "launch-one", entry });
  };
  return { manager, internals, writes, emit };
}
function listenerCounts() { return ["console", "managedConsole", "consoleClear", "serverStatus"].map((key) => eventBus.listenerCount(key)); }

test("command wait ignores historical, other-server and system output, and accepts split response", async () => {
  const h = harness(); const counts = listenerCounts();
  h.emit(`${reply}\n`);
  const promise = h.manager.sendCommandAndWait(id, "list", { responseType: "players", timeoutMs: 1000 });
  let done = false; void promise.then(() => { done = true; });
  h.emit(`${reply}\n`, "other"); h.emit(`${reply}\n`, id, "system");
  h.emit("plugin carpetbotlist loaded\nUUID list size: 0\n");
  // Presentation-console events from Shell output must never satisfy command waits.
  eventBus.emit("console", { id: "shell", serverId: id, stream: "stdout", text: `${reply}\n`, createdAt: new Date().toISOString() });
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(done, false);
  h.emit("[Server thread/INFO] [minecraft/MinecraftServer]: There are 0 of a max of ");
  h.emit("20 players online: \n");
  const result = await promise;
  assert.equal(result.status, "matched"); assert.equal(result.cursor, "0");
  assert.equal(result.launchId, "launch-one"); assert.equal(result.sent, true);
  assert.match(result.evidence!.text, /players online/); assert.deepEqual(h.writes, ["list"]);
  assert.deepEqual(listenerCounts(), counts);
});

test("command subscribes before sending and catches synchronous response", async () => {
  const h = harness();
  h.manager.sendCommand = () => h.emit(`${reply}\n`);
  assert.equal((await h.manager.sendCommandAndWait(id, "list", { responseType: "players" })).status, "matched");
});

test("timeout returns delivery ambiguity without throwing or sending twice", async () => {
  const h = harness(); const counts = listenerCounts();
  const result = await h.manager.sendCommandAndWait(id, "list", { responseType: "players", timeoutMs: 100 });
  assert.equal(result.status, "timed_out"); assert.equal(result.sent, true);
  assert.match(result.detail, /不代表.*未运行/); assert.deepEqual(h.writes, ["list"]);
  assert.deepEqual(listenerCounts(), counts);
});

test("pre-abort never sends; active abort only cancels waiting", async () => {
  for (const pre of [true, false]) {
    const h = harness(); const counts = listenerCounts(); const controller = new AbortController();
    if (pre) controller.abort();
    const waiting = h.manager.sendCommandAndWait(id, "list", { responseType: "players", signal: controller.signal });
    controller.abort();
    if (pre) await assert.rejects(waiting, /未发送/);
    else { const result = await waiting; assert.equal(result.status, "cancelled"); assert.equal(result.sent, true); }
    assert.equal(h.writes.length, pre ? 0 : 1); assert.deepEqual(listenerCounts(), counts);
  }
});

test("clear, stop and launch change fence response waiting, releasing listeners", async () => {
  for (const action of ["clear", "stop", "new-launch"]) {
    const h = harness(); const counts = listenerCounts();
    const waiting = h.manager.sendCommandAndWait(id, "list", { responseType: "players" });
    if (action === "clear") eventBus.emit("consoleClear", { serverId: id });
    else if (action === "stop") eventBus.emit("serverStatus", { serverId: id, status: "stopping" });
    else { h.internals.running = { serverId: id, launchId: "different" }; h.emit(`${reply}\n`); }
    const result = await waiting; assert.equal(result.status, "interrupted"); assert.equal(result.sent, true);
    assert.deepEqual(listenerCounts(), counts);
  }
});

test("one pending command per instance; write failure releases lease; unsafe match inputs do not send", async () => {
  const h = harness();
  const waiting = h.manager.sendCommandAndWait(id, "list", { responseType: "players" });
  await assert.rejects(h.manager.sendCommandAndWait(id, "list", { responseType: "players" }), /未发送/);
  h.emit(`${reply}\n`); await waiting;
  h.manager.sendCommand = () => { throw new Error("broken input"); };
  assert.equal((await h.manager.sendCommandAndWait(id, "list", { responseType: "players" })).status, "send_failed");
  for (const [command, options] of [["stop\nlist", { responseType: "players" }], ["stop", { responseType: "players" }], ["custom", {}], ["custom", { responseContains: "" }]] as const) {
    await assert.rejects(h.manager.sendCommandAndWait(id, command, options));
  }
  assert.deepEqual(h.writes, ["list"]);
});

test("custom responses use literal matching, never user regex", async () => {
  const h = harness();
  const waiting = h.manager.sendCommandAndWait(id, "custom", { responseContains: "[saved].*" });
  h.emit("[Server] [saved].* complete\n");
  assert.equal((await waiting).status, "matched");
});

test("tool waits for list by default; preserves send-only and passes cancellation/timeout", async () => {
  const signal = new AbortController().signal; const writes: string[] = []; const calls: unknown[] = [];
  const tool = createAgentTools({ getServerId: () => id, signal, processManager: {
    sendCommand: (_id: string, command: string) => writes.push(command),
    sendCommandAndWait: async (...args: unknown[]) => { calls.push(args); return { status: "matched", sent: true }; }
  } } as unknown as AgentToolContext).find((tool) => tool.definition.function.name === "send_current_server_command")!;
  assert.equal(JSON.parse(await tool.execute({ command: "list", timeoutSeconds: 1000 })).status, "matched");
  await tool.execute({ command: "list", waitForResponse: false }); await tool.execute({ command: "say hello" });
  assert.deepEqual(writes, ["list", "say hello"]);
  assert.deepEqual(calls[0], [id, "list", { responseType: "players", responseContains: undefined, timeoutMs: 60000, signal }]);
  await assert.rejects(tool.execute({ command: "say x\nstop" }));
});
