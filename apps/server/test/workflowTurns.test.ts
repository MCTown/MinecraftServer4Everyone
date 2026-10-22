import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { AgentService } from "../src/agent/agentService.js";
import { ExecutionStore } from "../src/agent/executionStore.js";
import { ToolRuntime, backgroundableTools } from "../src/agent/toolRuntime.js";
import { appConfig } from "../src/config.js";
import { getSqlite, initDatabase } from "../src/db/client.js";
import { compileDeploymentWorkflow, defaultDeploymentWorkflow as parallelDeploymentWorkflow, deploymentStageCatalog, deploymentRounds, workflowIssues, type DeploymentWorkflow } from "../src/services/deploymentWorkflow.js";
import { eventBus } from "../src/services/eventBus.js";
import type { ChatCompletionResult, ModelService } from "../src/services/modelService.js";
import type { AgentEvent } from "../src/types.js";

let root: string;
const defaultDeploymentWorkflow = (): DeploymentWorkflow => ({ version: 1, steps: deploymentStageCatalog.map(({ id, label, prompt }) => ({ id, label, prompt, enabled: true })) });
before(async () => {
  root = await mkdtemp("/tmp/opencode/workflow-turns-");
  appConfig.dataDir = path.join(root, "data");
  await mkdir(appConfig.dataDir, { recursive: true }); initDatabase();
});
after(async () => { getSqlite().close(); await rm(root, { recursive: true, force: true }); });

