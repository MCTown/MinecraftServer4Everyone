import { z } from "zod";
import type { MultipartFile } from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import { idParams, parseBody } from "../helpers.js";
import type { RouteServices } from "../types.js";

export function registerAgentRoutes(app: FastifyInstance, services: RouteServices) {
  app.post("/api/servers/:id/agent/requests", async (request) => {
    const { id } = idParams.parse(request.params);
    const body = parseBody(z.object({ requestId: z.string().min(1).max(128), content: z.string().min(1), reasoningEffort: z.enum(["minimal", "low", "medium", "high"]).default("high"), benchmark: z.object({ mode: z.enum(["full", "basic"]) }).optional() }), request.body);
    return services.agentService.acceptMessage(id, body.requestId, body.content, body.reasoningEffort, body.benchmark);
  });
  app.get("/api/servers/:id/agent/question", async (request) => ({ question: services.agentService.getPendingQuestion(idParams.parse(request.params).id) }));
  app.post("/api/servers/:id/agent/question", async (request) => {
    const { id } = idParams.parse(request.params);
    const body = parseBody(z.object({ questionId: z.string().min(1), selected: z.array(z.string()).max(20), cancelled: z.boolean().default(false) }), request.body);
    return services.agentService.resolveQuestion(id, body.questionId, body.selected, body.cancelled);
  });
  const inboxParams = z.object({ id: z.string().min(1), inboxId: z.string().min(1) });
  app.get("/api/servers/:id/agent/tools/jobs", async (request) => services.agentService.listToolJobs(idParams.parse(request.params).id));
  app.get("/api/servers/:id/agent/tools/jobs/:jobId/output", async (request) => {
    const { id, jobId } = z.object({ id: z.string().min(1), jobId: z.string().min(1) }).parse(request.params);
    const { cursor } = z.object({ cursor: z.coerce.number().int().min(0).default(0) }).parse(request.query);
    return services.agentService.getToolOutput(id, jobId, cursor);
  });
  app.delete("/api/servers/:id/agent/tools/jobs/:jobId", async (request) => {
    const { id, jobId } = z.object({ id: z.string().min(1), jobId: z.string().min(1) }).parse(request.params);
    return services.agentService.cancelToolJob(id, jobId);
  });
  app.post("/api/servers/:id/agent/background", async (request) => services.agentService.backgroundTools(idParams.parse(request.params).id));
  app.get("/api/servers/:id/agent/inbox", async (request) => services.agentService.listInbox(idParams.parse(request.params).id));
  app.get("/api/servers/:id/agent/inbox/events", async (request) => {
    const { after } = z.object({ after: z.coerce.number().int().min(0).default(0) }).parse(request.query);
    return services.agentService.listInboxEvents(idParams.parse(request.params).id, after);
  });
  app.post("/api/servers/:id/agent/tools/output/prune", async (request) => {
    const { before } = parseBody(z.object({ before: z.iso.datetime() }), request.body);
    return services.agentService.pruneToolOutput(idParams.parse(request.params).id, before);
  });
  app.post("/api/servers/:id/agent/inbox", async (request) => {
    const { id } = idParams.parse(request.params);
    await services.serverService.requireServer(id);
    const body = parseBody(z.object({ text: z.string().min(1), id: z.string().min(1).max(256).optional(), kind: z.enum(["user", "synthetic"]).default("synthetic"), resume: z.boolean().default(true), delivery: z.enum(["steer", "queue"]).default("steer") }), request.body);
    return services.agentService.steer(id, body.text, body.delivery, body.id, body.kind, body.resume);
  });
  app.patch("/api/servers/:id/agent/inbox/:inboxId", async (request) => {
    const { id, inboxId } = inboxParams.parse(request.params);
    const body = parseBody(z.object({ delivery: z.enum(["steer", "queue"]) }), request.body);
    services.agentService.updateInbox(id, inboxId, body.delivery);
    return { ok: true };
  });
  app.delete("/api/servers/:id/agent/inbox/:inboxId", async (request) => {
    const { id, inboxId } = inboxParams.parse(request.params);
    services.agentService.cancelInbox(id, inboxId);
    return { ok: true };
  });
  const executionParams = z.object({ id: z.string().min(1), turnId: z.string().min(1) });
  app.get("/api/servers/:id/agent/executions", async (request) => {
    const { id } = idParams.parse(request.params);
    return services.agentService.listExecutions(id);
  });
  app.get("/api/servers/:id/agent/executions/:turnId", async (request) => {
    const { id, turnId } = executionParams.parse(request.params);
    return services.agentService.getExecution(id, turnId);
  });
  app.post("/api/servers/:id/agent/executions/:turnId/resume", async (request) => {
    const { id, turnId } = executionParams.parse(request.params);
    return { response: await services.agentService.resumeExecution(id, turnId) };
  });
  const reasoningEffortSchema = z.enum(["minimal", "low", "medium", "high"]).default("high");

  app.get("/api/servers/:id/agent/messages", async (request) => {
    const { id } = idParams.parse(request.params);
    return services.agentService.listMessages(id);
  });

  app.get("/api/servers/:id/agent/context-usage", async (request) => {
    const { id } = idParams.parse(request.params);
    return services.agentService.getContextUsage(id);
  });

  app.post("/api/servers/:id/agent/context/compress", async (request) => {
    const { id } = idParams.parse(request.params);
    return services.agentService.compressContext(id);
  });

  app.post("/api/servers/:id/agent/messages", async (request) => {
    const { id } = idParams.parse(request.params);
    const body = parseBody(z.object({ content: z.string().min(1), reasoningEffort: reasoningEffortSchema }), request.body);
    const response = await services.agentService.sendMessage(id, body.content, body.reasoningEffort);
    return { response, status: services.agentService.getStatus(id) };
  });

  app.get("/api/servers/:id/agent/confirmation", async (request) => {
    const { id } = idParams.parse(request.params);
    return { confirmation: services.agentService.getPendingConfirmation(id) };
  });

  app.get("/api/servers/:id/agent/model", async (request) => {
    const { id } = idParams.parse(request.params);
    return { modelName: services.agentService.getActiveModelName(id) };
  });

  app.post("/api/servers/:id/agent/model", async (request) => {
    const { id } = idParams.parse(request.params);
    const body = parseBody(z.object({ modelName: z.string().optional() }), request.body);
    return services.agentService.setModelOverride(id, body.modelName);
  });

  app.get("/api/servers/:id/agent/server-slot", async (request) => {
    const { id } = idParams.parse(request.params);
    return services.fileService.getServerSlotStatus(id);
  });

  app.post("/api/servers/:id/agent/server-slot/upload", async (request) => {
    const { id } = idParams.parse(request.params);
    const file = await request.file() as MultipartFile | undefined;
    if (!file) throw new Error("No file uploaded");
    return services.fileService.uploadIntoServerSlot(id, file.filename, file.file);
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
