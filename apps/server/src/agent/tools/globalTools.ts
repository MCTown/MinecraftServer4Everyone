import type { AgentFocusInstance } from "../../types.js";
import type { ConsoleLogService } from "../../services/consoleLogService.js";
import type { ProcessManager } from "../../services/processManager.js";
import type { ServerService } from "../../services/serverService.js";
import { createWebSearchTool } from "./webSearchTool.js";
import { createFetchWebPageTool } from "./fetchWebPageTool.js";
import { objectSchema, stringInput, stringProperty, type AgentTool, type AgentToolContext } from "../toolKit.js";

/**
 * Tools for the dashboard-level (global) agent. Unlike instance tools these are
 * not bound to one server: instance-scoped tools receive an explicit serverId,
 * and focus_instance performs the UI handoff to a specific instance console.
 *
 * `context` is a standard AgentToolContext whose getServerId() resolves to the
 * most recent focus target, so shared tools (web search, shell, read-only
 * instance tools) can be reused verbatim.
 */
export function createGlobalAgentTools(
  serverService: ServerService,
  processManager: ProcessManager,
  consoleLogService: ConsoleLogService,
  context: AgentToolContext
): AgentTool[] {
  const tools: AgentTool[] = [
    // Server-independent research tools work unchanged in the global scope.
    createWebSearchTool(context),
    createFetchWebPageTool(context)
  ];

  tools.push({
    definition: {
      type: "function",
      function: {
        name: "list_instances",
        description: "列出当前账号下的所有实例（服务端），包含 serverId、名称、运行状态、Minecraft 版本、整合包、内存和目录。全局会话里做任何涉及具体实例的操作前，先用它拿到准确的 serverId。",
        parameters: objectSchema({})
      }
    },
    execute: async () => {
      const servers = await serverService.listServers();
      const list = servers.map((server) => ({
        serverId: server.id,
        name: server.name,
        status: server.status,
        minecraftVersion: server.minecraftVersion,
        modpackName: server.modpackName,
        memory: `${server.minMemory}/${server.maxMemory}`,
        directory: server.directory,
        updatedAt: server.updatedAt
      }));
      return JSON.stringify({ count: list.length, servers: list }, null, 2);
    }
  });

  tools.push({
    definition: {
      type: "function",
      function: {
        name: "create_server",
        description: "创建一个新的空实例（服务端），返回新的 serverId 和目录。创建后如需部署或启动该系统，请接着调用 focus_instance 把任务交接给新实例的 Agent。",
        parameters: objectSchema({ name: stringProperty }, ["name"])
      }
    },
    execute: async (input) => {
      const name = stringInput(input, "name").trim();
      if (!name) throw new Error("name 不能为空");
      const server = await serverService.createServer({ name });
      return JSON.stringify({
        serverId: server.id,
        name: server.name,
        directory: server.directory,
        status: server.status,
        nextStep: "如需继续部署或启动，请调用 focus_instance 并传入该 serverId。"
      }, null, 2);
    }
  });

  tools.push({
    definition: {
      type: "function",
      function: {
        name: "focus_instance",
        description: "把一个涉及具体实例的任务交接给该实例：前端会自动跳转到这个实例的操作界面并显示它的终端，实例 Agent 会收到本任务的交接摘要。对某个实例做写操作或长任务（部署整合包、启动/停止、改配置、装模组等）之前必须调用。只读查询不需要调用。",
        parameters: objectSchema({
          serverId: stringProperty,
          serverName: stringProperty,
          task: stringProperty,
          reason: stringProperty
        }, ["serverId", "task"])
      }
    },
    execute: async (input) => {
      const serverId = stringInput(input, "serverId").trim();
      const task = stringInput(input, "task").trim();
      if (!serverId) throw new Error("serverId 不能为空");
      if (!task) throw new Error("task 不能为空");
      const server = await serverService.requireServer(serverId);
      const focus: AgentFocusInstance = {
        serverId: server.id,
        serverName: server.name,
        task,
        reason: stringInput(input, "reason").trim()
      };
      context.focusInstance?.(focus);
      return [
        `已把任务交接给实例：${server.name}（${server.id}）`,
        `任务：${task}`,
        focus.reason ? `原因：${focus.reason}` : "",
        "前端已自动跳转到该实例并显示其终端。请在回复里简要说明已交接的任务与下一步，实例 Agent 会继续执行。"
      ].filter(Boolean).join("\n");
    }
  });

  tools.push({
    definition: {
      type: "function",
      function: {
        name: "get_instance_console",
        description: "读取某个实例最近的终端输出，用于巡检或判断实例是否健康。需要显式传入 serverId（可先用 list_instances 获取）。只读操作，不会切换界面。",
        parameters: objectSchema({ serverId: stringProperty, limit: { type: "number" } }, ["serverId"])
      }
    },
    execute: async (input) => {
      const serverId = stringInput(input, "serverId").trim();
      if (!serverId) throw new Error("serverId 不能为空");
      await serverService.requireServer(serverId);
      const limit = typeof input.limit === "number" ? Math.min(Math.max(Math.floor(input.limit), 1), 300) : 80;
      const entries = consoleLogService.list(serverId, limit);
      const text = entries.map((entry) => `[${entry.stream}] ${entry.text.trimEnd()}`).join("\n");
      return text || "该实例当前没有终端输出。";
    }
  });

  tools.push({
    definition: {
      type: "function",
      function: {
        name: "start_instance",
        description: "按实例当前配置启动某个实例。需要显式传入 serverId。后端同一时间只允许运行一个实例。这是会切换界面的操作，应先调用 focus_instance 交接。",
        parameters: objectSchema({ serverId: stringProperty }, ["serverId"])
      }
    },
    execute: async (input) => {
      const serverId = stringInput(input, "serverId").trim();
      if (!serverId) throw new Error("serverId 不能为空");
      const result = await processManager.start(serverId);
      return JSON.stringify(result, null, 2);
    }
  });

  tools.push({
    definition: {
      type: "function",
      function: {
        name: "stop_instance",
        description: "向某个实例发送 stop 指令，正常关闭并保存存档。需要显式传入 serverId。",
        parameters: objectSchema({ serverId: stringProperty }, ["serverId"])
      }
    },
    execute: async (input) => {
      const serverId = stringInput(input, "serverId").trim();
      if (!serverId) throw new Error("serverId 不能为空");
      const result = await processManager.stop(serverId);
      return JSON.stringify(result, null, 2);
    }
  });

  return tools;
}
