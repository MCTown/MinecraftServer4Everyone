import assert from "node:assert/strict";
import { test } from "node:test";
import { nodeApiPath, nodeSocketPath, nodeStateKey, routeNodeId } from "../utils/nodeRouting";
import { readNodeBrowserState, readBrowserState, writeBrowserState } from "../utils/browserState";

test("node identity scopes API, WebSocket, downloads and browser keys, not connector login", () => {
  assert.equal(nodeApiPath("/api/servers/same-id/files?path=a%2Fb", "a"), "/api/nodes/a/servers/same-id/files?path=a%2Fb");
  assert.equal(nodeApiPath("/api/settings/models", "b"), "/api/nodes/b/settings/models");
  assert.equal(nodeApiPath("/api/auth/verify", "a"), "/api/auth/verify");
  assert.equal(nodeApiPath("/api/connector/nodes", "b"), "/api/connector/nodes");
  assert.equal(nodeSocketPath("/ws/agent/global", "a"), "/ws/nodes/a/agent/global");
  assert.equal(nodeSocketPath("/ws/console/same-id", "b"), "/ws/nodes/b/console/same-id");
  assert.equal(nodeApiPath("/api/servers", ""), "/api/servers");
  assert.notEqual(nodeStateKey("a", "workspace"), nodeStateKey("b", "workspace"));
  assert.equal(routeNodeId(["a", "b"]), "");
  assert.equal(routeNodeId("../a"), "");
  assert.equal(routeNodeId("node-01"), "node-01");
});

test("node drafts and pending Agent messages remain isolated; legacy migration happens only once", (t) => {
  const entries = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
    removeItem: (key: string) => entries.delete(key)
  } });
  for (const key of ["workspace", "outbox", "file-draft:instance-files-same-id", "question:global"]) {
    writeBrowserState(key, { legacy: true });
    assert.equal(readNodeBrowserState("remote", key), null);
    assert.deepEqual(readNodeBrowserState("local", key), { legacy: true });
    assert.equal(readBrowserState(key), null);
    writeBrowserState(nodeStateKey("remote", key), { remote: true });
    assert.deepEqual(readNodeBrowserState("remote", key), { remote: true });
    assert.deepEqual(readNodeBrowserState("local", key), { legacy: true });
    writeBrowserState(nodeStateKey("local", key), null);
    assert.equal(readNodeBrowserState("local", key), null);
  }
});
