import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "../types/app";
import { buildAgentTurns, normalizeAgentMessages } from "../utils/agentTimeline";

let sequence = 0;
function message(role: AgentMessage["role"], content: string): AgentMessage {
  return { id: String(sequence++), serverId: "test", role, content, status: null, createdAt: new Date(sequence * 1000).toISOString() };
}

test("legacy tool logs pair by invocation, do not cross user turns, and retain errors", () => {
  const source = [message("user", "检查"), message("system", '调用工具：read\n参数：{"path":"one"}'), message("system", "工具结果：read\nfirst result"), message("system", '调用工具：read\n参数：{"path":"two"}'), message("system", "工具调用失败，已交给 Agent 尝试恢复：read\nENOENT"), message("system", "工具结果：read\nTOOL_ERROR\n错误：ENOENT\n恢复策略：\n检查路径"), message("user", "下一轮"), message("system", "工具结果：read\nnew turn")];
  const normalized = normalizeAgentMessages(source);
  const tools = normalized.filter((m) => m.activity?.kind === "tool");
  assert.equal(tools.length, 3);
  assert.equal(tools[0]?.content, "first result");
  assert.equal(tools[1]?.activity?.error, "ENOENT");
  assert.equal(tools[2]?.content, "new turn");
  assert.equal(source[1]?.activity, undefined, "normalization must not mutate server records");
});

test("assistant narration and activities share a turn; empty streaming placeholders stay hidden", () => {
  const turns = buildAgentTurns([message("user", "test"), message("system", "思考过程：\nchecking"), message("agent", ""), message("agent", "done"), message("user", "again")]);
  assert.deepEqual(turns.map((t) => t.role), ["user", "agent", "user"]);
  assert.equal(turns[1]?.messages.length, 2);
  assert.equal(turns[1]?.messages[0]?.activity?.kind, "reasoning");
});

test("unfinished legacy tools never appear to run forever after completion", () => {
  const items = [message("user", "test"), message("system", "调用工具：read\n参数：{}")];
  assert.equal(normalizeAgentMessages(items, false)[1]?.activity?.status, "cancelled");
  assert.equal(normalizeAgentMessages(items, true)[1]?.activity?.status, "running");
});
