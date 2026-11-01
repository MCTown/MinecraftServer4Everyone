import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { TemplateService, resolveReferenceTemplateDir } from "../src/services/templateService.js";

test("template edits are copy-on-write and reset restores the default snapshot", async () => {
  const root = await mkdtemp("/tmp/opencode/template-service-");
  const reference = path.join(root, "reference"), custom = path.join(root, "reference-custom");
  try {
    await mkdir(path.join(reference, "plugins"), { recursive: true });
    await writeFile(path.join(reference, "config.yml"), "language: en_us\n");
    await writeFile(path.join(reference, "plugins", "Old.mcdr"), "zip");
    const service = new TemplateService(root);

    const initial = await service.getState();
    assert.equal(initial.customized, false);
    assert.deepEqual(initial.files.map((file) => file.path), ["config.yml", "plugins", "plugins/Old.mcdr"]);
    assert.equal(await service.readText("config.yml"), "language: en_us\n");

    await service.writeText("config.yml", "language: zh_cn\n");
    assert.equal(await resolveReferenceTemplateDir(root), custom);
    assert.equal(await readFile(path.join(reference, "config.yml"), "utf8"), "language: en_us\n");
    assert.equal(await service.readText("config.yml"), "language: zh_cn\n");

    await service.saveStream("plugins", "New.mcdr", Readable.from(["data"]));
    await service.remove("plugins/Old.mcdr");
    const edited = await service.getState();
    assert.equal(edited.customized, true);
    assert.deepEqual(edited.files.map((file) => file.path), ["config.yml", "plugins", "plugins/New.mcdr"]);

    await assert.rejects(service.remove("."), /根目录/);
    await assert.rejects(service.readText("../reference/config.yml"), /traversal/);
    await assert.rejects(service.writeText("plugins/x.mcdr", "binary"), /文本编辑/);

    const reset = await service.reset();
    assert.equal(reset.customized, false);
    assert.equal(await resolveReferenceTemplateDir(root), reference);
    assert.equal(await service.readText("config.yml"), "language: en_us\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
