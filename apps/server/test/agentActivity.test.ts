import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentService } from "../src/agent/agentService.js";
import { appConfig } from "../src/config.js";
import { getSqlite, initDatabase } from "../src/db/client.js";
import { eventBus } from "../src/services/eventBus.js";
import { ModelRemoteError, type ChatCompletionResult, type ModelService } from "../src/services/modelService.js";
import type { ServerService } from "../src/services/serverService.js";
import type { ConsoleLogService } from "../src/services/consoleLogService.js";
import type { FileService } from "../src/services/fileService.js";
import type { ProcessManager } from "../src/services/processManager.js";
import type { PromptService } from "../src/services/promptService.js";
import type { UploadService } from "../src/services/uploadService.js";
import type { JavaService } from "../src/services/javaService.js";
import type { AgentEvent } from "../src/types.js";

let root: string;
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "agent-activity-"));
  appConfig.dataDir = root;
  initDatabase();
});
after(async () => { getSqlite().close(); await rm(root, { recursive: true, force: true }); });

const result = (content = "", toolCalls: ChatCompletionResult["toolCalls"] = []): ChatCompletionResult => ({ content, toolCalls, reasoning: "", usage: null });
const call = (id: string, name: string, args = "{}") => ({ id, type: "function" as const, function: { name, arguments: args } });

function harness(stream: ModelService["chatCompletionStream"]) {
  const id = crypto.randomUUID();
  const model = { getDecryptedDefault: () => ({ baseUrl: "http://model.test", modelName: "test-model", apiKey: "test" }), getContextMaxTokens: () => 200000, getContextSizeK: () => 200, chatCompletionStream: stream } as unknown as ModelService;
  const service = new AgentService(
    { requireServer: async () => ({ id, name: "Test", directory: root, status: "stopped", minMemory: "1G", maxMemory: "2G" }) } as unknown as ServerService,
    { append: () => undefined } as unknown as ConsoleLogService,
    { list: async () => [], getServerSlotStatus: async () => null, readText: async () => { throw new Error("ENOENT: server/missing.properties"); } } as unknown as FileService,
    {} as ProcessManager, model,
    { getEffectivePrompt: async () => "Test", getAgentSettings: () => ({ memory: "2G" }), getAgentAutoConfirm: () => false,
      getBraveSearchApiKey: () => "", getTavilyApiKey: () => "", getSearxngBaseUrl: () => "" } as unknown as PromptService,
    { list: () => [] } as unknown as UploadService,
    { recommendVersion: () => "21" } as unknown as JavaService
  );
  const events: AgentEvent[] = [];
  const listener = (payload: { serverId: string; event: AgentEvent }) => {
    if (payload.serverId === id) events.push(structuredClone(payload.event));
  };
  eventBus.on("agent", listener);
  return { id, service, events, dispose: () => eventBus.off("agent", listener) };
}

test("streams reasoning live and persists separate calls of the same tool, including failures", async (t) => {
  let round = 0;
  const h = harness(async (_input, text, reasoning) => {
    if (round++ === 0) {
      reasoning?.("先检查 ");
      reasoning?.("配置文件。\n");
      const live = h.service.listMessages(h.id).find((m) => m.activity?.kind === "reasoning");
      assert.equal(live?.content, "先检查 配置文件。\n");
      assert.equal(live?.activity?.status, "running");
      text("正在检查配置。");
      assert.equal(h.service.listMessages(h.id).at(-1)?.content, "正在检查配置。");
      return result("正在检查配置。", [call("one", "list_server_files"), call("two", "list_server_files", '{"path":"server"}'), call("three", "read_server_text_file", '{"path":"server/missing.properties"}')]);
    }
    text("文件不存在，需要修正路径。");
    return result("文件不存在，需要修正路径。");
  });
  t.after(h.dispose);
  await h.service.sendMessage(h.id, "检查配置");
  const history = h.service.listMessages(h.id);
  const tools = history.filter((m) => m.activity?.kind === "tool");
  assert.equal(tools.length, 3, JSON.stringify(history));
  assert.deepEqual(tools.map((m) => m.activity?.toolCallId), ["one", "two", "three"]);
  assert.deepEqual(tools.map((m) => m.activity?.status), ["completed", "completed", "failed"]);
  assert.match(tools[2]!.activity!.error!, /ENOENT/);
  assert.match(tools[2]!.content, /恢复策略/);
  assert.ok(tools.every((m) => m.activity?.finishedAt));
  assert.equal(history.filter((m) => m.activity?.kind === "reasoning")[0]?.content, "先检查 配置文件。\n");
  assert.equal(h.events.filter((e) => e.type === "activity_delta").length, 2);
  assert.equal(history.filter((m) => m.role === "agent").length, 2);
  assert.equal(h.service.getStatus(h.id), "completed");
});

