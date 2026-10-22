import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentService } from "../src/agent/agentService.js";
import { ExecutionStore } from "../src/agent/executionStore.js";
import { SessionStore } from "../src/agent/sessionStore.js";
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
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { registerWebSocketRoutes } from "../src/http/routes/websockets.js";
import type { RouteServices } from "../src/http/types.js";

let root: string;
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "agent-activity-"));
  appConfig.dataDir = root;
  initDatabase();
});
after(async () => { getSqlite().close(); await rm(root, { recursive: true, force: true }); });

const result = (content = "", toolCalls: ChatCompletionResult["toolCalls"] = []): ChatCompletionResult => ({ content, toolCalls, reasoning: "", usage: null });
const call = (id: string, name: string, args = "{}") => ({ id, type: "function" as const, function: { name, arguments: args } });

test("ask_user pauses the agent, records the real answer and continues with its tool result", async (t) => {
  let round = 0;
  const h = harness(async (input) => {
    if (round++ === 0) return result("", [call("question", "ask_user", JSON.stringify({
      question: "安装哪些组件？", multiple: true, options: [{ label: "备份" }, { label: "监控" }]
    }))]);
    assert.ok(input.messages.some((message) => message.role === "tool" && message.content?.includes('"selected":["备份","监控"]')));
    return result("已收到选择");
  });
  t.after(h.dispose);
  const listener = (payload: { serverId: string; event: AgentEvent }) => {
    if (payload.serverId !== h.id || payload.event.status !== "waiting_confirmation") return;
    const question = h.service.getPendingQuestion(h.id)!;
    assert.ok(question);
    h.service.resolveQuestion(h.id, question.id, ["备份", "监控"]);
  };
  eventBus.on("agent", listener);
  t.after(() => eventBus.off("agent", listener));
  await h.service.sendMessage(h.id, "帮我安装组件");
  assert.equal(h.service.getStatus(h.id), "completed");
  assert.equal(h.service.getPendingQuestion(h.id), null);
  assert.ok(h.service.listMessages(h.id).some((message) => message.role === "user" && message.content.includes("备份、监控")));
  assert.equal(h.service.listMessages(h.id).find((message) => message.activity?.toolName === "ask_user")?.activity?.status, "completed");
});

function harness(stream: ModelService["chatCompletionStream"], list: () => Promise<unknown[]> = async () => [],
  installVersion: () => Promise<{ path: string }> = async () => ({ path: "/test/java" }), existingId?: string) {
  const id = existingId ?? crypto.randomUUID();
  const model = { getDecryptedDefault: () => ({ baseUrl: "http://model.test", modelName: "test-model", apiKey: "test" }), getContextMaxTokens: () => 200000, getContextSizeK: () => 200, chatCompletionStream: stream } as unknown as ModelService;
  const service = new AgentService(
    { requireServer: async () => ({ id, name: "Test", directory: root, status: "stopped", minMemory: "1G", maxMemory: "2G" }), updateServer: async () => undefined } as unknown as ServerService,
    { append: () => undefined } as unknown as ConsoleLogService,
    { list, getServerSlotStatus: async () => null, readText: async () => { throw new Error("ENOENT: server/missing.properties"); } } as unknown as FileService,
    {} as ProcessManager, model,
    { getEffectivePrompt: async () => "Test", getAgentSettings: () => ({ memory: "2G" }), getAgentAutoConfirm: () => false,
      getBraveSearchApiKey: () => "", getTavilyApiKey: () => "", getSearxngBaseUrl: () => "" } as unknown as PromptService,
    { list: () => [] } as unknown as UploadService,
    { recommendVersion: () => "21", installVersion } as unknown as JavaService
  );
  const events: AgentEvent[] = [];
  const listener = (payload: { serverId: string; event: AgentEvent }) => {
    if (payload.serverId === id) events.push(structuredClone(payload.event));
  };
  eventBus.on("agent", listener);
  return { id, service, events, dispose: () => eventBus.off("agent", listener) };
}