const result = (calls: ChatCompletionResult["toolCalls"] = [], content = "本轮完成"): ChatCompletionResult => ({ content, toolCalls: calls, reasoning: "", usage: null });
const call = (name: string, args: Record<string, unknown> = {}) => ({ id: crypto.randomUUID(), type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
const done = (stepId: string) => call("update_agent_workflow_progress", { stepId, status: "completed" });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };

test("Loader installers detach so MCDR work overlaps and join waits for the real result", async () => {
  for (const name of ["setup_forge_server", "setup_neoforge_server", "deploy_mrpack_server_from_server_slot"]) {
    assert.ok(backgroundableTools.has(name));
    const runtime = new ToolRuntime(() => undefined), installed = deferred<string>();
    const scopeId = crypto.randomUUID();
    const receipt = await runtime.execute({ scopeId, turnId: "loader-turn", stepId: "step", toolCallId: "loader", name,
      arguments: { workflowStepId: "install_modloader" }, background: true }, new AbortController().signal, () => installed.promise);
    assert.ok(receipt);
    let configured = false;
    await runtime.execute({ scopeId, turnId: "loader-turn", stepId: "step", toolCallId: "mcdr", name: "run_shell_command",
      arguments: { workflowStepId: "configure_mcdr" }, background: false }, new AbortController().signal, async () => { configured = true; return "configured"; });
    assert.ok(configured);
    assert.equal(runtime.turnJobs(scopeId, "loader-turn").find((job) => job.name === name)!.status, "running");
    const joined = runtime.join(scopeId, "loader-turn", new AbortController().signal);
    installed.resolve("installed"); await joined;
    assert.equal(runtime.turnJobs(scopeId, "loader-turn").find((job) => job.name === name)!.status, "completed");
  }
});

test("workflow join yields to external steer without releasing its job barrier", async () => {
  const runtime = new ToolRuntime(() => undefined), result = deferred<string>(), scopeId = crypto.randomUUID();
  await runtime.execute({ scopeId, turnId: "steer-turn", stepId: "step", toolCallId: "loader", name: "setup_neoforge_server", arguments: {}, background: true }, new AbortController().signal, () => result.promise);
  const waiting = runtime.join(scopeId, "steer-turn", new AbortController().signal,
    () => runtime.inbox(scopeId).some((item) => !item.sourceJobId && item.delivery === "steer"));
  const steer = runtime.enqueue(scopeId, "检查新约束"); runtime.notify(scopeId);
  await waiting;
  assert.equal(runtime.turnJobs(scopeId, "steer-turn")[0]!.status, "running");
  runtime.delivered(steer, "steer-turn");
  const joined = runtime.join(scopeId, "steer-turn", new AbortController().signal);
  result.resolve("done"); await joined;
  assert.equal(runtime.turnJobs(scopeId, "steer-turn")[0]!.status, "completed");
});

function harness(stream: ModelService["chatCompletionStream"], workflow = defaultDeploymentWorkflow(), install = async () => ({ path: "/workspace/jdks/java-21/bin/java" })) {
  const id = crypto.randomUUID();
  const model = { getDecryptedDefault: () => ({ baseUrl: "http://model.test", modelName: "test", apiKey: "unused" }), getContextMaxTokens: () => 200000, getContextSizeK: () => 200, chatCompletionStream: stream } as unknown as ModelService;
  const server = { id, name: "Test", directory: root, status: "stopped", minMemory: "2G", maxMemory: "2G" };
  const service = new AgentService(
    { requireServer: async () => server, updateServer: async () => server } as never,
    { append: () => undefined } as never,
    { list: async () => [], getServerSlotStatus: async () => null } as never, {} as never, model,
      { getEffectivePrompt: async (_id: string, snapshot: DeploymentWorkflow, mode: "continuous" | "rounds") => compileDeploymentWorkflow(snapshot, mode), getDeploymentWorkflow: () => structuredClone(workflow), getAgentSettings: () => ({ memory: "2G" }), getAgentAutoConfirm: () => true,
      getBraveSearchApiKey: () => "", getTavilyApiKey: () => "", getSearxngBaseUrl: () => "" } as never,
    { list: () => [] } as never, { recommendVersion: () => "21", installVersion: install } as never
  );
  const events: AgentEvent[] = [];
  const listener = (payload: { serverId: string; event: AgentEvent }) => {
    if (payload.serverId !== id) return;
    events.push(payload.event);
    if (payload.event.status === "waiting_confirmation") {
      const question = service.getPendingQuestion(id);
      if (question) service.resolveQuestion(id, question.id, [question.options[0]!.label]);
    }
  };
  eventBus.on("agent", listener);
  return { service, id, events, dispose: () => eventBus.off("agent", listener) };
}

function terminal(id: string) {
  return new Promise<AgentEvent>((resolve) => {
    const listener = (payload: { serverId: string; event: AgentEvent }) => {
      if (payload.serverId !== id || payload.event.type !== "done") return;
      eventBus.off("agent", listener); resolve(payload.event);
    };
    eventBus.on("agent", listener);
  });
}

test("closed parallel groups compile into one round and reject unsafe gates", () => {
  const workflow = defaultDeploymentWorkflow();
  const [python] = workflow.steps.splice(workflow.steps.findIndex((step) => step.id === "configure_python"), 1);
  workflow.steps.splice(3, 0, python!);
  workflow.steps[2]!.parallelGroup = workflow.steps[3]!.parallelGroup = "parallel_dependencies";
  assert.deepEqual(workflowIssues(workflow), []);
  assert.equal(deploymentRounds(workflow).length, 7);
  assert.match(compileDeploymentWorkflow(workflow), /依赖层 3: 分叉 → 检查 Java 版本依赖 \[check_java_dependencies\] ∥ 配置内置 Python \[configure_python\] → 汇合/);
  const dependent = structuredClone(workflow); dependent.steps[3]!.parallelGroup = dependent.steps[4]!.parallelGroup = "parallel_dependencies";
  assert.deepEqual(workflowIssues(dependent), [], "stage order no longer blocks a wider parallel group");
  const disjoint = structuredClone(workflow); disjoint.steps[5]!.parallelGroup = "parallel_dependencies";
  assert.ok(workflowIssues(disjoint).some((issue) => issue.includes("必须连续且收束")));
  const gate = structuredClone(workflow); gate.steps[0]!.parallelGroup = gate.steps[1]!.parallelGroup = "parallel_confirm";
  assert.ok(workflowIssues(gate).some((issue) => issue.includes("独立关口")));
});

function resumeLegacy(h: ReturnType<typeof harness>, input: string, workflow = defaultDeploymentWorkflow()) {
  const store = new ExecutionStore(), turn = store.create(h.id, input, "high", "test", null);
  turn.status = "failed"; turn.workflowScheduling = 1; turn.deploymentWorkflow = structuredClone(workflow);
  const system = (h.service as unknown as { composeSystemPrompt(prompt: string): string }).composeSystemPrompt(compileDeploymentWorkflow(workflow, "rounds"));
  turn.checkpoint = { step: 0, messages: [{ role: "system", content: system }, { role: "user", content: input }] };
  store.save(turn);
  return h.service.resumeExecution(h.id, turn.id);
}

test("legacy serial deployment still auto-advances durable turns with a stable system/tools prefix", async (t) => {
  let h: ReturnType<typeof harness>;
  let phase = 0;
  const headers: string[] = [];
  h = harness(async (input) => {
    headers.push(JSON.stringify([input.messages[0], input.tools]));
    const turn = h.service.listExecutions(h.id)[0]!;
    const index = turn.workflowRun?.roundIndex ?? -1;
    if (index < 0) return result([call("begin_deployment_workflow")]);
    if (index === 0 && phase++ === 0) return result([call("ask_user", { workflowStepId: "identify_modpack", question: "确认整合包 A 版本 1？", options: [{ label: "确认 A 版本 1" }, { label: "取消" }] })]);
    const stepId = deploymentRounds(turn.deploymentWorkflow!)[index]!.steps[0]!.id;
    if (turn.workflowProgress!.steps.find((step) => step.id === stepId)!.status !== "completed") return result([done(stepId)]);
    return result([], `完成 ${stepId}`);
  });
  t.after(h.dispose);
  const finished = terminal(h.id);
  await resumeLegacy(h, "部署整合包 A");
  assert.equal((await finished).status, "completed", h.service.listExecutions(h.id)[0]?.error ?? "workflow failed");
  const turns = h.service.listExecutions(h.id).reverse();
  assert.equal(turns.length, 8);
  assert.deepEqual(turns.map((turn) => turn.workflowRun!.roundIndex), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.ok(turns.every((turn) => turn.status === "completed"));
  assert.equal(new Set(turns.map((turn) => turn.workflowRun!.id)).size, 1);
  for (let index = 1; index < turns.length; index++) {
    assert.equal(turns[index]!.workflowRun!.previousTurnId, turns[index - 1]!.id);
    assert.equal(turns[index - 1]!.workflowRun!.nextTurnId, turns[index]!.id);
  }
  assert.equal(new Set(headers).size, 1);
  assert.equal(h.events.filter((event) => event.type === "done").length, 1);
  assert.equal(h.events.filter((event) => event.type === "status" && event.status === "completed").length, 1, "no public completed status between turns");
});

test("legacy sparse graph still resumes eight stages in five durable turns", async (t) => {
  const workflow = parallelDeploymentWorkflow();
  let h: ReturnType<typeof harness>, asked = false;
  h = harness(async () => {
    const turn = h.service.listExecutions(h.id)[0]!;
    if (!turn.workflowRun) return result([call("begin_deployment_workflow")]);
    if (turn.workflowRun.roundIndex === 0 && !asked) {
      asked = true;
      return result([call("ask_user", { workflowStepId: "identify_modpack", question: "确认整合包 A 版本 1？", options: [{ label: "确认 A 版本 1" }, { label: "取消" }] })]);
    }
    const unfinished = deploymentRounds(workflow)[turn.workflowRun.roundIndex]!.steps.filter((step) => turn.workflowProgress?.steps.find((item) => item.id === step.id)?.status !== "completed");
    return result(unfinished.map((step) => done(step.id)));
  }, workflow);
  t.after(h.dispose);
  const finished = terminal(h.id);
  await resumeLegacy(h, "部署整合包 A", workflow);
  assert.equal((await finished).status, "completed", h.service.listExecutions(h.id)[0]?.error ?? undefined);
  const turns = h.service.listExecutions(h.id).reverse();
  assert.deepEqual(turns.map((turn) => turn.workflowRun!.roundIndex), [0, 1, 2, 3, 4]);
  assert.ok(turns.every((turn) => turn.status === "completed"));
  assert.ok(turns.at(-1)!.workflowProgress!.steps.every((step) => step.status === "completed"));
});

test("new deployment executes all eight stages in one durable execution with stable policy/tools", async (t) => {
  const workflow = parallelDeploymentWorkflow(), headers: string[] = [];
  let h: ReturnType<typeof harness>, asked = false, repeated = false;
  h = harness(async (input) => {
    headers.push(JSON.stringify([input.messages[0], input.tools]));
    const turn = h.service.listExecutions(h.id)[0]!;
    assert.equal(turn.workflowScheduling, 2);
    assert.equal(turn.workflowRun, undefined);
    assert.doesNotMatch(String(input.messages[0]!.content), /Turn 调度|串行节点各一个 turn|本轮只执行/);
    assert.ok(!input.tools!.find((tool) => tool.function.name === "begin_deployment_workflow")!.function.description.includes("系统将指定本轮节点"));
    if (!turn.deploymentRun) return result([call("begin_deployment_workflow")]);
    if (!asked) {
      asked = true;
      return result([call("ask_user", { workflowStepId: "identify_modpack", question: "确认 A 版本 1？", options: [{ label: "确认" }, { label: "取消" }] })]);
    }
    const unfinished = workflow.steps.find((step) => turn.workflowProgress!.steps.find((item) => item.id === step.id)!.status !== "completed");
    if (unfinished) return result([done(unfinished.id)]);
    if (!repeated) { repeated = true; return result([call("begin_deployment_workflow")]); }
    assert.ok(turn.workflowProgress!.steps.every((step) => step.status === "completed"), "reinitialization must not reset progress");
    assert.ok(turn.workflowProgress!.steps.every((step) => step.roundIndex === undefined));
    assert.equal(turn.workflowProgress!.turn, undefined);
    assert.equal(turn.workflowProgress!.run!.executionId, turn.id);
    return result([], "部署最终报告");
  }, workflow);
  t.after(h.dispose);
  assert.equal(await h.service.sendMessage(h.id, "部署整合包 A"), "部署最终报告");
  assert.equal(h.service.listExecutions(h.id).length, 1);
  assert.equal(h.events.filter((event) => event.type === "done").length, 1);
  assert.equal(h.service.listMessages(h.id).filter((message) => message.role === "user" && message.content === "部署整合包 A").length, 1);
  assert.equal(new Set(headers).size, 1);
});

test("continuous deployment joins background work, accepts steer and keeps one owner until real results", { timeout: 10000 }, async (t) => {
  const installed = deferred<{ path: string }>(), waiting = deferred<void>(), steered = deferred<void>();
  let phase = 0, h: ReturnType<typeof harness>, owner = "";
  h = harness(async (input) => {
    const turn = h.service.listExecutions(h.id)[0]!;
    owner ||= turn.id; assert.equal(turn.id, owner);
    if (phase++ === 0) return result([call("begin_deployment_workflow")]);
    if (phase === 2) return result([call("install_java_version", { version: "21", background: true, workflowStepId: "check_java_dependencies" }), done("configure_python")]);
    if (phase === 3) { waiting.resolve(); return result([], "提前结束"); }
    if (phase === 4) {
      assert.ok(input.messages.some((message) => message.content === "继续但不连接生产桥"));
      steered.resolve(); return result([], "仍不能结束");
    }
    assert.ok(input.messages.some((message) => message.content?.includes("后台工具结果")));
    return result([], "收到真实结果，部分步骤待完成");
  }, parallelDeploymentWorkflow(), () => installed.promise);
  t.after(h.dispose);
  const running = h.service.sendMessage(h.id, "并行部署");
  await waiting.promise;
  h.service.steer(h.id, "继续但不连接生产桥", "steer", undefined, "user");
  await steered.promise;
  assert.ok(h.service.isBusy(h.id));
  assert.equal(h.events.filter((event) => event.type === "done").length, 0);
  installed.resolve({ path: "java" });
  assert.match(await running, /执行已结束，不代表部署验收通过/);
  assert.equal(h.service.listExecutions(h.id).length, 1);
  assert.equal(h.service.listToolJobs(h.id)[0]!.status, "completed");
  assert.ok(h.events.some((event) => event.type === "workflow_progress" && event.workflow?.run?.waitingForJobs));
  assert.equal(h.service.getPresentation(h.id).workflow!.run!.waitingForJobs, false);
});

test("continuous deployment cancellation at join does not spawn a late-result execution", { timeout: 10000 }, async (t) => {
  const waiting = deferred<void>(), installed = deferred<{ path: string }>(); let phase = 0;
  const h = harness(async () => phase++ === 0 ? result([call("begin_deployment_workflow")])
    : phase === 2 ? result([call("install_java_version", { version: "21", background: true })]) : (waiting.resolve(), result()), parallelDeploymentWorkflow(), () => installed.promise);
  t.after(h.dispose);
  const running = h.service.sendMessage(h.id, "取消部署"); await waiting.promise;
  h.service.cancel(h.id);
  assert.match(await running, /已中断/);
  installed.resolve({ path: "java" });
  h.service.startInbox(); await new Promise<void>((resolve) => setImmediate(resolve));
  const turns = h.service.listExecutions(h.id);
  assert.equal(turns.length, 1); assert.equal(turns[0]!.status, "cancelled");
  assert.equal(turns[0]!.workflowProgress!.run!.waitingForJobs, false);
});

test("continuous background failure is returned to model without claiming validated success", async (t) => {
  let phase = 0;
  const h = harness(async (input) => {
    if (phase++ === 0) return result([call("begin_deployment_workflow")]);
    if (phase === 2) return result([call("install_java_version", { version: "21", background: true })]);
    if (phase === 3) return result();
    assert.ok(input.messages.some((message) => message.content?.includes("download failed")));
    return result([], "依赖下载失败，需要配置代理后继续");
  }, parallelDeploymentWorkflow(), async () => { throw new Error("download failed"); });
  t.after(h.dispose);
  const response = await h.service.sendMessage(h.id, "失败部署");
  assert.match(response, /下载失败/); assert.match(response, /不代表部署验收通过/);
  assert.equal(h.service.listToolJobs(h.id)[0]!.status, "failed");
  assert.equal(h.service.getPresentation(h.id).workflow!.status, "running", "progress is not a certificate");
  assert.equal(h.service.listExecutions(h.id).length, 1);
});

test("continuous restart recovery keeps owner, snapshot and completed calls without replay", async (t) => {
  let h: ReturnType<typeof harness>;
  const oldPolicy = "persisted continuous policy";
  h = harness(async (input) => {
    assert.equal(input.messages[0]!.content, oldPolicy);
    assert.ok(input.messages.some((message) => message.role === "tool" && message.content === "saved result"));
    return result([], "已核对旧结果，尚未完成部署");
  }); t.after(h.dispose);
  const store = new ExecutionStore(), snapshot = parallelDeploymentWorkflow(), turn = store.create(h.id, "重启恢复", "high", "test", null);
  turn.status = "interrupted"; turn.workflowScheduling = 2; turn.deploymentRun = { version: 1, task: turn.input }; turn.deploymentWorkflow = snapshot;
  const toolCall = call("get_current_server_config");
  turn.checkpoint = { step: 0, messages: [{ role: "system", content: oldPolicy }], result: result([toolCall]) };
  store.saveCall({ id: `${turn.id}:step:0:tool:${toolCall.id}`, turnId: turn.id, stepId: `${turn.id}:step:0`, toolCallId: toolCall.id,
    name: toolCall.function.name, arguments: toolCall.function.arguments, status: "completed", startedAt: new Date().toISOString(), output: "saved result" });
  store.save(turn);
  const finished = terminal(h.id); h.service.startInbox(); h.service.startInbox(); await finished;
  assert.equal(h.service.listExecutions(h.id).length, 1);
  assert.equal(store.calls(turn.id).length, 1);
  assert.deepEqual(store.get(h.id, turn.id).deploymentWorkflow, snapshot);
  assert.equal(store.get(h.id, turn.id).workflowRun, undefined);
  assert.equal(store.get(h.id, turn.id).restartResumes, 1);
});

test("continuous recovery without progress explicitly reports unverified completion", async (t) => {
  const h = harness(async () => result([], "恢复处理结束")); t.after(h.dispose);
  const store = new ExecutionStore(), turn = store.create(h.id, "恢复缺失进度的部署", "high", "test", null);
  turn.status = "failed"; turn.workflowScheduling = 2;
  turn.deploymentRun = { version: 1, task: turn.input };
  turn.deploymentWorkflow = parallelDeploymentWorkflow();
  turn.checkpoint = { step: 0, messages: [{ role: "system", content: "saved continuous policy" }] };
  store.save(turn);
  const response = await h.service.resumeExecution(h.id, turn.id);
  assert.match(response, /缺少阶段进度记录，无法确认部署完成/);
  assert.match(response, /执行已结束，不代表部署验收通过/);
  assert.equal(store.list(h.id).length, 1);
  assert.equal(store.get(h.id, turn.id).workflowRun, undefined);
});

test("continuous deployment preserves compaction boundaries and reports a global handoff only once", async (t) => {
  const entered = deferred<void>(), release = deferred<void>(); let phase = 0, compacted = 0, h: ReturnType<typeof harness>;
  h = harness(async (input) => {
    if (phase++ === 0) return result([call("begin_deployment_workflow")]);
    if (phase === 2) { entered.resolve(); await release.promise; return result([done("identify_modpack")]); }
    assert.equal(compacted, 1);
    assert.ok(input.messages.some((message) => message.content === "补充约束"));
    assert.ok(!input.messages.some((message) => message.content?.includes("Inbox synthetic input") && message.content.includes("压缩上下文")));
    return result([], "已结束，尚有步骤待继续");
  }); t.after(h.dispose);
  (h.service as unknown as { compactSession(): Promise<{ ok: boolean; compressed: number }> }).compactSession = async () => {
    compacted++; return { ok: true, compressed: 1 };
  };
  const store = new ExecutionStore(), parent = store.create("global", "全局任务", "high", "test", null);
  parent.status = "completed"; parent.handoff = { status: "started", childTurnId: "pending" }; store.save(parent);
  const running = h.service.sendMessage(h.id, "实例部署"); await entered.promise;
  // Simulate the already-persisted global handoff owner without another model.
  const active = (h.service as unknown as { activeRuns: Map<string, { execution: { parentTurnId: string | null } }> }).activeRuns.get(h.id)!;
  active.execution.parentTurnId = parent.id;
  assert.equal("accepted" in await h.service.compressContext(h.id), true);
  h.service.steer(h.id, "补充约束", "steer", undefined, "user"); release.resolve(); await running;
  const child = store.list(h.id)[0]!;
  assert.equal(child.workflowRun, undefined); assert.equal(child.parentTurnId, parent.id);
  assert.equal(store.list(h.id).length, 1);
  const notification = getSqlite().prepare("SELECT count(*) AS n FROM agent_inbox WHERE id=?").get(`handoff-result:${parent.id}`) as { n: number };
  assert.equal(notification.n, 1);
  assert.equal(store.get("global", parent.id).handoff!.childTurnId, child.id);
});

test("progress can be written without starting workflow scheduling", async (t) => {
  let phase = 0;
  const h = harness(async (input) => {
    if (phase++ === 0) return result([done("identify_modpack")]);
    assert.ok(!String(input.messages.filter((message) => message.role === "tool").at(-1)!.content).startsWith("TOOL_ERROR"));
    return result([], "仅做普通查询");
  }); t.after(h.dispose);
  await h.service.sendMessage(h.id, "查询当前配置");
  assert.equal(h.service.listExecutions(h.id).length, 1);
  assert.equal(h.service.listExecutions(h.id)[0]!.workflowRun, undefined);
  assert.ok(h.service.getPresentation(h.id).workflow);
});

test("parallel background receipt, early progress and final reply cannot cross the join; both branches share one turn", { timeout: 10000 }, async (t) => {
  const workflow = defaultDeploymentWorkflow();
  workflow.steps.splice(3, 0, { id: "custom_inspect", label: "独立检查", prompt: "检查其他文件", enabled: true, parallelGroup: "parallel_java" });
  workflow.steps[2]!.parallelGroup = "parallel_java";
  const java = deferred<{ path: string }>(), waiting = deferred<void>();
  let h: ReturnType<typeof harness>, turnId = "", phase = 0;
  h = harness(async (input) => {
    const turn = h.service.listExecutions(h.id)[0]!;
    if (turn.workflowRun!.roundIndex > 2) return result(); // Stop after demonstrating the join.
    turnId ||= turn.id;
    assert.equal(turn.id, turnId);
    if (phase++ === 0) return result([call("install_java_version", { version: "21", background: true, workflowStepId: "check_java_dependencies" }), done("custom_inspect"), done("check_java_dependencies")]);
    if (phase === 2) {
      assert.ok(!String(input.messages.filter((message) => message.role === "tool").at(-1)!.content).startsWith("TOOL_ERROR"));
      assert.equal(turn.workflowProgress!.steps.find((step) => step.id === "custom_inspect")!.status, "completed", "independent branch may complete before the other branch");
      waiting.resolve();
      return result([], "后台已提交，试图提前结束");
    }
    assert.ok(input.messages.some((message) => message.content?.includes("后台工具结果")));
    assert.equal(h.service.listExecutions(h.id).length, 1);
    return phase === 3 ? result([done("check_java_dependencies"), done("custom_inspect")]) : result();
  }, workflow, () => java.promise);
  t.after(h.dispose);
  // Seed a resumable turn at the parallel round to isolate its barrier.
  const store = new ExecutionStore();
  const seeded = store.create(h.id, "并行测试", "high", "test", null);
  seeded.status = "failed"; seeded.deploymentWorkflow = workflow;
  seeded.workflowRun = { id: seeded.id, roundIndex: 2, task: "并行测试" };
  seeded.checkpoint = { step: 0, messages: [{ role: "system", content: compileDeploymentWorkflow(workflow) }] };
  seeded.workflowProgress = buildSeedProgress(workflow, 2);
  store.save(seeded);
  const finished = terminal(h.id);
  const executing = h.service.resumeExecution(h.id, seeded.id);
  await Promise.race([waiting.promise, executing.then((response) => assert.fail(`Turn ended before joining: ${response}`))]);
  assert.equal(h.service.listExecutions(h.id).length, 1);
  assert.equal(h.service.getStatus(h.id), "running");
  java.resolve({ path: "/workspace/jdks/java-21/bin/java" });
  await executing;
  assert.equal((await finished).status, "completed");
  const turns = h.service.listExecutions(h.id).reverse();
  assert.equal(turns[0]!.status, "completed");
  assert.equal(turns[1]!.workflowRun!.roundIndex, 3);
  assert.ok(turns.length >= 2);
});

function buildSeedProgress(workflow: ReturnType<typeof defaultDeploymentWorkflow>, roundIndex: number) {
  return { title: "测试流程", currentStepId: deploymentRounds(workflow)[roundIndex]!.steps[0]!.id, status: "running" as const, overallProgress: 0,
    steps: workflow.steps.filter((step) => step.enabled).map((step) => ({ id: step.id, label: step.label, status: "pending" as const, progress: 0, detail: "" })) };
}

test("unfinished progress does not block a workflow successor", async (t) => {
  const h = harness(async () => result([], "并未执行任何节点")); t.after(h.dispose);
  const store = new ExecutionStore(), workflow = defaultDeploymentWorkflow();
  const turn = store.create(h.id, "未完成任务", "high", "test", null);
  turn.status = "failed"; turn.deploymentWorkflow = workflow; turn.workflowRun = { id: turn.id, roundIndex: 2, task: turn.input };
  turn.checkpoint = { step: 0, messages: [{ role: "system", content: "snapshot" }] };
  turn.workflowProgress = buildSeedProgress(workflow, 2); store.save(turn);
  const finished = terminal(h.id);
  await h.service.resumeExecution(h.id, turn.id);
  assert.equal((await finished).status, "completed");
  assert.ok(store.get(h.id, turn.id).workflowRun!.nextTurnId);
});

test("workflow does not reject future-stage tools or out-of-round progress", async (t) => {
  let phase = 0, installed = false;
  const h = harness(async (input) => {
    if (phase++ === 0) return result([
      call("install_java_version", { version: "21", workflowStepId: "check_java_dependencies" }),
      done("check_java_dependencies"),
      call("install_java_version", { version: "21", workflowStepId: "prepare_server_slot" })
    ]);
    const errors = input.messages.filter((message) => message.role === "tool").map((message) => message.content);
    assert.ok(errors.every((error) => !error?.startsWith("TOOL_ERROR")));
    return result();
  }, defaultDeploymentWorkflow(), async () => { installed = true; return { path: "java" }; });
  t.after(h.dispose);
  const store = new ExecutionStore(), turn = store.create(h.id, "不能跳轮", "high", "test", null);
  turn.status = "failed"; turn.deploymentWorkflow = defaultDeploymentWorkflow(); turn.workflowRun = { id: turn.id, roundIndex: 1, task: turn.input };
  turn.checkpoint = { step: 0, messages: [{ role: "system", content: "checkpoint" }] }; turn.workflowProgress = buildSeedProgress(turn.deploymentWorkflow, 1); store.save(turn);
  const finished = terminal(h.id);
  await h.service.resumeExecution(h.id, turn.id);
  await finished;
  assert.equal(installed, true);
  assert.ok(h.service.listToolJobs(h.id).length > 0);
});

test("workflow metadata is merged with a real operation and does not need a report-only call", async (t) => {
  let phase = 0;
  const h = harness(async (input) => {
    if (phase++ === 0) return result([call("begin_deployment_workflow")]);
    if (phase === 2) return result([call("get_current_server_config", {
      workflowStepId: "identify_modpack",
      workflowUpdates: [{ stepId: "identify_modpack", status: "running", detail: "正在读取已确认的整合包配置" }]
    })]);
    const progress = h.service.getPresentation(h.id).workflow!;
    assert.equal(progress.steps.find((step) => step.id === "identify_modpack")!.status, "running");
    assert.ok(input.messages.some((message) => message.role === "tool"));
    return result([], "配置已读取，后续步骤尚未完成");
  });
  t.after(h.dispose);
  await h.service.sendMessage(h.id, "检查部署配置");
  assert.equal(phase, 3);
  assert.equal(new ExecutionStore().calls(h.service.listExecutions(h.id)[0]!.id).filter((item) => item.name === "update_agent_workflow_progress").length, 0);
});

test("invalid merged metadata is rejected before a real tool executes", async (t) => {
  let phase = 0, installed = false;
  const h = harness(async (input) => {
    if (phase++ === 0) return result([call("begin_deployment_workflow")]);
    if (phase === 2) return result([call("install_java_version", { version: "21", workflowStepId: "not_enabled" })]);
    assert.ok(input.messages.some((message) => message.content?.startsWith("TOOL_ERROR") && message.content.includes("not_enabled")));
    return result([], "参数无效，未执行安装");
  }, defaultDeploymentWorkflow(), async () => { installed = true; return { path: "java" }; });
  t.after(h.dispose);
  await h.service.sendMessage(h.id, "安装依赖");
  assert.equal(installed, false);
});

test("background failure blocks node completion and late inbox cannot bypass the turn", async (t) => {
  let phase = 0;
  const h = harness(async () => phase++ === 0
    ? result([call("install_java_version", { workflowStepId: "check_java_dependencies", version: "21", background: true })])
    : phase === 2 ? result([done("check_java_dependencies")]) : result(), defaultDeploymentWorkflow(), async () => { throw new Error("download failed"); });
  t.after(h.dispose);
  const store = new ExecutionStore(), turn = store.create(h.id, "失败后台", "high", "test", null);
  turn.status = "failed"; turn.deploymentWorkflow = defaultDeploymentWorkflow(); turn.workflowRun = { id: turn.id, roundIndex: 2, task: turn.input };
  turn.checkpoint = { step: 0, messages: [{ role: "system", content: "frozen-policy" }] }; turn.workflowProgress = buildSeedProgress(turn.deploymentWorkflow, 2); store.save(turn);
  const finished = terminal(h.id);
  await h.service.resumeExecution(h.id, turn.id);
  assert.equal((await finished).status, "completed");
  assert.equal(h.service.listToolJobs(h.id)[0]!.status, "failed");
  assert.equal(store.get(h.id, turn.id).status, "completed");
  h.service.startInbox(); await Promise.resolve();
  assert.ok(h.service.listExecutions(h.id).length > 1);
});

test("synchronous diagnostic failure is returned to the model without poisoning the workflow join", async (t) => {
  let phase = 0;
  const h = harness(async () => {
    if (phase === 0) {
      phase++;
      return result([call("run_shell_command", { command: "exit 1", workflowStepId: "final_mcdr_test" })]);
    }
    if (phase === 1) {
      phase++;
      return result([done("final_mcdr_test")]);
    }
    return result([], "最终验证完成");
  }, defaultDeploymentWorkflow());
  t.after(h.dispose);
  const store = new ExecutionStore(), turn = store.create(h.id, "同步诊断失败", "high", "test", null);
  turn.status = "failed";
  turn.deploymentWorkflow = defaultDeploymentWorkflow();
  turn.workflowRun = { id: turn.id, roundIndex: 6, task: turn.input };
  turn.checkpoint = { step: 0, messages: [{ role: "system", content: "frozen-policy" }] };
  turn.workflowProgress = buildSeedProgress(turn.deploymentWorkflow, 6);
  store.save(turn);

  const finished = terminal(h.id);
  await h.service.resumeExecution(h.id, turn.id);
  const finishedEvent = await finished;
  assert.equal(finishedEvent.status, "completed", h.service.listExecutions(h.id)[0]?.error ?? "workflow did not complete");
  assert.equal(h.service.listToolJobs(h.id)[0]!.background, false);
  assert.equal(h.service.listToolJobs(h.id)[0]!.status, "failed");
  assert.equal(store.get(h.id, turn.id).workflowProgress!.steps.find((step) => step.id === "final_mcdr_test")!.status, "completed");
});

test("cancelling at a background join cancels the workflow without any successor", async (t) => {
  const started = deferred<void>(), waiting = deferred<void>();
  let phase = 0;
  const h = harness(async () => phase++ === 0
    ? result([call("install_java_version", { workflowStepId: "check_java_dependencies", version: "21", background: true })])
    : (waiting.resolve(), result()), defaultDeploymentWorkflow(), async () => { started.resolve(); return new Promise(() => undefined); });
  t.after(h.dispose);
  const store = new ExecutionStore(), turn = store.create(h.id, "取消等待", "high", "test", null);
  turn.status = "failed"; turn.deploymentWorkflow = defaultDeploymentWorkflow(); turn.workflowRun = { id: turn.id, roundIndex: 2, task: turn.input };
  turn.checkpoint = { step: 0, messages: [{ role: "system", content: "frozen-policy" }] }; turn.workflowProgress = buildSeedProgress(turn.deploymentWorkflow, 2); store.save(turn);
  const executing = h.service.resumeExecution(h.id, turn.id);
  await started.promise; await waiting.promise;
  h.service.cancel(h.id);
  assert.match(await executing, /已中断/);
  assert.equal(h.service.listExecutions(h.id).length, 1);
  assert.equal(store.get(h.id, turn.id).status, "cancelled");
});

test("durable unstarted successor starts once after restart and never duplicates an automatic turn", async (t) => {
  let calls = 0;
  const h = harness(async () => { calls++; return result(); }); t.after(h.dispose);
  const store = new ExecutionStore(), workflow = defaultDeploymentWorkflow();
  const parent = store.create(h.id, "重启推进", "high", "test", null); parent.status = "completed"; store.save(parent);
  const next = store.create(h.id, parent.input, "high", "test", null);
  next.status = "interrupted"; next.deploymentWorkflow = workflow; next.workflowRun = { id: parent.id, task: parent.input, roundIndex: 1, previousTurnId: parent.id, scheduled: true };
  next.workflowProgress = buildSeedProgress(workflow, 1); store.save(next);
  const finished = terminal(h.id);
  h.service.startInbox(); h.service.startInbox();
  assert.equal((await finished).status, "completed");
  assert.equal(calls, deploymentRounds(workflow).length - 1);
  assert.equal(h.service.listExecutions(h.id).length, deploymentRounds(workflow).length);
  assert.equal(store.get(h.id, next.id).workflowRun!.scheduled, false);
});

test("join waits for all jobs without polling and is cancellable; failed jobs are never successful joins", async () => {
  const runtime = new ToolRuntime(() => undefined), a = deferred<string>(), b = deferred<string>();
  const input = (id: string) => ({ scopeId: "join-test", turnId: "turn", stepId: "step", toolCallId: id, name: "run_shell_command", arguments: {}, background: true });
  await runtime.execute(input("a"), new AbortController().signal, () => a.promise);
  await runtime.execute(input("b"), new AbortController().signal, () => b.promise);
  let joined = false;
  const completion = runtime.join("join-test", "turn", new AbortController().signal).then(() => { joined = true; });
  a.resolve("one"); await Promise.resolve(); await Promise.resolve();
  assert.equal(joined, false);
  const controller = new AbortController();
  const aborted = runtime.join("join-test", "turn", controller.signal); controller.abort();
  await assert.rejects(aborted, /中断/);
  b.resolve("TOOL_ERROR failed"); await completion;
  assert.deepEqual(runtime.turnJobs("join-test", "turn").map((job) => job.status), ["completed", "failed"]);
});
