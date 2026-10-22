import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { syncReferenceTemplate } from "../src/runtime.js";

test("runtime template replacement removes stale files and preserves a recovery copy", async () => {
  const root = await mkdtemp("/tmp/opencode/template-sync-");
  const source = path.join(root, "bundled"), destination = path.join(root, "reference");
  try {
    await mkdir(source); await mkdir(destination);
    await writeFile(path.join(source, "current"), "new");
    await writeFile(path.join(destination, "obsolete"), "old");
    await syncReferenceTemplate(source, destination);
    assert.deepEqual(await readdir(destination), ["current"]);
    const backup = (await readdir(root)).find((name) => name.endsWith(".previous"))!;
    assert.equal(await readFile(path.join(root, backup, "obsolete"), "utf8"), "old");
    await assert.rejects(syncReferenceTemplate(path.join(root, "missing"), destination));
    assert.equal(await readFile(path.join(destination, "current"), "utf8"), "new");
    assert.ok(!(await readdir(root)).some((name) => name.includes(".staging-") && !name.endsWith(".previous")));
  } finally { await rm(root, { recursive: true, force: true }); }
});