test("browser socket disconnect does not cancel work and reconnect restores workflow and partial output", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let round = 0;
  const h = harness(async (_input, onDelta) => {
    if (round++ === 0) return result("", [call("begin", "begin_deployment_workflow", '{}'), call("progress", "update_agent_workflow_progress", '{"stepId":"identify_modpack","status":"running","progress":42}')]);
    onDelta?.("正在后台处理");
    await gate;
    return result("已完成");
  });
  t.after(h.dispose);
  const app = Fastify();
  await app.register(websocket);
  registerWebSocketRoutes(app, { agentService: h.service, fileService: { getServerSlotStatus: async () => null } } as unknown as RouteServices);
  await app.ready();
  t.after(() => app.close());
  const first = await app.injectWS(`/ws/agent/${h.id}`);
  first.close();
  const accepted = await h.service.acceptMessage(h.id, "same-browser-request", "部署", "high");
  assert.deepEqual(await h.service.acceptMessage(h.id, "same-browser-request", "部署", "high"), accepted);
  await assert.rejects(h.service.acceptMessage(h.id, "same-browser-request", "不同任务", "high"));
  // Let the tool step complete and the next model request begin without any browser.
  for (let i = 0; i < 100 && round < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(round, 2);
  const packets: { type: string; workflow?: { steps: unknown[] }; messages?: { content: string }[] }[] = [];
  const second = await app.injectWS(`/ws/agent/${h.id}`, {}, { onInit: (socket) => {
    socket.on("message", (data: { toString(): string }) => packets.push(JSON.parse(data.toString())));
  } });
  const snapshot = packets.find((packet) => packet.type === "snapshot")!;
  assert.ok(snapshot);
  assert.ok(snapshot.workflow?.steps.length);
  assert.ok(snapshot.messages?.some((message) => message.content === "正在后台处理"));
  assert.equal(h.service.listMessages(h.id).filter((message) => message.role === "user").length, 1);
  const done = new Promise<void>((resolve) => {
    second.on("message", (data: { toString(): string }) => { if (JSON.parse(data.toString()).type === "done") resolve(); });
  });
  release();
  await done;
  assert.equal(h.service.getStatus(h.id), "completed"); // Progress no longer imposes a runtime gate.
  assert.equal(h.service.listExecutions(h.id).length, 1);
  assert.equal(h.service.listExecutions(h.id)[0]!.workflowScheduling, 2);
  assert.equal(h.service.getPresentation(h.id).workflow!.run!.mode, "continuous");
  second.close();
});

test("presentation snapshots keep completed downloads and only acknowledge the matching handoff", (t) => {
  const h = harness(async () => result());
  t.after(h.dispose);
  // Exercise the shared event path used by tools, without opening a browser subscription.
  const emit = (h.service as unknown as { emit(scope: string, event: AgentEvent): void }).emit.bind(h.service);
  const download = { id: "download", url: "https://example.test/file", fileName: "pack.zip", destinationPath: "pack.zip", loadedBytes: 42, totalBytes: 42, percent: 100, status: "completed" as const };
  emit(h.id, { type: "download_progress", download });
  assert.deepEqual(h.service.getPresentation(h.id).downloads, [download]);
  emit("global", { type: "focus_instance", focus: { serverId: h.id, serverName: "Test", task: "部署", reason: "交接" } });
  const focus = h.service.getPresentation("global").focus!;
  h.service.acknowledgeFocus("global", "older-focus");
  assert.equal(h.service.getPresentation("global").focus?.id, focus.id);
  h.service.acknowledgeFocus("global", focus.id);
  assert.equal(h.service.getPresentation("global").focus, null);
});

test("global approval survives a long absence and is replayed on reconnect", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(async () => result());
  t.after(h.dispose);
  const service = h.service as unknown as { requestConfirmation(scope: string, request: { title: string; description: string; risk: "high" }): Promise<void> };
  const approval = service.requestConfirmation("global", { title: "修改配置", description: "等待用户确认", risk: "high" });
  t.mock.timers.tick(60 * 60 * 1000);
  const pending = h.service.getPendingGlobalConfirmation()!;
  assert.ok(pending);
  const app = Fastify();
  await app.register(websocket);
  registerWebSocketRoutes(app, { agentService: h.service } as unknown as RouteServices);
  await app.ready();
  t.after(() => app.close());
  const packets: { type: string; confirmation?: { id: string } }[] = [];
  const socket = await app.injectWS("/ws/agent/global", {}, { onInit(ws) {
    ws.on("message", (data: { toString(): string }) => packets.push(JSON.parse(data.toString())));
  } });
  assert.equal(packets.find((packet) => packet.type === "snapshot")?.confirmation?.id, pending.id);
  h.service.resolveConfirmation("global", pending.id, true);
  await approval;
  assert.equal(h.service.getPendingGlobalConfirmation(), null);
  socket.close();
});

