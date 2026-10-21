import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { parseBody } from "../helpers.js";
import type { RouteServices } from "../types.js";

/**
 * Dashboard-level agent conversation. Mirrors the per-instance agent routes but
 * is not bound to a server: the agent lists instances and calls focus_instance
 * to hand a task off to a specific instance console.
 */
export function registerGlobalAgentRoutes(app: FastifyInstance, services: RouteServices) {
  app.post("/api/agent/requests", async (request) => {
    const body = parseBody(z.object({ requestId: z.string().min(1).max(128), content: z.string().min(1), reasoningEffort: z.enum(["minimal", "low", "medium", "high"]).default("high") }), request.body);
    return services.agentService.acceptMessage("global", body.requestId, body.content, body.reasoningEffort);
  });
  app.post("/api/agent/focus/ack", async (request) => {
    const body = parseBody(z.object({ id: z.string().min(1) }), request.body);
    return services.agentService.acknowledgeFocus("global", body.id);
  });
  app.get("/api/agent/question", async () => ({ question: services.agentService.getPendingQuestion("global") }));
  app.post("/api/agent/question", async (request) => {
    const body = parseBody(z.object({ questionId: z.string().min(1), selected: z.array(z.string()).max(20), cancelled: z.boolean().default(false) }), request.body);
    return services.agentService.resolveQuestion("global", body.questionId, body.selected, body.cancelled);
  });
  const inboxParams = z.object({ inboxId: z.string().min(1) });
  app.get("/api/agent/tools/jobs", async () => services.agentService.listToolJobs("global"));
  app.post("/api/agent/background", async () => services.agentService.backgroundTools("global"));
  app.get("/api/agent/inbox", async () => services.agentService.listInbox("global"));
  app.post("/api/agent/inbox", async (request) => {
    const body = parseBody(z.object({ text: z.string().min(1), delivery: z.enum(["steer", "queue"]).default("steer") }), request.body);
    return services.agentService.steer("global", body.text, body.delivery);
  });
  app.patch("/api/agent/inbox/:inboxId", async (request) => {
    const { inboxId } = inboxParams.parse(request.params);
    const body = parseBody(z.object({ delivery: z.enum(["steer", "queue"]) }), request.body);
    services.agentService.updateInbox("global", inboxId, body.delivery);
    return { ok: true };
  });
  app.delete("/api/agent/inbox/:inboxId", async (request) => {
    services.agentService.cancelInbox("global", inboxParams.parse(request.params).inboxId);
    return { ok: true };
  });
  const executionParams = z.object({ turnId: z.string().min(1) });
  app.get("/api/agent/executions", async () => services.agentService.listExecutions("global"));
  app.get("/api/agent/executions/:turnId", async (request) => {
    const { turnId } = executionParams.parse(request.params);
    return services.agentService.getExecution("global", turnId);
  });
  app.post("/api/agent/executions/:turnId/resume", async (request) => {
    const { turnId } = executionParams.parse(request.params);
    return { response: await services.agentService.resumeExecution("global", turnId) };
  });
  const reasoningEffortSchema = z.enum(["minimal", "low", "medium", "high"]).default("high");

  app.get("/api/agent/messages", async () => services.agentService.listGlobalMessages());

  app.get("/api/agent/context-usage", async () => services.agentService.getGlobalContextUsage());

  app.get("/api/agent/confirmation", async () => ({ confirmation: services.agentService.getPendingGlobalConfirmation() }));

  app.get("/api/agent/status", async () => ({ status: services.agentService.getGlobalStatus() }));

  app.get("/api/agent/model", async () => ({ modelName: services.agentService.getActiveModelName("global") }));

  app.post("/api/agent/model", async (request) => {
    const body = parseBody(z.object({ modelName: z.string().optional() }), request.body);
    return services.agentService.setModelOverride("global", body.modelName);
  });

  app.post("/api/agent/messages", async (request) => {
    const body = parseBody(z.object({ content: z.string().min(1), reasoningEffort: reasoningEffortSchema }), request.body);
    const response = await services.agentService.sendGlobalMessage(body.content, body.reasoningEffort);
    return { response, status: services.agentService.getGlobalStatus() };
  });

  app.post("/api/agent/confirmation", async (request) => {
    const body = parseBody(z.object({ confirmationId: z.string().min(1), approved: z.boolean() }), request.body);
    return services.agentService.resolveConfirmation("global", body.confirmationId, body.approved);
  });

  app.post("/api/agent/cancel", async () => services.agentService.cancel("global"));

  app.post("/api/agent/retry", async () => services.agentService.retryNow("global"));

  app.post("/api/agent/context/compress", async () => services.agentService.compressGlobalContext());

  app.delete("/api/agent/context", async () => services.agentService.clearGlobalContext());
}
