import { createReadStream } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { idParams, parseBody } from "../helpers.js";
import type { RouteServices } from "../types.js";
import type { FileManagerService } from "../../services/fileManagerService.js";

const userPath = z.string().min(1).max(4096);
const pathQuery = z.object({ path: userPath });
const sources = z.array(userPath).min(1).max(1000);

export function registerFileManagerRoutes(app: FastifyInstance, services: RouteServices) {
  void app.register(async (scope) => {
    scope.setErrorHandler((error: Error & { code?: string; statusCode?: number }, _request, reply) => {
      if (error instanceof z.ZodError) return reply.code(400).send({ error: "文件操作参数无效", details: error.issues });
      const status = error.statusCode ?? ({ ENOENT: 404, EEXIST: 409, ENOTDIR: 400, EISDIR: 400, EACCES: 403, EPERM: 403 } as Record<string, number>)[error.code ?? ""];
      if (status) return reply.code(status).send({ error: error.message });
      throw error; // Delegate unexpected failures to the application's logger.
    });
    registerScope(scope, "/api/servers/:id/files/manager", (request) => services.fileService.manager(idParams.parse(request.params).id));
    registerScope(scope, "/api/settings/mcdr-template/manager", () => services.templateService.manager());
  });
}

function registerScope(app: FastifyInstance, base: string, manager: (request: FastifyRequest) => FileManagerService) {
  app.get(base, (request) => {
    const query = z.object({ path: userPath.optional() }).parse(request.query);
    return manager(request).list(query.path);
  });
  app.get(`${base}/search`, (request) => {
    const query = z.object({ path: userPath, filter: z.string().min(1).max(256), deep: z.enum(["0", "1"]).default("0") }).parse(request.query);
    return manager(request).search(query.path, query.filter, query.deep === "1");
  });
  app.get(`${base}/text`, async (request) => ({ content: await manager(request).readText(pathQuery.parse(request.query).path) }));
  app.put(`${base}/text`, async (request) => {
    const body = parseBody(z.object({ path: userPath, content: z.string().max(2 * 1024 * 1024) }), request.body);
    await manager(request).save(body.path, body.content);
    return { ok: true };
  });
  app.post(`${base}/create`, async (request) => {
    const body = parseBody(z.object({ path: userPath, name: z.string().min(1).max(255), type: z.enum(["file", "directory"]) }), request.body);
    await manager(request).create(body.path, body.name, body.type === "directory");
    return { ok: true };
  });
  app.post(`${base}/delete`, async (request) => {
    const body = parseBody(z.object({ sources }), request.body);
    await manager(request).remove(body.sources);
    return { ok: true };
  });
  app.post(`${base}/rename`, async (request) => {
    const body = parseBody(z.object({ path: userPath, name: z.string().min(1).max(255) }), request.body);
    await manager(request).rename(body.path, body.name);
    return { ok: true };
  });
  for (const operation of ["copy", "move"] as const) {
    app.post(`${base}/${operation}`, async (request) => {
      const body = parseBody(z.object({ sources, destination: userPath }), request.body);
      await manager(request).transfer(body.sources, body.destination, operation === "move");
      return { ok: true };
    });
  }
  app.post(`${base}/archive`, async (request) => {
    const body = parseBody(z.object({ sources, destination: userPath, name: z.string().min(1).max(255) }), request.body);
    await manager(request).archive(body.sources, body.destination, body.name);
    return { ok: true };
  });
  app.post(`${base}/unarchive`, async (request) => {
    const body = parseBody(z.object({ path: userPath, destination: userPath }), request.body);
    await manager(request).unarchive(body.path, body.destination);
    return { ok: true };
  });
  app.post(`${base}/upload`, async (request) => {
    const file = await request.file({ limits: { fileSize: 20 * 1024 ** 3, files: 1 } });
    if (!file) throw Object.assign(new Error("没有选择上传文件"), { statusCode: 400 });
    const directory = userPath.parse((file.fields.path as { value?: string } | undefined)?.value ?? ".");
    await manager(request).upload(directory, file.filename, file.file);
    return { ok: true };
  });
  app.get(`${base}/download`, async (request, reply) => {
    const file = await manager(request).download(pathQuery.parse(request.query).path);
    reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    reply.header("Content-Length", file.size);
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.type("application/octet-stream").send(createReadStream(file.absolutePath));
  });
  app.get(`${base}/preview`, async (request, reply) => {
    const file = await manager(request).download(pathQuery.parse(request.query).path);
    const mime: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".avif": "image/avif" };
    const type = mime[path.extname(file.fileName).toLowerCase()];
    if (!type) return reply.code(415).send({ error: "该文件不支持图片预览，请下载查看" });
    reply.header("Content-Length", file.size);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Content-Security-Policy", "default-src 'none'; sandbox");
    return reply.type(type).send(createReadStream(file.absolutePath));
  });
}