test("cache invariant: 30 turns retain exact model history, tool schemas and reasoning across runtime changes and restart", async (t) => {
  const requests: Parameters<ModelService["chatCompletionStream"]>[0][] = [];
  let files: unknown[] = [];
  const stream: ModelService["chatCompletionStream"] = async (input) => {
    requests.push(structuredClone({ ...input, signal: undefined }));
    const index = requests.length;
    // Include capability enablement, which must not mutate tool declarations.
    if (index === 1) return { ...result("  检查前  ", [call("enable", "install_agent_capability", '{"capability":"zip_extract"}')]),
      replayContent: "  检查前  ", replayReasoning: " reasoning \n", reasoning: "reasoning" };
    if (index === 2) return result("", [call("files", "list_server_files")]);
    return { ...result(`完成 ${index}`), replayReasoning: ` exact reasoning ${index}\n` };
  };
  let h = harness(stream, async () => files);
  t.after(h.dispose);
  const id = h.id;
  for (let turn = 0; turn < 30; turn++) {
    if (turn === 15) {
      h = harness(stream, async () => files, undefined, id);
      t.after(h.dispose);
    }
    files = [{ type: "file", path: `state-${turn}.txt` }];
    await h.service.sendMessage(id, `任务 ${turn}`);
  }
  assert.equal(requests.length, 32);
  for (let i = 1; i < requests.length; i++) {
    const previous = requests[i - 1]!;
    const current = requests[i]!;
    assert.deepEqual(current.tools, previous.tools, `tools changed at request ${i}`);
    assert.deepEqual(current.messages.slice(0, previous.messages.length), previous.messages, `history changed at request ${i}`);
    assert.equal(current.messages[0]?.content?.includes("state-"), false);
  }
  const latest = requests.at(-1)!.messages;
  assert.equal(latest.filter((message) => message.role === "user" && message.content?.startsWith("任务 ")).length, 30);
  assert.deepEqual(JSON.parse(latest.find((message) => message.tool_call_id === "files")!.content!), [{ type: "file", path: "state-0.txt" }]);
  assert.equal(latest.find((message) => message.tool_calls?.[0]?.id === "enable")?.reasoning_content, " reasoning \n");
  assert.equal(latest.find((message) => message.tool_calls?.[0]?.id === "enable")?.content, "  检查前  ");
  assert.ok(latest.some((message) => message.role === "assistant" && message.reasoning_content === " exact reasoning 31\n"));
  const store = new SessionStore();
  assert.deepEqual(store.messages(id).slice(0, latest.length), latest);
  assert.ok(!JSON.stringify(store.events(id)).includes("apiKey"));
  await h.service.clearContext(id);
  assert.deepEqual(store.messages(id), []);
  await h.service.sendMessage(id, "全新会话");
  assert.ok(!requests.at(-1)!.messages.some((message) => message.content === "任务 0"));
});

test("compaction replays the warm system/tools/history prefix and preserves the original log", async (t) => {
  const h = harness(async () => result("unused"));
  t.after(h.dispose);
  const store = new SessionStore();
  const messages = [{ role: "system" as const, content: "original system" },
    ...Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? "assistant" as const : "user" as const,
      content: `${index}:` + "detail ".repeat(12000), ...(index % 2 ? { reasoning_content: " exact reasoning\n" } : {}) }))];
  const tools = [{ type: "function" as const, function: { name: "read", description: "read", parameters: { type: "object" } } }];
  store.commit(h.id, messages);
  store.setHeader(h.id, { baseUrl: "http://model.test", modelName: "test-model", apiType: "chat_completions", reasoningEffort: "high", tools });
  const model = (h.service as unknown as { modelService: ModelService }).modelService;
  model.chatCompletionResult = async (input: Parameters<ModelService["chatCompletionResult"]>[0]) => {
    assert.deepEqual(input.tools, tools);
    assert.equal(input.reasoningEffort, "high");
    assert.ok(input.messages.length < messages.length);
    assert.deepEqual(input.messages.slice(0, -1), messages.slice(0, input.messages.length - 1));
    assert.match(input.messages.at(-1)!.content!, /检查点/);
    return result("summary");
  };
  const compacted = await h.service.compressContext(h.id);
  assert.ok(compacted.compressed > 0);
  assert.equal(store.messages(h.id)[0]!.content, "original system");
  assert.match(store.messages(h.id)[1]!.content!, /<compacted-summary>/);
  assert.deepEqual(store.messages(h.id).at(-1), messages.at(-1));
  assert.equal(store.events(h.id).filter((event) => event.kind === "replace").length, 1);
  assert.deepEqual(JSON.parse(store.events(h.id)[0]!.payload), messages);
});

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

