import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appConfig } from "../src/config.js";
import { getSqlite, initDatabase } from "../src/db/client.js";
import { SessionStore, appendRuntimeContext, compactBoundary } from "../src/agent/sessionStore.js";
import type { ChatMessageInput } from "../src/services/modelService.js";

let root: string;
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "cache-session-"));
  appConfig.dataDir = root;
  initDatabase();
});
after(async () => { getSqlite().close(); await rm(root, { recursive: true, force: true }); });

test("append-only log rejects silent rewrites; explicit compaction preserves original audit events", () => {
  const store = new SessionStore();
  const messages: ChatMessageInput[] = [{ role: "system", content: "policy" }, { role: "user", content: "original" }];
  store.commit("test", messages);
  messages[1]!.content = "changed";
  assert.throws(() => store.commit("test", messages), /未声明/);
  store.commit("test", messages, true);
  assert.equal(new SessionStore().messages("test")[1]?.content, "changed");
  assert.match(store.events("test")[0]!.payload, /original/);
  store.clear("test");
  assert.deepEqual(store.messages("test"), []);
  assert.match(store.events("test")[0]!.payload, /original/);
});

test("runtime snapshots are deduplicated and appended, never inserted before cached history", () => {
  const messages: ChatMessageInput[] = [{ role: "system", content: "stable" }, { role: "user", content: "task" }];
  appendRuntimeContext(messages, "stopped");
  const previous = structuredClone(messages);
  appendRuntimeContext(messages, "stopped");
  assert.deepEqual(messages, previous);
  appendRuntimeContext(messages, "running");
  assert.deepEqual(messages.slice(0, previous.length), previous);
});

test("last-request cache usage survives service recreation and resets on clear", () => {
  const store = new SessionStore();
  store.saveUsage("usage", { promptTokens: 100, completionTokens: 1, totalTokens: 101, cacheHitTokens: 90 });
  assert.equal(new SessionStore().cacheUsage("usage").status, "available");
  store.saveUsage("usage", null);
  assert.equal(store.cacheUsage("usage").status, "unavailable");
  store.saveUsage("usage", { promptTokens: 100, completionTokens: 1, totalTokens: 101, cacheHitTokens: 50 });
  store.clear("usage");
  assert.equal(store.cacheUsage("usage").status, "unavailable");
});

test("compaction never splits multi-tool assistant/result groups", () => {
  const messages: ChatMessageInput[] = [{ role: "system", content: "stable" }, { role: "user", content: "task" },
    { role: "assistant", content: "", tool_calls: ["a", "b"].map((id) => ({ id, type: "function", function: { name: "read", arguments: "{}" } })) },
    { role: "tool", tool_call_id: "a", content: "first" }, { role: "tool", tool_call_id: "b", content: "second" },
    { role: "assistant", content: "done" }];
  for (let retain = 1; retain < 8; retain++) {
    const boundary = compactBoundary(messages, retain, () => 1);
    assert.notEqual(messages[boundary]?.role, "tool");
    assert.ok(boundary === 1 || boundary === 2 || boundary === 5);
  }
});