test("invalid tool JSON exposes raw input and parsing error without losing subsequent calls", async (t) => {
  let round = 0;
  const h = harness(async () => round++ === 0 ? result("", [call("bad", "list_server_files", '{"path":'), call("good", "list_server_files")]) : result("已恢复"));
  t.after(h.dispose);
  await h.service.sendMessage(h.id, "检查");
  const tools = h.service.listMessages(h.id).filter((m) => m.activity?.kind === "tool");
  assert.equal(tools[0]?.activity?.input, '{"path":');
  assert.match(tools[0]!.activity!.error!, /JSON 解析失败/);
  assert.equal(tools[1]?.activity?.status, "completed");
});

test("provider failure keeps partial narration and reasoning, then exposes the actual error", async (t) => {
  const h = harness(async (_input, text, reasoning) => {
    reasoning?.("已经读到的思考");
    text("已经生成的回答");
    throw new Error("upstream disconnected: ECONNRESET");
  });
  t.after(h.dispose);
  await h.service.sendMessage(h.id, "执行");
  const history = h.service.listMessages(h.id);
  assert.ok(history.some((m) => m.content === "已经生成的回答"));
  assert.ok(history.some((m) => m.activity?.kind === "reasoning" && m.content === "已经读到的思考" && m.activity.status === "failed"));
  assert.match(history.at(-1)!.content, /ECONNRESET/);
  assert.equal(h.service.getStatus(h.id), "failed");
});

test("retry snapshot includes provider error and immediate retry completes the same activity", async (t) => {
  let round = 0;
  const h = harness(async (_input, _text, reasoning) => {
    if (round++ === 0) { reasoning?.("第一次尝试"); throw new ModelRemoteError("HTTP 429: rate_limit_exceeded"); }
    reasoning?.("重试后继续");
    return result("恢复成功");
  });
  t.after(h.dispose);
  const retry = (payload: { serverId: string; event: AgentEvent }) => {
    if (payload.serverId !== h.id || payload.event.type !== "retry_scheduled") return;
    assert.match(h.service.getRetry(h.id)!.message, /429/);
    queueMicrotask(() => h.service.retryNow(h.id));
  };
  eventBus.on("agent", retry);
  t.after(() => eventBus.off("agent", retry));
  await h.service.sendMessage(h.id, "请求");
  const history = h.service.listMessages(h.id);
  assert.deepEqual(history.filter((m) => m.activity?.kind === "reasoning").map((m) => m.activity?.status), ["failed", "completed"]);
  const retryMessage = history.find((m) => m.activity?.kind === "retry");
  assert.equal(retryMessage?.activity?.status, "completed");
  assert.match(retryMessage!.activity!.error!, /rate_limit_exceeded/);
  assert.equal(h.service.getRetry(h.id), null);
});

test("waiting confirmation and cancellation are reflected in the tool history", async (t) => {
  const h = harness(async () => result("", [call("confirm", "initialize_server_template")]));
  t.after(h.dispose);
  const confirm = (payload: { serverId: string; event: AgentEvent }) => {
    if (payload.serverId !== h.id || payload.event.type !== "confirmation_required") return;
    queueMicrotask(() => {
      assert.equal(h.service.listMessages(h.id).find((m) => m.activity?.kind === "tool")?.activity?.status, "waiting_confirmation");
      h.service.cancel(h.id);
    });
  };
  eventBus.on("agent", confirm);
  t.after(() => eventBus.off("agent", confirm));
  await h.service.sendMessage(h.id, "套用模板");
  assert.equal(h.service.listMessages(h.id).find((m) => m.activity?.kind === "tool")?.activity?.status, "cancelled");
  assert.equal(h.service.getStatus(h.id), "cancelled");
  assert.equal(h.service.getPendingConfirmation(h.id), null);
});
