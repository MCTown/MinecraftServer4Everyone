import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { appConfig } from "../../config.js";
import { idParams, parseBody } from "../helpers.js";
import type { RouteServices } from "../types.js";

export function registerServerRoutes(app: FastifyInstance, services: RouteServices) {
  app.get("/health", async () => ({ ok: true }));

  app.get("/api/meta", async () => ({
    workspaceRoot: appConfig.workspaceRoot,
    activeServerId: services.processManager.getActiveServerId()
  }));

  app.get("/api/servers", async () => services.serverService.listServers());

  app.post("/api/servers", async (request) => {
    const body = parseBody(z.object({ name: z.string().min(1) }), request.body);
    return services.serverService.createServer(body);
  });

  app.get("/api/servers/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    return services.serverService.requireServer(id);
  });

  app.patch("/api/servers/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    const body = parseBody(z.object({
      name: z.string().optional(),
      javaPath: z.string().nullable().optional(),
      javaVersion: z.string().nullable().optional(),
      minMemory: z.string().optional(),
      maxMemory: z.string().optional(),
      jarFile: z.string().optional(),
      startArgs: z.string().optional(),
      serverType: z.string().nullable().optional(),
      minecraftVersion: z.string().nullable().optional(),
      modpackName: z.string().nullable().optional(),
      promptOverride: z.string().nullable().optional(),
      useGlobalPrompt: z.boolean().optional()
    }), request.body);
    return services.serverService.updateServer(id, body);
  });

  app.delete("/api/servers/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    const body = parseBody(z.object({ confirmName: z.string().min(1) }), request.body);
    if (services.processManager.getActiveServerId() === id) {
      throw new Error("服务端正在运行，请先关闭后再删除");
    }
    if (services.agentService.isBusy(id)) {
      throw new Error("Agent 正在处理该服务端，请等待完成后再删除");
    }
    return services.serverService.deleteServer(id, body.confirmName);
  });

  app.post("/api/servers/:id/start", async (request) => services.processManager.start(idParams.parse(request.params).id));
  app.post("/api/servers/:id/stop", async (request) => services.processManager.stop(idParams.parse(request.params).id));
  app.post("/api/servers/:id/kill", async (request) => services.processManager.kill(idParams.parse(request.params).id));
  app.post("/api/servers/:id/restart", async (request) => services.processManager.restart(idParams.parse(request.params).id));

  app.post("/api/servers/:id/command", async (request) => {
    const { id } = idParams.parse(request.params);
    const body = parseBody(z.object({ command: z.string().min(1) }), request.body);
    services.processManager.sendCommand(id, body.command);
    return { ok: true };
  });

  app.get("/api/servers/:id/logs", async (request) => {
    const { id } = idParams.parse(request.params);
    const query = z.object({ limit: z.coerce.number().optional() }).parse(request.query);
    return services.consoleLogService.list(id, query.limit ?? 300);
  });
}
