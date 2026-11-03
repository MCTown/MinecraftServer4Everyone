import assert from "node:assert/strict";
import { test } from "node:test";
import { createWriteStream } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink, link, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";
import { create as createTar } from "tar";
import { FileManagerService } from "../src/services/fileManagerService.js";
import { TemplateService } from "../src/services/templateService.js";

async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const base = await mkdtemp("/tmp/opencode/file-manager-");
  t.after(() => rm(base, { recursive: true, force: true }));
  const service = new FileManagerService(async () => base, new Set([".txt", ".yml", ".properties"]));
  await mkdir(path.join(base, "plugins")); await mkdir(path.join(base, "backup"));
  await writeFile(path.join(base, "config.yml"), "language: zh_cn\n");
  await writeFile(path.join(base, "plugins", "测试.jar"), "binary");
  return { base, service };
}

test("file manager browses, creates any file, edits allowed text, searches, renames and deletes", async (t) => {
  const { base, service } = await fixture(t);
  assert.equal((await service.list()).find((item) => item.name === "config.yml")?.editable, true);
  await service.create(".", "new.jar", false);
  assert.equal((await stat(path.join(base, "new.jar"))).size, 0);
  await service.create(".", "server.properties", false);
  await service.save("server.properties", "motd=Hello 世界\n");
  assert.equal(await service.readText("server.properties"), "motd=Hello 世界\n");
  await assert.rejects(service.save("new.jar", "bad"), /文本编辑/);
  assert.deepEqual((await service.search(".", "测试", true)).map((item) => item.path), ["plugins/测试.jar"]);
  assert.deepEqual(await service.search(".", "测试", false), []);
  await service.rename("plugins/测试.jar", "测试 2.jar");
  await service.remove(["plugins", "plugins/测试 2.jar"]);
  await assert.rejects(stat(path.join(base, "plugins")), /ENOENT/);
  await assert.rejects(service.remove(["."]), /根目录/);
  await assert.rejects(service.rename(".", "root"), /根目录/);
});

test("copy/move preserves sources, rejects conflicts before applying a batch, rejects descendants", async (t) => {
  const { base, service } = await fixture(t);
  await service.transfer(["plugins", "config.yml"], "backup", false);
  assert.equal(await readFile(path.join(base, "backup", "plugins", "测试.jar"), "utf8"), "binary");
  assert.equal(await readFile(path.join(base, "config.yml"), "utf8"), "language: zh_cn\n");
  await service.create(".", "destination", true);
  await service.transfer(["backup/config.yml"], "destination", true);
  await assert.rejects(stat(path.join(base, "backup/config.yml")), /ENOENT/);
  await assert.rejects(service.transfer(["plugins"], "plugins", false), /自身/);
  await service.create("plugins", "child", true);
  await assert.rejects(service.transfer(["plugins"], "plugins/child", true), /子目录/);
  await service.create(".", "fresh.txt", false);
  await assert.rejects(service.transfer(["fresh.txt", "plugins"], "backup", true), /已存在/);
  assert.ok(await stat(path.join(base, "fresh.txt")));
  await assert.rejects(stat(path.join(base, "backup/fresh.txt")), /ENOENT/);
  await assert.rejects(service.rename("fresh.txt", "config.yml"), /已存在/);
});

test("ZIP roundtrip includes nested/empty folders and UTF-8 names, refuses overwrite", async (t) => {
  const { base, service } = await fixture(t);
  await service.create("plugins", "空目录", true);
  await service.archive(["plugins", "plugins/测试.jar", "config.yml"], ".", "备份.zip");
  await service.unarchive("备份.zip", "backup");
  assert.equal(await readFile(path.join(base, "backup/plugins/测试.jar"), "utf8"), "binary");
  assert.ok((await stat(path.join(base, "backup/plugins/空目录"))).isDirectory());
  await assert.rejects(service.unarchive("备份.zip", "backup"), /已存在/);
  await assert.rejects(service.archive(["plugins"], "plugins", "recursive.zip"), /被压缩/);
  await assert.rejects(service.archive(["plugins"], ".", "备份.zip"), /已存在/);
  assert.ok(!(await readdir(base)).some((item) => item.startsWith(".file-manager-")));
});

test("TAR.GZ extraction works and rejects links before publishing anything", async (t) => {
  const { base, service } = await fixture(t);
  await createTar({ file: path.join(base, "bundle.tar.gz"), gzip: true, cwd: base }, ["plugins", "config.yml"]);
  await service.unarchive("bundle.tar.gz", "backup");
  assert.equal(await readFile(path.join(base, "backup/config.yml"), "utf8"), "language: zh_cn\n");
  await symlink("config.yml", path.join(base, "link.yml"));
  await createTar({ file: path.join(base, "unsafe.tgz"), gzip: true, cwd: base }, ["config.yml", "link.yml"]);
  await service.create(".", "empty", true);
  await assert.rejects(service.unarchive("unsafe.tgz", "empty"), /链接/);
  assert.deepEqual(await readdir(path.join(base, "empty")), []);
});

