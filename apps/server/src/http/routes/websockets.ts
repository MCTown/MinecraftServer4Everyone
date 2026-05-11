import type { FastifyInstance } from "fastify";
import { eventBus } from "../../services/eventBus.js";
import { idParams } from "../helpers.js";
import type { RouteServices } from "../types.js";

export function registerWebSocketRoutes(app: FastifyInstance, services: RouteServices) {
  const reasoningEfforts = new Set(["minimal", "low", "medium", "high"]);

  app.get("/ws/console/:id", { websocket: true }, (connection, request) => {
    const { id } = idParams.parse(request.params);
    const send = (payload: unknown) => connection.send(JSON.stringify(payload));

    services.consoleLogService.list(id).forEach((entry) => send({ type: "log", entry }));
    const onLog = (entry: { serverId: string }) => {
      if (entry.serverId === id) send({ type: "log", entry });
    };
    const onClear = (payload: { serverId: string }) => {
      if (payload.serverId === id) send({ type: "clear" });
    };
    const onStatus = (payload: { serverId: string; status: string }) => {
      if (payload.serverId === id) send({ type: "status", ...payload });
    };

    eventBus.on("console", onLog);
    eventBus.on("consoleClear", onClear);
    eventBus.on("serverStatus", onStatus);

    connection.on("message", (raw: { toString(): string }) => {
      let message: { type?: string; command?: string };
      try {
        message = JSON.parse(raw.toString()) as { type?: string; command?: string };
      } catch {
        send({ type: "error", content: "消息格式错误" });
        return;
      }
      if (message.type === "command" && message.command) {
        services.processManager.sendCommand(id, message.command);
      }
    });

    connection.on("close", () => {
      eventBus.off("console", onLog);
      eventBus.off("consoleClear", onClear);
      eventBus.off("serverStatus", onStatus);
    });
  });

  app.get("/ws/agent/:id", { websocket: true }, (connection, request) => {
    const { id } = idParams.parse(request.params);
    const send = (payload: unknown) => connection.send(JSON.stringify(payload));
    const onAgent = (payload: { serverId: string; event: unknown }) => {
      if (payload.serverId === id) send(payload.event);
    };

    eventBus.on("agent", onAgent);
    send({ type: "status", status: services.agentService.getStatus(id) });
    services.fileService.getServerSlotStatus(id).then((serverSlot) => send({ type: "server_slot", serverSlot })).catch(() => undefined);
    const pendingConfirmation = services.agentService.getPendingConfirmation(id);
    if (pendingConfirmation) {
      send({ type: "confirmation_required", confirmation: pendingConfirmation });
    }

    connection.on("message", (raw: { toString(): string }) => {
      let message: { type?: string; content?: string; reasoningEffort?: string; confirmationId?: string; approved?: boolean };
      try {
        message = JSON.parse(raw.toString()) as { type?: string; content?: string; reasoningEffort?: string; confirmationId?: string; approved?: boolean };
      } catch {
        send({ type: "error", content: "消息格式错误", status: "failed" });
        return;
      }
      if (message.type === "message" && message.content) {
        const reasoningEffort = reasoningEfforts.has(message.reasoningEffort ?? "") ? message.reasoningEffort as "minimal" | "low" | "medium" | "high" : "medium";
        services.agentService.sendMessage(id, message.content, reasoningEffort).catch((error) => {
          send({
            type: "error",
            content: error instanceof Error ? error.message : String(error),
            status: "failed"
          });
        });
      }
      if (message.type === "confirmation" && message.confirmationId && typeof message.approved === "boolean") {
        try {
          services.agentService.resolveConfirmation(id, message.confirmationId, message.approved);
        } catch (error) {
          send({
            type: "error",
            content: error instanceof Error ? error.message : String(error),
            status: "failed"
          });
        }
      }
      if (message.type === "cancel") {
        services.agentService.cancel(id);
      }
      if (message.type === "retry") {
        services.agentService.retryNow(id);
      }
    });

    connection.on("close", () => eventBus.off("agent", onAgent));
  });
}