test("turns, steps, messages and events carry durable execution identities", async (t) => {
  let round = 0;
  const h = harness(async () => round++ === 0 ? result("检查文件", [call("inspect", "list_server_files")]) : result("完成"));
  t.after(h.dispose);
  await h.service.sendMessage(h.id, "检查");
  const [turn] = h.service.listExecutions(h.id);
  assert.equal(turn!.status, "completed");
  assert.equal(turn!.resumable, false);
  const detail = h.service.getExecution(h.id, turn!.id);
  assert.deepEqual(detail.steps.map((step) => step.status), ["completed", "completed"]);
  assert.equal(detail.toolCalls.length, 1);
  assert.ok(h.service.listMessages(h.id).every((message) => message.turnId === turn!.id));
  assert.ok(h.events.every((event) => event.turnId === turn!.id));
  assert.equal(detail.toolCalls[0]!.stepId, detail.steps[0]!.id);
  assert.throws(() => h.service.getExecution("other-scope", turn!.id), /不存在/);
});

test("failed model step resumes with structured tool history and without another user turn", async (t) => {
  let round = 0;
  let recover = false;
  const h = harness(async (input) => {
    if (round++ === 0) return result("", [call("read-once", "list_server_files")]);
    if (!recover) throw new Error("connection lost");
    assert.ok(input.messages.some((message) => message.role === "assistant" && message.tool_calls?.[0]?.id === "read-once"));
    assert.ok(input.messages.some((message) => message.role === "tool" && message.tool_call_id === "read-once"));
    return result("恢复完成");
  });
  t.after(h.dispose);
  await h.service.sendMessage(h.id, "检查");
  const [turn] = h.service.listExecutions(h.id);
  assert.equal(turn!.status, "failed");
  assert.equal(turn!.resumable, true);
  recover = true;
  assert.equal(await h.service.resumeExecution(h.id, turn!.id), "恢复完成");
  assert.equal(h.service.listExecutions(h.id).length, 1);
  assert.equal(h.service.listMessages(h.id).filter((message) => message.role === "user").length, 1);
  assert.equal(h.service.getExecution(h.id, turn!.id).toolCalls.length, 1);
});

test("restart terminalizes orphan calls as uncertain outcomes without replaying side effects", async (t) => {
  const h = harness(async (input) => {
    assert.match(input.messages.find((message) => message.tool_call_id === "write")!.content!, /外部副作用结果不确定/);
    return result("先核对实际状态");
  });
  t.after(h.dispose);
  const store = new ExecutionStore();
  const turn = store.create(h.id, "修改配置", "high", "test-model", null);
  const stepId = `${turn.id}:step:0`;
  turn.checkpoint = { messages: [{ role: "user", content: "修改配置" }], step: 0, result: result("", [call("write", "write_server_text_file")]) };
  store.save(turn);
  store.saveCall({ id: `${stepId}:tool:write`, turnId: turn.id, stepId, toolCallId: "write", name: "write_server_text_file", arguments: "{}", status: "running", startedAt: new Date().toISOString() });
  ExecutionStore.recoverInterrupted();
  assert.equal(store.get(h.id, turn.id).status, "interrupted");
  assert.equal(h.service.getExecution(h.id, turn.id).resumable, true);
  assert.equal(await h.service.resumeExecution(h.id, turn.id), "先核对实际状态");
  assert.equal(store.calls(turn.id)[0]!.outcome, "interrupted");
});

test("resume reuses a persisted model decision and completed calls in a partial tool batch", async (t) => {
  let requests = 0;
  const h = harness(async (input) => {
    requests++;
    assert.equal(input.messages.filter((message) => message.role === "tool").length, 2);
    assert.equal(input.messages.find((message) => message.tool_call_id === "done")?.content, "cached-output");
    return result("完成");
  });
  t.after(h.dispose);
  const store = new ExecutionStore();
  const turn = store.create(h.id, "检查", "high", "test-model", null);
  const stepId = `${turn.id}:step:0`;
  turn.checkpoint = { step: 0, messages: [{ role: "user", content: "检查" }],
    result: result("", [call("done", "list_server_files"), call("pending", "list_server_files")]) };
  store.save(turn);
  store.saveCall({ id: `${stepId}:tool:done`, turnId: turn.id, stepId, toolCallId: "done", name: "list_server_files", arguments: "{}", status: "completed", output: "cached-output", startedAt: new Date().toISOString() });
  ExecutionStore.recoverInterrupted();
  assert.equal(await h.service.resumeExecution(h.id, turn.id), "完成");
  assert.equal(requests, 1);
  assert.equal(store.calls(turn.id).length, 2);
  assert.equal(store.get(h.id, turn.id).status, "completed");
});

