import assert from "node:assert/strict";
import { test } from "node:test";
import { readBrowserState, writeBrowserState } from "../utils/browserState";

test("drafts and outbox survive reload, can be cleared, and tolerate unavailable storage", (t) => {
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
  const state = { instances: { a: { input: "draft", attachments: [{ uploadId: "upload" }] } } };
  writeBrowserState("workspace", state);
  assert.deepEqual(readBrowserState("workspace"), state);
  assert.equal(readBrowserState("missing"), null);
  entries.set("mcsa:workspace", "invalid-json");
  assert.equal(readBrowserState("workspace"), null);
  writeBrowserState("workspace", state);
  writeBrowserState("workspace", null);
  assert.equal(readBrowserState("workspace"), null);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("quota"); } } });
  assert.equal(readBrowserState("workspace"), null);
  assert.doesNotThrow(() => writeBrowserState("workspace", state));
});
