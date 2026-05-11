import { createReadStream } from "node:fs";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { idParams, parseBody } from "../helpers.js";
import type { RouteServices } from "../types.js";

export function registerFileRoutes(app: FastifyInstance, services: RouteServices) {
  app.get("/api/servers/:id/files", async (request) => {
    const { id } = idParams.parse(request.params);
    const query = z.object({ path: z.string().optional() }).parse(request.query);
    return services.fileService.list(id, query.path);
  });

  app.get("/api/servers/:id/files/text", async (request) => {
    const { id } = idParams.parse(request.params);
    const query = z.object({ path: z.string().min(1) }).parse(request.query);
    return { content: await services.fileService.readText(id, query.path) };
  });

  app.put("/api/servers/:id/files/text", async (request) => {
    const { id } = idParams.parse(request.params);
    const body = parseBody(z.object({ path: z.string().min(1), content: z.string() }), request.body);
    await services.fileService.writeText(id, body.path, body.content);
    return { ok: true };
  });

  app.post("/api/servers/:id/files/folder", async (request) => {
    const { id } = idParams.parse(request.params);
    const body = parseBody(z.object({ path: z.string().min(1) }), request.body);
    await services.fileService.createFolder(id, body.path);
    return { ok: true };
  });

  app.delete("/api/servers/:id/files", async (request) => {
    const { id } = idParams.parse(request.params);
    const query = z.object({ path: z.string().min(1) }).parse(request.query);
    await services.fileService.remove(id, query.path);
    return { ok: true };
  });

  app.post("/api/servers/:id/files/rename", async (request) => {
    const { id } = idParams.parse(request.params);
    const body = parseBody(z.object({ path: z.string().min(1), newName: z.string().min(1) }), request.body);
    await services.fileService.rename(id, body.path, body.newName);
    return { ok: true };
  });

  app.get("/api/servers/:id/files/download", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const query = z.object({ path: z.string().min(1) }).parse(request.query);
    const file = await services.fileService.resolveDownload(id, query.path);
    reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    reply.header("Content-Length", file.size);
    return reply.send(createReadStream(file.absolutePath));
  });

  app.post("/api/servers/:id/files/upload", async (request) => {
    const { id } = idParams.parse(request.params);
    const file = await request.file();
    if (!file) throw new Error("No file uploaded");
    const directory = String((file.fields.path as { value?: string } | undefined)?.value ?? ".");
    const savedPath = await services.fileService.saveStream(id, directory, file.filename, file.file);
    return { path: savedPath };
  });
}
