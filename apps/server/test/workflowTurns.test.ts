import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { AgentService } from "../src/agent/agentService.js";
import { ExecutionStore } from "../src/agent/executionStore.js";
import { ToolRuntime } from "../src/agent/toolRuntime.js";
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

function harness(stream: ModelService["chatCompletionStream"], workflow = defaultDeploymentWorkflow(), install = async () => ({ path: "/workspace/jdks/java-21/bin/java" })) {
  const id = crypto.randomUUID();
  const model = { getDecryptedDefault: () => ({ baseUrl: "http://model.test", modelName: "test", apiKey: "unused" }), getContextMaxTokens: () => 200000, getContextSizeK: () => 200, chatCompletionStream: stream } as unknown as ModelService;
  const server = { id, name: "Test", directory: root, status: "stopped", minMemory: "2G", maxMemory: "2G" };
  const service = new AgentService(
    { requireServer: async () => server, updateServer: async () => server } as never,
    { append: () => undefined } as never,
    { list: async () => [], getServerSlotStatus: async () => null } as never, {} as never, model,
    { getEffectivePrompt: async () => compileDeploymentWorkflow(workflow), getDeploymentWorkflow: () => structuredClone(workflow), getAgentSettings: () => ({ memory: "2G" }), getAgentAutoConfirm: () => true,
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
  const [python] = workflow.steps.splice(4, 1);
  workflow.steps.splice(3, 0, python!);
  workflow.steps[2]!.parallelGroup = workflow.steps[3]!.parallelGroup = "parallel_dependencies";
  assert.deepEqual(workflowIssues(workflow), []);
  assert.equal(deploymentRounds(workflow).length, 6);
  assert.match(compileDeploymentWorkflow(workflow), /Turn 3: 分叉 → 检查 Java 版本依赖 \[check_java_dependencies\] ∥ 配置内置 Python \[configure_python\] → 汇合/);
  const dependent = structuredClone(workflow); dependent.steps[3]!.parallelGroup = dependent.steps[4]!.parallelGroup = "parallel_dependencies";
  assert.deepEqual(workflowIssues(dependent), [], "stage order no longer blocks a wider parallel group");
  const disjoint = structuredClone(workflow); disjoint.steps[5]!.parallelGroup = "parallel_dependencies";
  assert.ok(workflowIssues(disjoint).some((issue) => issue.includes("必须连续且收束")));
  const gate = structuredClone(workflow); gate.steps[0]!.parallelGroup = gate.steps[1]!.parallelGroup = "parallel_confirm";
  assert.ok(workflowIssues(gate).some((issue) => issue.includes("独占一个 turn")));
});

test("each serial node gets its own durable turn, auto-advances once and preserves one stable system/tools prefix", async (t) => {
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
  await h.service.sendMessage(h.id, "部署整合包 A");
  assert.equal((await finished).status, "completed", h.service.listExecutions(h.id)[0]?.error ?? "workflow failed");
  const turns = h.service.listExecutions(h.id).reverse();
  assert.equal(turns.length, 7);
  assert.deepEqual(turns.map((turn) => turn.workflowRun!.roundIndex), [0, 1, 2, 3, 4, 5, 6]);
  assert.ok(turns.every((turn) => turn.status === "completed"));
  assert.equal(new Set(turns.map((turn) => turn.workflowRun!.id)).size, 1);
  for (let index = 1; index < turns.length; index++) {
    assert.equal(turns[index]!.workflowRun!.previousTurnId, turns[index - 1]!.id);
    assert.equal(turns[index - 1]!.workflowRun!.nextTurnId, turns[index]!.id);
  }
  assert.equal(new Set(headers).size, 1);
  assert.equal(h.service.listMessages(h.id).filter((message) => message.role === "user" && message.content === "部署整合包 A").length, 1);
  assert.equal(h.events.filter((event) => event.type === "done").length, 1);
  assert.equal(h.events.filter((event) => event.type === "status" && event.status === "completed").length, 1, "no public completed status between turns");
});

test("default sparse graph executes all seven stages in four durable turns", async (t) => {
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
  await h.service.sendMessage(h.id, "部署整合包 A");
  assert.equal((await finished).status, "completed", h.service.listExecutions(h.id)[0]?.error ?? undefined);
  const turns = h.service.listExecutions(h.id).reverse();
  assert.deepEqual(turns.map((turn) => turn.workflowRun!.roundIndex), [0, 1, 2, 3]);
  assert.ok(turns.every((turn) => turn.status === "completed"));
  assert.ok(turns.at(-1)!.workflowProgress!.steps.every((step) => step.status === "completed"));
});

test("new turns cannot bypass scheduling by writing progress directly", async (t) => {
  let phase = 0;
  const h = harness(async (input) => {
    if (phase++ === 0) return result([done("identify_modpack")]);
    assert.match(String(input.messages.filter((message) => message.role === "tool").at(-1)!.content), /必须先调用 begin_deployment_workflow/);
    return result([], "仅做普通查询");
  }); t.after(h.dispose);
  await h.service.sendMessage(h.id, "查询当前配置");
  assert.equal(h.service.listExecutions(h.id).length, 1);
  assert.equal(h.service.listExecutions(h.id)[0]!.workflowRun, undefined);
  assert.equal(h.service.getPresentation(h.id).workflow, null);
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
      assert.match(String(input.messages.filter((message) => message.role === "tool").at(-1)!.content), /Turn 尚未收束/);
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
  assert.equal((await finished).status, "failed"); // Next incomplete round cannot be skipped.
  const turns = h.service.listExecutions(h.id).reverse();
  assert.equal(turns[0]!.status, "completed");
  assert.equal(turns[1]!.workflowRun!.roundIndex, 3);
  assert.equal(turns.length, 2);
});

function buildSeedProgress(workflow: ReturnType<typeof defaultDeploymentWorkflow>, roundIndex: number) {
  return { title: "测试流程", currentStepId: deploymentRounds(workflow)[roundIndex]!.steps[0]!.id, status: "running" as const, overallProgress: 0,
    steps: workflow.steps.filter((step) => step.enabled).map((step) => ({ id: step.id, label: step.label, status: "pending" as const, progress: 0, detail: "" })) };
}

test("failed/unfinished turn is durable, resumes the same turn and never launches a successor on an early reply", async (t) => {
  const h = harness(async () => result([], "并未执行任何节点")); t.after(h.dispose);
  const store = new ExecutionStore(), workflow = defaultDeploymentWorkflow();
  const turn = store.create(h.id, "未完成任务", "high", "test", null);
  turn.status = "failed"; turn.deploymentWorkflow = workflow; turn.workflowRun = { id: turn.id, roundIndex: 2, task: turn.input };
  turn.checkpoint = { step: 0, messages: [{ role: "system", content: "snapshot" }] };
  turn.workflowProgress = buildSeedProgress(workflow, 2); store.save(turn);
  assert.match(await h.service.resumeExecution(h.id, turn.id), /本轮节点尚未完成/);
  assert.equal(h.service.listExecutions(h.id).length, 1);
  assert.equal(h.service.listExecutions(h.id)[0]!.resumable, true);
  assert.equal(store.get(h.id, turn.id).workflowRun!.nextTurnId, undefined);
});

test("tool gate rejects future-stage execution and out-of-round progress before side effects", async (t) => {
  let phase = 0, installed = false;
  const h = harness(async (input) => {
    if (phase++ === 0) return result([
      call("install_java_version", { version: "21", workflowStepId: "check_java_dependencies" }),
      done("check_java_dependencies"),
      call("install_java_version", { version: "21", workflowStepId: "prepare_server_slot" })
    ]);
    const errors = input.messages.filter((message) => message.role === "tool").map((message) => message.content);
    assert.ok(errors.every((error) => error?.startsWith("TOOL_ERROR")));
    assert.ok(errors.every((error) => error?.includes("Turn 门禁")));
    return result();
  }, defaultDeploymentWorkflow(), async () => { installed = true; return { path: "java" }; });
  t.after(h.dispose);
  const store = new ExecutionStore(), turn = store.create(h.id, "不能跳轮", "high", "test", null);
  turn.status = "failed"; turn.deploymentWorkflow = defaultDeploymentWorkflow(); turn.workflowRun = { id: turn.id, roundIndex: 1, task: turn.input };
  turn.checkpoint = { step: 0, messages: [{ role: "system", content: "checkpoint" }] }; turn.workflowProgress = buildSeedProgress(turn.deploymentWorkflow, 1); store.save(turn);
  await h.service.resumeExecution(h.id, turn.id);
  assert.equal(installed, false);
  assert.equal(h.service.listExecutions(h.id).length, 1);
  assert.equal(h.service.listToolJobs(h.id).length, 0, "rejected calls must not poison the round's job barrier");
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
  assert.match(await h.service.resumeExecution(h.id, turn.id), /失败或中断/);
  assert.equal(h.service.listExecutions(h.id).length, 1);
  assert.equal(h.service.listToolJobs(h.id)[0]!.status, "failed");
  assert.equal(store.get(h.id, turn.id).status, "failed");
  assert.equal(store.get(h.id, turn.id).workflowProgress!.steps.find((step) => step.id === "check_java_dependencies")!.status, "failed");
  h.service.startInbox(); await Promise.resolve();
  assert.equal(h.service.listExecutions(h.id).length, 1, "late inbox must not start an unrelated synthetic turn");
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
  assert.equal((await finished).status, "failed");
  assert.equal(calls, 1);
  assert.equal(h.service.listExecutions(h.id).length, 2);
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