test("completed or cancelled turns and superseded checkpoints cannot be resumed", async (t) => {
  const h = harness(async () => result("完成"));
  t.after(h.dispose);
  const store = new ExecutionStore();
  const old = store.create(h.id, "旧任务", "high", "test-model", null);
  old.status = "failed";
  old.checkpoint = { step: 0, messages: [{ role: "user", content: old.input }] };
  store.save(old);
  await h.service.sendMessage(h.id, "新任务");
  assert.equal(h.service.getExecution(h.id, old.id).resumable, false);
  await assert.rejects(h.service.resumeExecution(h.id, old.id), /后续任务/);
  const latest = h.service.listExecutions(h.id)[0]!;
  await assert.rejects(h.service.resumeExecution(h.id, latest.id), /只能恢复/);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("background tool does not block the next step and steers the active turn at a model boundary", async (t) => {
  const files = deferred<{ path: string }>();
  const inFlight = deferred<void>();
  const continueModel = deferred<void>();
  const completed = deferred<void>();
  let round = 0;
  const h = harness(async (input) => {
    if (round++ === 0) return result("", [call("bg", "install_java_version", '{"version":"21","background":true}')]);
    if (round === 2) {
      const receipt = input.messages.find((message) => message.tool_call_id === "bg");
      assert.equal(JSON.parse(receipt!.content!).status, "background");
      inFlight.resolve();
      await continueModel.promise;
      return result("先完成独立检查");
    }
    assert.ok(input.messages.some((message) => message.content?.includes("后台工具结果") && message.content.includes("background-file")));
    return result("已汇总后台结果");
  }, async () => [], () => files.promise);
  t.after(h.dispose);
  const listener = (payload: { serverId: string; event: AgentEvent }) => {
    if (payload.serverId === h.id && payload.event.type === "confirmation_required") h.service.resolveConfirmation(h.id, payload.event.confirmation!.id, true);
    if (payload.serverId === h.id && payload.event.type === "inbox_updated" && h.service.listInbox(h.id).length) completed.resolve();
  };
  eventBus.on("agent", listener);
  t.after(() => eventBus.off("agent", listener));
  const response = h.service.sendMessage(h.id, "后台检查文件");
  await inFlight.promise;
  assert.equal(h.service.listToolJobs(h.id)[0]!.status, "running");
  files.resolve({ path: "background-file" });
  await completed.promise;
  continueModel.resolve();
  assert.equal(await response, "已汇总后台结果");
  assert.equal(round, 3);
  assert.equal(h.service.listExecutions(h.id).length, 1);
  assert.equal(h.service.listInbox(h.id).length, 0);
  assert.equal(h.service.listToolJobs(h.id)[0]!.status, "completed");
});

test("completion of a detached tool wakes an idle scope through synthetic inbox input", async (t) => {
  const files = deferred<{ path: string }>();
  const resumed = deferred<void>();
  let round = 0;
  const h = harness(async (input) => {
    if (round++ === 0) return result("", [call("bg-idle", "install_java_version", '{"version":"21","background":true}')]);
    if (round === 2) return result("任务已后台化");
    assert.ok(input.messages.some((message) => message.content?.includes("late-result")));
    return result("收到后台结果");
  }, async () => [], () => files.promise);
  t.after(h.dispose);
  const listener = (payload: { serverId: string; event: AgentEvent }) => {
    if (payload.serverId === h.id && payload.event.type === "confirmation_required") h.service.resolveConfirmation(h.id, payload.event.confirmation!.id, true);
    if (payload.serverId === h.id && payload.event.type === "done" && round === 3) resumed.resolve();
  };
  eventBus.on("agent", listener);
  t.after(() => eventBus.off("agent", listener));
  await h.service.sendMessage(h.id, "检查");
  assert.equal(round, 2);
  files.resolve({ path: "late-result" });
  await resumed.promise;
  assert.equal(h.service.listExecutions(h.id).length, 2);
  assert.equal(h.service.listMessages(h.id).filter((message) => message.role === "user").length, 1);
  assert.equal(h.service.listInbox(h.id).length, 0);
});

test("resume=false queue waits for a new turn while steer is injected before the next model step", async (t) => {
  let requests = 0;
  const h = harness(async (input) => {
    requests++;
    assert.ok(input.messages.some((message) => message.content?.includes("queued-note")));
    if (requests === 1) {
      h.service.steer(h.id, "steered-note");
      return result("旧回答");
    }
    assert.ok(input.messages.some((message) => message.content?.includes("steered-note")));
    return result("合并补充信息");
  });
  t.after(h.dispose);
  h.service.steer(h.id, "queued-note", "queue", undefined, "synthetic", false);
  await Promise.resolve();
  assert.equal(requests, 0);
  assert.equal(await h.service.sendMessage(h.id, "开始"), "合并补充信息");
  assert.equal(h.service.listInbox(h.id).length, 0);
});

test("an active blocking Java install can be backgrounded through the service", async (t) => {
  const started = deferred<void>();
  const files = deferred<{ path: string }>();
  const finished = deferred<void>();
  let round = 0;
  const h = harness(async () => round++ === 0 ? result("", [call("detach", "install_java_version", '{"version":"21"}')]) : result("已继续"), async () => [], () => {
    started.resolve();
    return files.promise;
  });
  t.after(h.dispose);
  const listener = (payload: { serverId: string; event: AgentEvent }) => {
    if (payload.serverId === h.id && payload.event.type === "confirmation_required") h.service.resolveConfirmation(h.id, payload.event.confirmation!.id, true);
    if (payload.serverId === h.id && payload.event.type === "inbox_updated" && h.service.listInbox(h.id).length) finished.resolve();
  };
  eventBus.on("agent", listener);
  t.after(() => eventBus.off("agent", listener));
  const response = h.service.sendMessage(h.id, "检查文件");
  await started.promise;
  assert.equal(h.service.backgroundTools(h.id).backgrounded, 1);
  assert.equal(await response, "已继续");
  assert.equal(h.service.listToolJobs(h.id)[0]!.status, "running");
  h.service.cancel(h.id);
  files.resolve({ path: "/test/java" });
  await finished.promise;
  assert.equal(h.service.listInbox(h.id)[0]!.delivery, "queue");
});

test("background Java approval can arrive after the original turn ends without resurrecting its status", async (t) => {
  let installs = 0;
  let round = 0;
  const h = harness(async () => round++ === 0
    ? result("", [call("approval", "install_java_version", '{"version":"21","background":true}')])
    : result("后台任务已提交"), async () => [], async () => { installs++; return { path: "/java" }; });
  t.after(h.dispose);
  await h.service.sendMessage(h.id, "安装 Java");
  const confirmation = h.service.getPendingConfirmation(h.id);
  assert.ok(confirmation);
  assert.equal(installs, 0);
  assert.equal(h.service.getStatus(h.id), "completed");
  h.service.cancel(h.id);
  assert.equal(h.service.getPendingConfirmation(h.id), null);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(installs, 0);
  assert.equal(h.service.getStatus(h.id), "completed");
});

test("durable request admission reconciles retries after a new service instance", async (t) => {
  const finished = deferred<void>();
  const h = harness(async () => result("done")); t.after(h.dispose);
  const listener = (payload: { serverId: string; event: AgentEvent }) => {
    if (payload.serverId === h.id && payload.event.type === "done") finished.resolve();
  };
  eventBus.on("agent", listener); t.after(() => eventBus.off("agent", listener));
  const accepted = await h.service.acceptMessage(h.id, "durable-id", "one request", "high");
  await finished.promise;
  const restarted = harness(async () => { throw new Error("must not rerun"); }, undefined, undefined, h.id); t.after(restarted.dispose);
  assert.deepEqual(await restarted.service.acceptMessage(h.id, "durable-id", "one request", "high"), accepted);
  assert.equal(restarted.service.listExecutions(h.id).length, 1);
  await assert.rejects(restarted.service.acceptMessage(h.id, "durable-id", "different", "high"), /其他内容/);
});

test("idle queue wakes once; active queue stays pending until idle and delivers one at a time", async (t) => {
  const finished = deferred<void>(); let round = 0;
  const h = harness(async (input) => {
    round++;
    if (round === 1) {
      assert.ok(input.messages.some((message) => message.content?.includes("first-queue")));
      h.service.steer(h.id, "later-queue", "queue");
      return result("", [call("read", "list_server_files")]);
    }
    if (round === 2) {
      assert.ok(!input.messages.some((message) => message.content?.includes("later-queue")));
      return result("current work done");
    }
    assert.ok(input.messages.some((message) => message.content?.includes("later-queue")));
    return result("queued work done");
  }); t.after(h.dispose);
  const listener = (payload: { serverId: string; event: AgentEvent }) => {
    if (payload.serverId === h.id && payload.event.type === "done") finished.resolve();
  };
  eventBus.on("agent", listener); t.after(() => eventBus.off("agent", listener));
  h.service.steer(h.id, "first-queue", "queue");
  await finished.promise;
  assert.equal(round, 3);
  assert.equal(h.service.listExecutions(h.id).length, 1);
  assert.equal(h.service.listInbox(h.id).length, 0);
});

test("bounded restart recovery resumes an owner once and never duplicates completed tool effects", async (t) => {
  const finished = deferred<void>(); let requests = 0, effects = 0;
  const h = harness(async (input) => {
    requests++;
    assert.match(input.messages.find((message) => message.tool_call_id === "once")!.content!, /saved-output/);
    assert.ok(input.messages.some((message) => message.content?.includes("服务重启后继续")));
    return result("recovered");
  }, async () => { effects++; return []; }); t.after(h.dispose);
  const store = new ExecutionStore(), turn = store.create(h.id, "recover", "high", "test-model", null);
  const stepId = `${turn.id}:step:0`;
  turn.checkpoint = { step: 0, messages: [{ role: "system", content: "Test" }], result: result("", [call("once", "list_server_files")]) };
  store.save(turn);
  store.saveCall({ id: `${stepId}:tool:once`, turnId: turn.id, stepId, toolCallId: "once", name: "list_server_files", arguments: "{}", status: "completed", output: "saved-output", startedAt: new Date().toISOString() });
  ExecutionStore.recoverInterrupted();
  const listener = (payload: { serverId: string; event: AgentEvent }) => {
    if (payload.serverId === h.id && payload.event.type === "done") finished.resolve();
  };
  eventBus.on("agent", listener); t.after(() => eventBus.off("agent", listener));
  h.service.startInbox(); h.service.startInbox(); await finished.promise;
  assert.equal(requests, 1);
  assert.equal(effects, 2, "only initial and step runtime-context snapshots list files; the saved tool is not re-executed");
  assert.equal(store.get(h.id, turn.id).restartResumes, 1);
  const exhausted = store.create(h.id, "exhausted", "high", "test-model", null);
  exhausted.status = "interrupted"; exhausted.restartResumes = 3;
  exhausted.checkpoint = { step: 0, messages: [{ role: "system", content: "Test" }] }; store.save(exhausted);
  h.service.startInbox();
  assert.equal(store.get(h.id, exhausted.id).status, "failed");
  assert.match(store.get(h.id, exhausted.id).error!, /3 次上限/);
  assert.equal(requests, 1);
});

test("multiple observational tool calls overlap but model history preserves call order", async (t) => {
  const bothStarted = deferred<void>(), release = deferred<void>(); let started = 0, round = 0;
  const h = harness(async (input) => {
    if (round++ === 0) return result("", [call("first", "list_server_files"), call("second", "list_server_files")]);
    assert.deepEqual(input.messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id), ["first", "second"]);
    return result("parallel done");
  }, async () => {
    if (round === 0) return []; // Runtime-context snapshots precede the first model response.
    if (++started === 2) bothStarted.resolve(); await release.promise; return [];
  }); t.after(h.dispose);
  const running = h.service.sendMessage(h.id, "read twice");
  await bothStarted.promise; assert.equal(started, 2); release.resolve();
  assert.equal(await running, "parallel done");
});

test("active compaction is an inbox control boundary and never becomes a fake user prompt", async (t) => {
  const entered = deferred<void>(), release = deferred<void>(); let round = 0, compacted = 0;
  const h = harness(async (input) => {
    round++;
    if (round === 1) {
      entered.resolve(); await release.promise;
      return result("", [call("read", "list_server_files")]);
    }
    assert.equal(compacted, 1);
    assert.ok(input.messages.some((message) => message.content?.includes("after-control")));
    assert.ok(!input.messages.some((message) => message.content?.includes("Inbox synthetic input") && message.content.includes("压缩上下文")));
    return result("done");
  }); t.after(h.dispose);
  // Isolate inbox ordering from the auxiliary model's summary quality.
  (h.service as unknown as { compactSession: () => Promise<{ ok: boolean; compressed: number }> }).compactSession = async () => {
    compacted++;
    assert.ok(!new SessionStore().messages(h.id).some((message) => message.content?.includes("after-control")));
    return { ok: true, compressed: 1 };
  };
  const running = h.service.sendMessage(h.id, "long task"); await entered.promise;
  const accepted = await h.service.compressContext(h.id);
  assert.equal("accepted" in accepted && accepted.accepted, true);
  h.service.steer(h.id, "after-control"); release.resolve();
  assert.equal(await running, "done");
  assert.equal(h.service.listInbox(h.id).length, 0);
});

test("one process owns a scope across service instances and different scopes remain independent", async (t) => {
  const entered = deferred<void>(), release = deferred<void>();
  const first = harness(async () => { entered.resolve(); await release.promise; return result("first"); }); t.after(first.dispose);
  const second = harness(async () => result("second"), undefined, undefined, first.id); t.after(second.dispose);
  const independent = harness(async () => result("independent")); t.after(independent.dispose);
  const running = first.service.sendMessage(first.id, "hold"); await entered.promise;
  await assert.rejects(second.service.sendMessage(second.id, "conflict"), /正在处理/);
  assert.equal(await independent.service.sendMessage(independent.id, "other"), "independent");
  release.resolve(); await running;
  assert.equal(await second.service.sendMessage(second.id, "after release"), "second");
});

test("background Shell polling is rejected before resource waiting, ordinary loops remain available", (t) => {
  const h = harness(async () => result()); t.after(h.dispose);
  const check = (h.service as unknown as { backgroundPollingError(scopeId: string, name: string, args: Record<string, unknown>): string | undefined }).backgroundPollingError.bind(h.service);
  const job = { id: "poll-guard", scopeId: h.id, turnId: "test", stepId: "test", toolCallId: "test", name: "setup_neoforge_server", arguments: {}, background: true, status: "running", startedAt: new Date().toISOString() };
  getSqlite().prepare("INSERT INTO agent_tool_jobs VALUES (?,?,?,?)").run(job.id, h.id, "running", JSON.stringify(job));
  for (const command of ["sleep 300", "while pgrep -f installer; do sleep 3; done", "ps aux | grep neoforge", "tail -f install.log"]) assert.match(check(h.id, "run_shell_command", { command })!, /wait_for_background_job/);
  assert.equal(check(h.id, "run_shell_command", { command: "for f in *.cfg; do cat \"$f\"; done" }), undefined);
  getSqlite().prepare("DELETE FROM agent_tool_jobs WHERE id=?").run(job.id);
  assert.equal(check(h.id, "run_shell_command", { command: "sleep 1" }), undefined);
});

test("global handoff is queued durably while the target is busy and completion returns through parent inbox", async (t) => {
  const h = harness(async () => result("unused")); t.after(h.dispose);
  const store = new ExecutionStore();
  const parent = store.create("global", "deploy", "high", "test-model", null);
  parent.status = "completed"; parent.handoff = { status: "pending" }; store.save(parent);
  const service = h.service as unknown as {
    dispatchFocusHandoff(focus: { focusServerId: string; focusTask: string; focusReason: string }, turnId: string): Promise<void>;
    completeFocusHandoff(child: ReturnType<ExecutionStore["create"]>): void;
    scheduleInbox(scopeId: string): void;
  };
  service.scheduleInbox = () => undefined; // Inspect admission without starting either model.
  const focus = { focusServerId: h.id, focusTask: "deploy", focusReason: "target instance" };
  await service.dispatchFocusHandoff(focus, parent.id);
  await service.dispatchFocusHandoff(focus, parent.id);
  assert.equal(h.service.listInbox(h.id).length, 1);
  const [item] = h.service.listInbox(h.id);
  assert.equal(item!.kind, "user"); assert.equal(item!.delivery, "queue");
  assert.equal(item!.handoffParentTurnId, parent.id);
  const child = store.create(h.id, "deploy", "high", "test-model", parent.id);
  child.status = "completed"; store.save(child);
  service.completeFocusHandoff(child); service.completeFocusHandoff(child);
  const notifications = h.service.listInbox("global").filter((item) => item.id === `handoff-result:${parent.id}`);
  assert.equal(notifications.length, 1); assert.match(notifications[0]!.text, /status: completed/);
  assert.equal(store.get("global", parent.id).handoff!.status, "completed");
});

test("global-to-instance handoff executes the child once and wakes the parent with one completion", { timeout: 10000 }, async (t) => {
  const complete = deferred<void>(); let globalCalls = 0, childCalls = 0;
  let h: ReturnType<typeof harness>;
  h = harness(async (input) => {
    if (input.messages.some((message) => message.content?.includes("实例交接结果"))) {
      globalCalls++; return result("父任务收到完成结果");
    }
    if (input.messages.some((message) => message.content?.includes("来自全局 Agent 的任务交接"))) {
      childCalls++; return result("子任务完成");
    }
    if (++globalCalls === 1) return result("", [call("focus", "focus_instance", JSON.stringify({ serverId: h.id, task: "检查实例", reason: "test" }))]);
    return result("已交接");
  }); t.after(h.dispose);
  // Other tests intentionally leave durable global notifications pending.
  for (const item of h.service.listInbox("global")) h.service.cancelInbox("global", item.id);
  await h.service.clearGlobalContext();
  (h.service as unknown as { buildGlobalRuntimeContext: () => Promise<string> }).buildGlobalRuntimeContext = async () => "global-runtime";
  const listener = (payload: { serverId: string; event: AgentEvent }) => {
    if (payload.serverId === "global" && payload.event.type === "done" && globalCalls === 3) complete.resolve();
  };
  eventBus.on("agent", listener); t.after(() => eventBus.off("agent", listener));
  await h.service.sendGlobalMessage("把检查任务交接给实例"); await complete.promise;
  assert.equal(childCalls, 1); assert.equal(globalCalls, 3);
  const child = h.service.listExecutions(h.id)[0]!;
  assert.ok(child.parentTurnId);
  assert.equal(h.service.getExecution("global", child.parentTurnId!).handoff!.status, "completed");
  assert.equal(h.service.listInbox(h.id).length, 0);
});
