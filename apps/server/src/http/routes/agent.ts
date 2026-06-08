import { z } from "zod";
import type { MultipartFile } from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import { idParams, parseBody } from "../helpers.js";
import type { RouteServices } from "../types.js";

export function registerAgentRoutes(app: FastifyInstance, services: RouteServices) {
  const reasoningEffortSchema = z.enum(["minimal", "low", "medium", "high"]).default("high");

  app.get("/api/servers/:id/agent/messages", async (request) => {
    const { id } = idParams.parse(request.params);
    return services.agentService.listMessages(id);
  });

  app.post("/api/servers/:id/agent/messages", async (request) => {
    const { id } = idParams.parse(request.params);
    const body = parseBody(z.object({ content: z.string().min(1), reasoningEffort: reasoningEffortSchema }), request.body);
    const response = await services.agentService.sendMessage(id, body.content, body.reasoningEffort);
    return { response };
  });

  app.get("/api/servers/:id/agent/confirmation", async (request) => {
    const { id } = idParams.parse(request.params);
    return { confirmation: services.agentService.getPendingConfirmation(id) };
  });

  app.get("/api/servers/:id/agent/server-slot", async (request) => {
    const { id } = idParams.parse(request.params);
    return services.fileService.getServerSlotStatus(id);
  });

  app.post("/api/servers/:id/agent/confirmation", async (request) => {
    const { id } = idParams.parse(request.params);
    const body = parseBody(z.object({ confirmationId: z.string().min(1), approved: z.boolean() }), request.body);
    return services.agentService.resolveConfirmation(id, body.confirmationId, body.approved);
  });

  app.post("/api/servers/:id/agent/cancel", async (request) => {
    const { id } = idParams.parse(request.params);
    return services.agentService.cancel(id);
  });

  app.post("/api/servers/:id/agent/retry", async (request) => {
    const { id } = idParams.parse(request.params);
    return services.agentService.retryNow(id);
  });

  app.delete("/api/servers/:id/agent/context", async (request) => {
    const { id } = idParams.parse(request.params);
    return services.agentService.clearContext(id);
  });

  app.post("/api/uploads/:sessionId", async (request) => {
    const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
    const file = await request.file() as MultipartFile | undefined;
    if (!file) throw new Error("No file uploaded");
    return services.uploadService.save(params.sessionId, file);
  });

  app.get("/api/uploads/:sessionId", async (request) => {
    const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
    return services.uploadService.list(params.sessionId);
  });
}
