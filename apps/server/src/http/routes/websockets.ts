import type { FastifyInstance } from "fastify";
import { eventBus } from "../../services/eventBus.js";
import { idParams } from "../helpers.js";
import type { RouteServices } from "../types.js";

function parseAgentSocketMessage(raw: { toString(): string }) {
  return JSON.parse(raw.toString()) as {
    type?: string;
    content?: string;
    reasoningEffort?: string;
    confirmationId?: string;
    approved?: boolean;
    modelName?: string;
  };
}

export function registerWebSocketRoutes(app: FastifyInstance, services: RouteServices) {
  const reasoningEfforts = new Set(["minimal", "low", "medium", "high"]);

  app.get("/ws/console/:id", { websocket: true }, (connection, request) => {
    const { id } = idParams.parse(request.params);
    const send = (payload: unknown) => {
      if (connection.readyState !== 1) return;
      try {
        connection.send(JSON.stringify(payload));
      } catch {
        // The browser may close the socket while a console event is being published.
      }
    };

    // Snapshot once on connect; live events use type "log". Avoid replaying history as individual log events.
    send({ type: "snapshot", entries: services.consoleLogService.list(id) });
    send({ type: "error_state", errorState: services.serverErrorService.getState(id) });
    const onLog = (entry: { serverId: string }) => {
      if (entry.serverId === id) send({ type: "log", entry });
    };
    const onClear = (payload: { serverId: string }) => {
      if (payload.serverId === id) send({ type: "clear" });
    };
    const onStatus = (payload: { serverId: string; status: string }) => {
      if (payload.serverId === id) send({ type: "status", ...payload });
    };
    const onErrorState = (payload: { serverId: string }) => {
      if (payload.serverId === id) send({ type: "error_state", errorState: payload });
    };

    eventBus.on("console", onLog);
    eventBus.on("consoleClear", onClear);
    eventBus.on("serverStatus", onStatus);
    eventBus.on("serverError", onErrorState);

    connection.on("message", (raw: { toString(): string }) => {
      let message: { type?: string; command?: string };
      try {
        message = JSON.parse(raw.toString()) as { type?: string; command?: string };
      } catch {
        send({ type: "error", content: "消息格式错误" });
        return;
      }
      if (message.type === "command" && typeof message.command === "string" && message.command.trim()) {
        try {
          services.processManager.sendCommand(id, message.command.trim());
        } catch (error) {
          send({
            type: "error",
            content: error instanceof Error ? error.message : String(error)
          });
        }
      }
    });

    connection.on("close", () => {
      eventBus.off("console", onLog);
      eventBus.off("consoleClear", onClear);
      eventBus.off("serverStatus", onStatus);
      eventBus.off("serverError", onErrorState);
    });
  });

  app.get("/ws/agent/:id", { websocket: true }, (connection, request) => {
    const { id } = idParams.parse(request.params);
    const send = (payload: unknown) => {
      if (connection.readyState !== 1) return;
      try {
        connection.send(JSON.stringify(payload));
      } catch {
        // The browser may close the socket while an agent event is being published.
      }
    };
    const onAgent = (payload: { serverId: string; event: unknown }) => {
      if (payload.serverId === id) send(payload.event);
    };

    eventBus.on("agent", onAgent);
    send({ type: "snapshot", ...services.agentService.getPresentation(id), confirmation: services.agentService.getPendingConfirmation(id), messages: services.agentService.listMessages(id), status: services.agentService.getStatus(id), retry: services.agentService.getRetry(id), modelName: services.agentService.getActiveModelName(id) });
    send({ type: "status", status: services.agentService.getStatus(id) });
    send({ type: "model", modelName: services.agentService.getActiveModelName(id) });
    services.fileService.getServerSlotStatus(id).then((serverSlot) => send({ type: "server_slot", serverSlot })).catch(() => undefined);
    const pendingConfirmation = services.agentService.getPendingConfirmation(id);
    if (pendingConfirmation) {
      send({ type: "confirmation_required", confirmation: pendingConfirmation });
    }

    connection.on("message", (raw: { toString(): string }) => {
      let message: { type?: string; content?: string; reasoningEffort?: string; confirmationId?: string; approved?: boolean; modelName?: string };
      try {
        message = parseAgentSocketMessage(raw);
      } catch {
        send({ type: "error", content: "消息格式错误", status: "failed" });
        return;
      }
      if (message.type === "message" && message.content) {
        const reasoningEffort = reasoningEfforts.has(message.reasoningEffort ?? "") ? message.reasoningEffort as "minimal" | "low" | "medium" | "high" : "high";
        services.agentService.sendMessage(id, message.content, reasoningEffort).catch((error) => {
          send({
            type: "error",
            content: error instanceof Error ? error.message : String(error),
            status: "failed"
          });
        });
      }
      if (message.type === "set-model") {
        services.agentService.setModelOverride(id, message.modelName);
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

  app.get("/ws/agent/global", { websocket: true }, (connection) => {
    const scopeId = "global";
    const send = (payload: unknown) => {
      if (connection.readyState !== 1) return;
      try {
        connection.send(JSON.stringify(payload));
      } catch {
        // The browser may close the socket while an agent event is being published.
      }
    };
    // Global-scope events carry serverId "global"; instance-scoped events are
    // forwarded too so the UI can reflect handoffs without a second socket.
    const onAgent = (payload: { serverId: string; event: unknown }) => {
      if (payload.serverId === scopeId) send(payload.event);
    };

    eventBus.on("agent", onAgent);
    send({
      type: "snapshot",
      ...services.agentService.getPresentation(scopeId),
      confirmation: services.agentService.getPendingGlobalConfirmation(),
      messages: services.agentService.listGlobalMessages(),
      status: services.agentService.getGlobalStatus(),
      retry: services.agentService.getGlobalRetry(),
      modelName: services.agentService.getActiveModelName(scopeId)
    });
    send({ type: "status", status: services.agentService.getGlobalStatus() });
    send({ type: "model", modelName: services.agentService.getActiveModelName(scopeId) });
    const pendingConfirmation = services.agentService.getPendingGlobalConfirmation();
    if (pendingConfirmation) {
      send({ type: "confirmation_required", confirmation: pendingConfirmation });
    }

    connection.on("message", (raw: { toString(): string }) => {
      let message: { type?: string; content?: string; reasoningEffort?: string; confirmationId?: string; approved?: boolean; modelName?: string };
      try {
        message = parseAgentSocketMessage(raw);
      } catch {
        send({ type: "error", content: "消息格式错误", status: "failed" });
        return;
      }
      if (message.type === "message" && message.content) {
        const reasoningEffort = reasoningEfforts.has(message.reasoningEffort ?? "") ? message.reasoningEffort as "minimal" | "low" | "medium" | "high" : "high";
        services.agentService.sendGlobalMessage(message.content, reasoningEffort).catch((error) => {
          send({
            type: "error",
            content: error instanceof Error ? error.message : String(error),
            status: "failed"
          });
        });
      }
      if (message.type === "set-model") {
        services.agentService.setModelOverride(scopeId, message.modelName);
      }
      if (message.type === "confirmation" && message.confirmationId && typeof message.approved === "boolean") {
        try {
          services.agentService.resolveConfirmation(scopeId, message.confirmationId, message.approved);
        } catch (error) {
          send({
            type: "error",
            content: error instanceof Error ? error.message : String(error),
            status: "failed"
          });
        }
      }
      if (message.type === "cancel") {
        services.agentService.cancel(scopeId);
      }
      if (message.type === "retry") {
        services.agentService.retryNow(scopeId);
      }
    });

    connection.on("close", () => eventBus.off("agent", onAgent));
  });
}
