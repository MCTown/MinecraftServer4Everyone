import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { registerFileManagerRoutes } from "../src/http/routes/fileManager.js";
import { registerErrorHandling } from "../src/http/errors.js";
import { generateAuthToken } from "../src/http/routes/auth.js";
import { appConfig } from "../src/config.js";
import { FileManagerService } from "../src/services/fileManagerService.js";
import { TemplateService } from "../src/services/templateService.js";
import type { RouteServices } from "../src/http/types.js";

test("instance/template manager HTTP routes authenticate, validate and support complete file workflows", async (t) => {
  const root = await mkdtemp("/tmp/opencode/manager-routes-");
  const instance = path.join(root, "instance"), templates = path.join(root, "templates");
  await mkdir(instance); await mkdir(path.join(templates, "reference"), { recursive: true });
  for (const base of [instance, path.join(templates, "reference")]) await writeFile(path.join(base, "config.yml"), "default");
  const app = Fastify();
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  await app.register(multipart);
  registerErrorHandling(app);
  const ids: string[] = [];
  registerFileManagerRoutes(app, {
    fileService: { manager(id: string) { ids.push(id); return new FileManagerService(async () => instance, new Set([".yml", ".txt"])); } },
    templateService: new TemplateService(templates)
  } as unknown as RouteServices);
  const headers = { cookie: `mcsa_token=${generateAuthToken(appConfig.secretKey)}` };
  for (const base of ["/api/servers/test-instance/files/manager", "/api/settings/mcdr-template/manager"]) {
    if (appConfig.password) assert.equal((await app.inject({ url: base })).statusCode, 401);
    const post = (suffix: string, payload: Record<string, unknown>) => app.inject({ method: "POST", url: base + suffix, headers, payload });
    assert.equal((await app.inject({ url: base, headers })).statusCode, 200);
    assert.equal((await post("/copy", { sources: [], destination: "." })).statusCode, 400);
    assert.equal((await post("/create", { path: ".", name: "../x", type: "file" })).statusCode, 400);
    assert.equal((await app.inject({ url: `${base}?path=../outside`, headers })).statusCode, 400);
    assert.equal((await app.inject({ url: `${base}/text?path=missing.txt`, headers })).statusCode, 404);
    assert.equal((await post("/create", { path: ".", name: "backup", type: "directory" })).statusCode, 200);
    assert.equal((await post("/copy", { sources: ["config.yml"], destination: "backup" })).statusCode, 200);
    assert.equal((await post("/rename", { path: "backup/config.yml", name: "copy.yml" })).statusCode, 200);
    assert.equal((await post("/move", { sources: ["backup/copy.yml"], destination: "." })).statusCode, 200);
    assert.equal((await app.inject({ method: "PUT", url: `${base}/text`, headers, payload: { path: "copy.yml", content: "已修改" } })).statusCode, 200);
    assert.equal((await post("/archive", { sources: ["copy.yml"], destination: ".", name: "bundle.zip" })).statusCode, 200);
    assert.equal((await post("/unarchive", { path: "bundle.zip", destination: "backup" })).statusCode, 200);
    assert.equal((await post("/unarchive", { path: "bundle.zip", destination: "backup" })).statusCode, 409);
    const download = await app.inject({ url: `${base}/download?path=copy.yml`, headers });
    assert.equal(download.statusCode, 200); assert.equal(download.body, "已修改");
    assert.match(download.headers["content-disposition"] as string, /attachment/);
    assert.equal((await app.inject({ url: `${base}/preview?path=copy.yml`, headers })).statusCode, 415);
    const boundary = "file-manager-test";
    const upload = `--${boundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\nuploaded/sub\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="hello.txt"\r\nContent-Type: text/plain\r\n\r\nupload data\r\n--${boundary}--\r\n`;
    const sendUpload = () => app.inject({ method: "POST", url: `${base}/upload`, headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` }, payload: upload });
    assert.equal((await sendUpload()).statusCode, 200);
    assert.equal((await sendUpload()).statusCode, 409);
    const text = await app.inject({ url: `${base}/text?path=uploaded/sub/hello.txt`, headers });
    assert.deepEqual(text.json(), { content: "upload data" });
    assert.equal((await post("/delete", { sources: ["uploaded", "backup", "copy.yml", "bundle.zip"] })).statusCode, 200);
  }
  assert.ok(ids.every((id) => id === "test-instance"));
  assert.equal(await readFile(path.join(templates, "reference/config.yml"), "utf8"), "default");
});
