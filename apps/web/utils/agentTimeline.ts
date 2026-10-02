import type { AgentActivity, AgentMessage, AgentStatus } from "../types/app";

export interface AgentTurn {
  id: string;
  role: "user" | "agent";
  messages: AgentMessage[];
  createdAt: string;
}

export function agentStatusLabel(status: AgentStatus | AgentActivity["status"] | null) {
  return ({ idle: "就绪", thinking: "思考中", running: "执行中", waiting_confirmation: "等待确认", retrying: "等待重试", completed: "已完成", failed: "失败", cancelled: "已中断" })[status ?? "idle"];
}

export function formatActivityDuration(start: string, end?: string, now = Date.now()) {
  const milliseconds = (end ? Date.parse(end) : now) - Date.parse(start);
  if (!Number.isFinite(milliseconds)) return "";
  const seconds = Math.max(0, milliseconds / 1000);
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}

export function formatActivityPayload(content: string) {
  try { return JSON.stringify(JSON.parse(content), null, 2); } catch { return content; }
}

export function activityPreview(message: AgentMessage) {
  const activity = message.activity;
  if (activity?.error) return activity.error.replace(/\s+/g, " ");
  if (activity?.kind === "tool" && activity.input) {
    try {
      const input = JSON.parse(activity.input);
      if (input && typeof input === "object") {
        for (const key of ["path", "filePath", "query", "command", "url", "name", "template", "capability"]) {
          if (typeof input[key] === "string") return input[key];
        }
      }
    } catch { /* Invalid JSON is displayed verbatim in the input section. */ }
    return activity.input.replace(/\s+/g, " ").slice(0, 160);
  }
  return message.content.replace(/[#*`>]/g, "").replace(/\s+/g, " ").slice(0, 160);
}

/** Preserve older conversations, pairing legacy tool logs only within their own turn. */
export function normalizeAgentMessages(messages: AgentMessage[], busy = false): AgentMessage[] {
  const result: AgentMessage[] = [];
  const pending = new Map<string, AgentMessage[]>();
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  messages.forEach((message, index) => {
    if (message.role === "user") pending.clear();
    if (message.activity || message.role !== "system") {
      if (message.content.trim() || message.activity) result.push(message);
      return;
    }
    const thinking = message.content.match(/^思考过程[：:]\s*\n?([\s\S]*)/);
    if (thinking) {
      result.push({ ...message, content: thinking[1] ?? "", activity: { kind: "reasoning", title: "思考过程", status: "completed", startedAt: message.createdAt, finishedAt: message.createdAt } });
      return;
    }
    const call = message.content.match(/^调用工具[：:]([^\n]+)\n参数[：:]\s*([\s\S]*)/);
    if (call) {
      const name = call[1]!.trim();
      const item: AgentMessage = { ...message, content: "", activity: { kind: "tool", title: name, toolName: name, input: call[2], status: busy && index > lastUser ? "running" : "cancelled", startedAt: message.createdAt } };
      result.push(item);
      pending.set(name, [...(pending.get(name) ?? []), item]);
      return;
    }
    const output = message.content.match(/^工具结果[：:]([^\n]+)\n([\s\S]*)/);
    const failure = message.content.match(/^工具(?:调用失败，已交给 Agent 尝试恢复|参数解析失败)[：:]([^\n]+)\n([\s\S]*)/);
    const match = output ?? failure;
    if (match) {
      const name = match[1]!.trim();
      const queue = pending.get(name);
      const item = queue?.shift();
      const content = match[2] ?? "";
      const failed = Boolean(failure) || content.startsWith("TOOL_ERROR");
      const activity: AgentActivity = { ...(item?.activity ?? { kind: "tool", title: name, toolName: name, startedAt: message.createdAt }), status: failed ? "failed" : "completed", finishedAt: message.createdAt,
        ...(failed ? { error: content.split("错误：")[1]?.split("\n恢复策略：")[0]?.trim() || content } : {}) };
      if (item) {
        item.content = content;
        item.activity = activity;
        // A failure log can precede the corresponding TOOL_ERROR result.
        if (failure) queue?.unshift(item);
      } else result.push({ ...message, content, activity });
      return;
    }
    result.push(message);
  });
  return result;
}

export function buildAgentTurns(messages: AgentMessage[], busy = false): AgentTurn[] {
  const turns: AgentTurn[] = [];
  for (const message of normalizeAgentMessages(messages, busy)) {
    const role = message.role === "user" ? "user" : "agent";
    const last = turns.at(-1);
    if (role === "agent" && last?.role === "agent") last.messages.push(message);
    else turns.push({ id: message.id, role, messages: [message], createdAt: message.createdAt });
  }
  return turns;
}
