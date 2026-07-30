import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { idParams, parseBody } from "../helpers.js";
import type { RouteServices } from "../types.js";

const selectionSchema = z.object({
  regionPath: z.string().min(1).max(512),
  regionFilePath: z.string().min(1).max(512),
  mode: z.enum(["chunks", "rectangle", "region"]),
  chunks: z.array(z.object({ localX: z.number().int().min(0).max(31), localZ: z.number().int().min(0).max(31) })).max(1_024).optional(),
  rectangle: z.object({
    minX: z.number().int().min(0).max(31),
    minZ: z.number().int().min(0).max(31),
    maxX: z.number().int().min(0).max(31),
    maxZ: z.number().int().min(0).max(31)
  }).optional()
});

export function registerMapRoutes(app: FastifyInstance, services: RouteServices) {
  app.get("/api/servers/:id/map/worlds", async (request) => {
    const { id } = idParams.parse(request.params);
    return services.fileService.discoverMapWorlds(id);
  });

  app.get("/api/servers/:id/map/regions", async (request) => {
    const { id } = idParams.parse(request.params);
    const query = z.object({
      regionPath: z.string().min(1),
      offset: z.coerce.number().int().min(0).default(0),
      limit: z.coerce.number().int().min(1).max(256).default(256)
    }).parse(request.query);
    return services.fileService.listMcaRegions(id, query.regionPath, query.offset, query.limit);
  });

  app.get("/api/servers/:id/map/header", async (request) => {
    const { id } = idParams.parse(request.params);
    const query = z.object({ path: z.string().min(1) }).parse(request.query);
    return services.fileService.scanMcaHeader(id, query.path);
  });

  app.get("/api/servers/:id/map/preview", async (request) => {
    const { id } = idParams.parse(request.params);
    const query = z.object({
      path: z.string().min(1),
      localX: z.coerce.number().int().min(0).max(31),
      localZ: z.coerce.number().int().min(0).max(31)
    }).parse(request.query);
    return services.mapService.previewChunk(id, query.path, query.localX, query.localZ);
  });

  app.post("/api/servers/:id/map/plan", async (request) => {
    const { id } = idParams.parse(request.params);
    return services.mapService.planMutation(id, parseBody(selectionSchema, request.body));
  });

  app.post("/api/servers/:id/map/delete", async (request) => {
    const { id } = idParams.parse(request.params);
    const body = parseBody(selectionSchema.extend({
      confirmationPhrase: z.string(),
      snapshotName: z.string().max(120).default(""),
      snapshotDescription: z.string().max(500).default("")
    }), request.body);
    return services.mapService.deleteSelection(id, body, body.confirmationPhrase, body.snapshotName, body.snapshotDescription);
  });

  app.get("/api/servers/:id/map/snapshots", async (request) => {
    const { id } = idParams.parse(request.params);
    return services.mapService.listSnapshots(id);
  });

  app.post("/api/servers/:id/map/snapshots", async (request) => {
    const { id } = idParams.parse(request.params);
    const body = parseBody(selectionSchema.extend({
      name: z.string().max(120).default(""),
      description: z.string().max(500).default("")
    }), request.body);
    return services.mapService.createManualSnapshot(id, body, body.name, body.description);
  });

  app.delete("/api/servers/:id/map/snapshots/:snapshotId", async (request) => {
    const { id, snapshotId } = z.object({ id: z.string().min(1), snapshotId: z.string().min(1) }).parse(request.params);
    const body = parseBody(z.object({ confirmationPhrase: z.string() }), request.body);
    return services.mapService.deleteSnapshot(id, snapshotId, body.confirmationPhrase);
  });

  app.post("/api/servers/:id/map/snapshots/:snapshotId/rollback", async (request) => {
    const { id, snapshotId } = z.object({ id: z.string().min(1), snapshotId: z.string().min(1) }).parse(request.params);
    const body = parseBody(z.object({ confirmationPhrase: z.string() }), request.body);
    return services.mapService.rollbackSnapshot(id, snapshotId, body.confirmationPhrase);
  });

  app.get("/api/servers/:id/map/snapshots/:snapshotId/export", async (request, reply) => {
    const { id, snapshotId } = z.object({ id: z.string().min(1), snapshotId: z.string().min(1) }).parse(request.params);
    const file = await services.mapService.openExport(id, snapshotId);
    reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    reply.header("Content-Length", file.size);
    return reply.send(file.stream);
  });
}
