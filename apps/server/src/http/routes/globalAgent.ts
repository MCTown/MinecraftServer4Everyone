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