test("ZIP rejects traversal, absolute paths and symlink payloads without publishing", async (t) => {
  const { base, service } = await fixture(t);
  const writeZip = async (name: string, filename: string, mode?: number) => {
    const zip = new ZipFile();
    zip.addBuffer(Buffer.from("payload"), filename, mode ? { mode } : undefined);
    const output = pipeline(zip.outputStream, createWriteStream(path.join(base, name)));
    zip.end(); await output;
  };
  await writeZip("link.zip", "link", 0o120777);
  await assert.rejects(service.unarchive("link.zip", "backup"), /链接/);
  // Patch equal-length names in local and central headers to construct hostile
  // fixtures (yazl correctly refuses creating them through its normal API).
  await writeZip("traversal.zip", "xx/evil.txt");
  const bytes = await readFile(path.join(base, "traversal.zip"));
  for (let i = 0; i < bytes.length - 10; i++) if (bytes.subarray(i, i + 11).equals(Buffer.from("xx/evil.txt"))) bytes.write("../evil.txt", i);
  await writeFile(path.join(base, "traversal.zip"), bytes);
  await assert.rejects(service.unarchive("traversal.zip", "backup"));
  assert.deepEqual(await readdir(path.join(base, "backup")), []);
});

test("sandbox rejects traversal, symlink ancestors/dangling links and hardlink content", async (t) => {
  const { base, service } = await fixture(t);
  await symlink("config.yml", path.join(base, "alias.yml"));
  await symlink("/tmp/opencode", path.join(base, "outside"));
  await symlink("missing", path.join(base, "dangling"));
  await link(path.join(base, "config.yml"), path.join(base, "hard.yml"));
  await assert.rejects(service.list("../"), /traversal/);
  await assert.rejects(service.readText("alias.yml"), /符号链接/);
  await assert.rejects(service.create("outside", "escaped.txt", false), /符号链接/);
  await assert.rejects(service.upload("dangling", "x.txt", Readable.from(["x"])), /符号链接/);
  await assert.rejects(service.save("hard.yml", "bad"), /链接/);
  await assert.rejects(service.transfer(["hard.yml"], "backup", false), /链接/);
  assert.equal(await readFile(path.join(base, "config.yml"), "utf8"), "language: zh_cn\n");
  assert.ok(!(await service.list()).some((item) => item.path === "alias.yml"));
});

test("uploads are exclusive, preserve directories, and failed streams clean staging", async (t) => {
  const { base, service } = await fixture(t);
  await service.upload("plugins/sub", "test.jar", Readable.from(["data"]));
  await assert.rejects(service.upload("plugins/sub", "test.jar", Readable.from(["replacement"])), /已存在/);
  const broken = Readable.from((async function* () { yield "partial"; throw new Error("interrupted"); })());
  await assert.rejects(service.upload(".", "fail.txt", broken), /interrupted/);
  const truncated = Object.assign(Readable.from(["incomplete"]), { truncated: true });
  await assert.rejects(service.upload(".", "truncated.txt", truncated), /大小限制/);
  await assert.rejects(stat(path.join(base, "truncated.txt")), /ENOENT/);
  await assert.rejects(stat(path.join(base, "fail.txt")), /ENOENT/);
  assert.ok(!(await readdir(base)).some((item) => item.startsWith(".file-manager-")));
});

test("template file manager mutations are copy-on-write including move, archive and extraction", async (t) => {
  const { base } = await fixture(t);
  const reference = path.join(base, "reference");
  await mkdir(reference); await writeFile(path.join(reference, "config.yml"), "default");
  const template = new TemplateService(base), manager = template.manager();
  assert.equal((await template.getState()).customized, false);
  await manager.create(".", "backup", true);
  await manager.transfer(["config.yml"], "backup", false);
  await manager.archive(["backup"], ".", "backup.zip");
  await manager.rename("config.yml", "renamed.yml");
  await manager.create(".", "extract", true);
  await manager.unarchive("backup.zip", "extract");
  assert.equal((await template.getState()).customized, true);
  assert.deepEqual(await readdir(reference), ["config.yml"]);
  assert.equal(await readFile(path.join(reference, "config.yml"), "utf8"), "default");
  await template.reset();
  assert.equal(await manager.readText("config.yml"), "default");
  assert.equal((await template.getState()).customized, false);
});
