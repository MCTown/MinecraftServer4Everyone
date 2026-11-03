import assert from "node:assert/strict";
import { test } from "node:test";
import { createFileManagerDriver, fromFinderPath, toFinderEntry, toFinderPath } from "../utils/fileManagerDriver";

test("finder paths and metadata map to sandbox-relative REST data", () => {
  assert.equal(fromFinderPath("files://"), ".");
  assert.equal(fromFinderPath("files://server/mods"), "server/mods");
  assert.equal(toFinderPath("."), "files://");
  for (const input of ["files://../x", "foreign://x", "files:///etc/passwd", "files://a\\b"]) assert.throws(() => fromFinderPath(input));
  const entry = toFinderEntry({ name: "server.properties", path: "server/server.properties", type: "file", size: 42, modifiedAt: "2026-01-01T00:00:00Z", editable: true });
  assert.equal(entry.dir, "files://server"); assert.equal(entry.mime_type, "text/plain");
  assert.equal(entry.last_modified, 1767225600);
});

test("driver maps copy, move, archive, extraction, text and create and refreshes listings", async () => {
  const calls: any[] = [], states: boolean[] = [];
  let changed = 0;
  const driver = createFileManagerDriver({
    request: async (suffix, options) => { calls.push({ suffix, ...options }); return (suffix === "/text" ? { content: "hello" } : []) as any; },
    url: (suffix, path) => `${suffix}?path=${encodeURIComponent(path)}`,
    configureUploader: () => undefined, changed: () => changed++, busy: (value) => states.push(value)
  });
  await driver.copy({ sources: ["files://a.txt"], destination: "files://backup", path: "files://" });
  assert.deepEqual(calls[0], { suffix: "/copy", method: "POST", body: { sources: ["a.txt"], destination: "backup" } });
  await driver.move({ sources: ["files://a.txt"], destination: "files://backup" });
  await driver.archive({ items: [{ path: "files://backup", type: "dir" }], path: "files://", name: "备份.zip" });
  await driver.unarchive({ item: "files://备份.zip", path: "files://backup" });
  await driver.createFile({ path: "files://", name: "new.txt" });
  await driver.rename({ path: "files://", item: "new.txt", name: "new2.txt" });
  assert.deepEqual(calls.find((item) => item.suffix === "/rename").body, { path: "new.txt", name: "new2.txt" });
  assert.equal(await driver.save({ path: "files://new.txt", content: "hello" }), "files://new.txt");
  assert.equal((await driver.getContent({ path: "files://new.txt" })).content, "hello");
  assert.equal(driver.getDownloadUrl({ path: "files://a b.txt" }), "/download?path=a%20b.txt");
  assert.equal(changed, 7); assert.equal(states.at(-1), false);
});

test("failed operations propagate errors and always clear busy state", async () => {
  let busy = false, changed = false;
  const driver = createFileManagerDriver({ request: async () => { throw new Error("目标已存在"); }, url: () => "", configureUploader: () => undefined, changed: () => { changed = true; }, busy: (value) => { busy = value; } });
  await assert.rejects(driver.copy({ sources: ["files://a.txt"], destination: "files://backup" }), /已存在/);
  assert.equal(busy, false); assert.equal(changed, false);
});

test("missing remembered directories recover to root without hiding other failures", async () => {
  const paths: string[] = [];
  const driver = createFileManagerDriver({
    request: async (_suffix, options) => {
      const path = options?.query?.path ?? ".";
      paths.push(path);
      if (path !== ".") throw Object.assign(new Error("missing"), { statusCode: 404 });
      return [] as any;
    },
    url: () => "", configureUploader: () => undefined, changed: () => undefined, busy: () => undefined
  });
  assert.equal((await driver.list({ path: "files://removed" })).dirname, "files://");
  assert.deepEqual(paths, ["removed", "."]);
  const forbidden = createFileManagerDriver({ request: async () => { throw Object.assign(new Error("forbidden"), { statusCode: 403 }); }, url: () => "", configureUploader: () => undefined, changed: () => undefined, busy: () => undefined });
  await assert.rejects(forbidden.list({ path: "files://private" }), /forbidden/);
});
