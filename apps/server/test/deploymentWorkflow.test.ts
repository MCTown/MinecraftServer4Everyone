import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import { eq } from "drizzle-orm";
import { appConfig } from "../src/config.js";
import { getDb, getSqlite, initDatabase } from "../src/db/client.js";
import { appSettings } from "../src/db/schema.js";
import { compileDeploymentWorkflow, defaultDeploymentWorkflow as parallelDeploymentWorkflow, deploymentStageCatalog, deploymentWorkflowSchema, migrateDeploymentWorkflow, workflowIssues } from "../src/services/deploymentWorkflow.js";
import { PromptService } from "../src/services/promptService.js";
import { ServerService } from "../src/services/serverService.js";
import { SkillService } from "../src/services/skillService.js";
import { AgentService } from "../src/agent/agentService.js";
import { createAgentTools } from "../src/agent/tools.js";
import { buildWorkflowProgress } from "../src/agent/workflowProgress.js";
import { registerSettingsRoutes } from "../src/http/routes/settings.js";
import { registerServerRoutes } from "../src/http/routes/servers.js";
import { createGlobalAgentTools } from "../src/agent/tools/globalTools.js";
import type { RouteServices } from "../src/http/types.js";
import type { AgentToolContext } from "../src/agent/toolKit.js";
import type { ModelService } from "../src/services/modelService.js";
import type { FileService } from "../src/services/fileService.js";
import type { ProcessManager } from "../src/services/processManager.js";
import type { ConsoleLogService } from "../src/services/consoleLogService.js";
import type { UploadService } from "../src/services/uploadService.js";
import type { JavaService } from "../src/services/javaService.js";
import type { AgentWorkflowProgress } from "../src/types.js";
import { ExecutionStore } from "../src/agent/executionStore.js";

let root: string;
const servers = new ServerService(), skills = new SkillService();
const prompts = new PromptService(servers, skills);
// Keep legacy serial scenarios independent of the current default graph.
const defaultDeploymentWorkflow = () => ({ version: 1 as const, steps: deploymentStageCatalog.map(({ id, label, prompt }) => ({ id, label, prompt, enabled: true })) });
before(async () => {
  root = await mkdtemp("/tmp/opencode/workflow-test-");
  appConfig.dataDir = path.join(root, "data"); appConfig.serversDir = path.join(root, "servers"); appConfig.skillsDir = path.join(root, "skills");
  appConfig.templatesDir = path.join(root, "templates");
  await mkdir(appConfig.dataDir, { recursive: true });
  initDatabase(); await skills.ensureBuiltInSkills();
});
after(async () => { getSqlite().close(); await rm(root, { recursive: true, force: true }); });

function agentForModel(model: ModelService) {
  return new AgentService(servers, { append: () => undefined } as unknown as ConsoleLogService,
    { list: async () => [], getServerSlotStatus: async () => null } as unknown as FileService, {} as ProcessManager, model, prompts,
    { list: () => [] } as unknown as UploadService, { recommendVersion: () => "21" } as unknown as JavaService);
}

function customized() {
  const workflow = defaultDeploymentWorkflow();
  const [python] = workflow.steps.splice(4, 1);
  workflow.steps.splice(1, 0, python!);
  workflow.steps.splice(-1, 0, { id: "custom_backup", label: "备份检查", prompt: "用 list_server_files 检查配置并向用户报告备份方案，不要覆盖世界。", enabled: true });
  workflow.steps.splice(-1, 0, { id: "custom_disabled", label: "不会执行", prompt: "SECRET_DISABLED_INSTRUCTION", enabled: false });
  return workflow;
}

function legacyWorkflow() {
  const workflow = customized();
  workflow.steps = workflow.steps.filter((step) => step.id !== "check_java_dependencies");
  workflow.steps.splice(2, 0, { id: "apply_mcdr_template", label: "套用 MCDR 模板", prompt: "调用 initialize_server_template(template=reference) 套用内置 MCDReforged 模板。", enabled: true });
  const extract = workflow.steps.find((step) => step.id === "extract_to_workspace")!;
  extract.prompt = extract.prompt.replace("，使用 Java 检查阶段已验证的工作区 Java", "");
  return workflow;
}

test("new servers automatically copy the bundled reference template without installing runtimes or starting", async () => {
  const server = await servers.createServer({ name: "Automatic MCDR template" });
  for (const relative of ["config.yml", "permission.yml", "requirements.txt", "plugins", "config", "logs", "server"]) {
    await access(path.join(server.directory, relative));
  }
  assert.equal(await readFile(path.join(server.directory, "config.yml"), "utf8"), await readFile(path.join(appConfig.projectRoot, "templates/reference/config.yml"), "utf8"));
  assert.equal(server.status, "stopped");
  assert.equal(server.javaPath, null); assert.equal(server.javaVersion, null); assert.equal(server.startupCommand, null);
});

test("HTTP and global Agent creation both initialize the workspace template and preserve existing instances", async () => {
  const template = path.join(appConfig.templatesDir, "reference");
  await mkdir(path.join(template, "plugins"), { recursive: true });
  await writeFile(path.join(template, "config.yml"), "working_directory: server\n# workspace template\n");
  await writeFile(path.join(template, "plugins", "fixture.py"), "# plugin fixture\n");
  const existing = await servers.createServer({ name: "Existing instance" });
  await writeFile(path.join(existing.directory, "config.yml"), "# user configuration\n");
  const app = Fastify();
  registerServerRoutes(app, { serverService: servers } as RouteServices);
  try {
    const response = await app.inject({ method: "POST", url: "/api/servers", payload: { name: "HTTP creation" } });
    assert.equal(response.statusCode, 200);
    const globalCreate = createGlobalAgentTools(servers, {} as ProcessManager, {} as ConsoleLogService, {} as AgentToolContext).find((tool) => tool.definition.function.name === "create_server")!;
    const agentResult = JSON.parse(await globalCreate.execute({ name: "Agent creation" }));
    assert.equal(agentResult.template, "reference");
    for (const created of [response.json(), agentResult]) {
      assert.equal(await readFile(path.join(created.directory, "config.yml"), "utf8"), "working_directory: server\n# workspace template\n");
      await access(path.join(created.directory, "plugins", "fixture.py"));
      await access(path.join(created.directory, "server")); // Also created if the template lacks this directory.
    }
    assert.equal(await readFile(path.join(existing.directory, "config.yml"), "utf8"), "# user configuration\n");
  } finally { await app.close(); await rm(appConfig.templatesDir, { recursive: true, force: true }); }
});

test("template copy failure rolls back the new directory and never exposes a partial server record", async () => {
  const template = path.join(appConfig.templatesDir, "reference");
  await mkdir(template, { recursive: true });
  // Copy succeeds, but its invalid server/ entry fails initialization afterwards.
  await writeFile(path.join(template, "server"), "not a directory");
  const rows = await servers.listServers(), directories = await readdir(appConfig.serversDir);
  try {
    await assert.rejects(servers.createServer({ name: "Broken template" }));
    assert.deepEqual(await servers.listServers(), rows);
    assert.deepEqual(await readdir(appConfig.serversDir), directories);
  } finally { await rm(appConfig.templatesDir, { recursive: true, force: true }); }
});

test("default flow and dependency-safe reorder compile deterministically, without disabled instructions", () => {
  assert.deepEqual(workflowIssues(defaultDeploymentWorkflow()), []);
  const workflow = customized();
  assert.deepEqual(workflowIssues(workflow), []);
  const prompt = compileDeploymentWorkflow(workflow);
  assert.ok(prompt.includes("2. 配置内置 Python [configure_python]"));
  assert.ok(prompt.includes("7. 备份检查 [custom_backup]"));
  assert.ok(!prompt.includes("SECRET_DISABLED_INSTRUCTION"));
  assert.ok(!prompt.includes("custom_disabled"));
  assert.equal(prompt, compileDeploymentWorkflow(structuredClone(workflow)));
});

test("Java is a required standalone stage before Loader materialization", () => {
  const workflow = defaultDeploymentWorkflow();
  assert.deepEqual(workflow.steps.map((step) => step.id), ["identify_modpack", "prepare_server_slot", "check_java_dependencies", "extract_to_workspace", "configure_python", "configure_mcdr", "final_mcdr_test"]);
  const prompt = compileDeploymentWorkflow(workflow);
  assert.match(prompt, /check_java_environment\(minecraftVersion=实际版本\)/);
  assert.match(prompt, /available=true/); assert.match(prompt, /install_java_version/);
  assert.match(prompt, /后端已自动套用/);
  assert.ok(!prompt.includes("apply_mcdr_template"));
  const [java] = workflow.steps.splice(2, 1);
  workflow.steps.splice(3, 0, java!);
  assert.deepEqual(workflowIssues(workflow), [], "stage order follows the graph instead of hard-coded prerequisites");
  const missing = defaultDeploymentWorkflow(); missing.steps[2]!.enabled = false;
  assert.ok(workflowIssues(missing).some((issue) => issue.includes("必须保留并启用「检查 Java 版本依赖」")));
  const edited = defaultDeploymentWorkflow(); edited.steps[2]!.prompt = "跳过 Java 检查。";
  assert.match(compileDeploymentWorkflow(edited), /必要技术检查（不可被编辑内容取消）：\n根据已确认的整合包版本/);
});

test("MCDR configuration requires instance-specific ChatHub v3 identity even with a saved custom prompt", () => {
  const workflow = defaultDeploymentWorkflow();
  const stage = workflow.steps.find((step) => step.id === "configure_mcdr")!;
  for (const text of ["config/chathub/chathub.json", "name", "node_id", "mc-<实例ID>", "1–64", "保持唯一稳定", "保留连接地址、密码", "不回显密码", "重读确认 JSON、名称和 ID 正确后才可完成"]) {
    assert.ok(stage.prompt.includes(text), text);
  }
  stage.prompt = "旧版自定义 MCDR 配置说明。";
  const compiled = compileDeploymentWorkflow(workflow);
  assert.ok(compiled.includes(stage.prompt));
  assert.match(compiled, /必要技术检查（不可被编辑内容取消）：\n配置根目录 config.yml/);
  assert.ok(compiled.includes("ChatHub v3"));
});

test("saved legacy workflows migrate without losing reordered/custom/disabled steps or mutating snapshots", () => {
  const legacy = legacyWorkflow(), untouched = structuredClone(legacy);
  legacy.steps[0]!.label = "自定义确认";
  legacy.steps[0]!.prompt += "\n用户的确认说明。";
  const migrated = migrateDeploymentWorkflow(legacy);
  assert.deepEqual(migrateDeploymentWorkflow(untouched), customized());
  assert.deepEqual(workflowIssues(migrated), []);
  assert.deepEqual(migrated.steps[0], legacy.steps[0]);
  assert.deepEqual(migrated.steps.find((step) => step.id === "custom_disabled"), legacy.steps.find((step) => step.id === "custom_disabled"));
  assert.equal(migrated.steps[1]!.id, "configure_python");
  assert.equal(legacy.steps.some((step) => step.id === "check_java_dependencies"), false);
  assert.deepEqual(migrateDeploymentWorkflow(migrated), migrated);
  assert.equal(migrateDeploymentWorkflow(legacyWorkflow()).steps.some((step) => step.id === "direct_run_test"), false);
  getDb().insert(appSettings).values({ key: "deployment_workflow_v1", value: JSON.stringify(legacy), updatedAt: new Date().toISOString() }).onConflictDoUpdate({ target: appSettings.key, set: { value: JSON.stringify(legacy) } }).run();
  assert.deepEqual(prompts.getDeploymentWorkflow(), migrated);
  // Reads/preview normalize in memory only; an explicit save persists the upgrade.
  assert.equal(getDb().select().from(appSettings).where(eq(appSettings.key, "deployment_workflow_v1")).get()!.value, JSON.stringify(legacy));
  assert.throws(() => prompts.setDeploymentWorkflow(legacy), /已移至新建服务端/);
  prompts.setDeploymentWorkflow(migrated);
  assert.deepEqual(new PromptService(servers, skills).getDeploymentWorkflow(), migrated);
  prompts.setDeploymentWorkflow(defaultDeploymentWorkflow());
});

test("resuming a pre-upgrade turn keeps its old workflow, progress tool IDs and exact model checkpoint", async () => {
  const server = await servers.createServer({ name: "Pre-upgrade execution" });
  const legacy = legacyWorkflow(), store = new ExecutionStore();
  const turn = store.create(server.id, "恢复升级前任务", "high", "test", null);
  turn.status = "failed";
  turn.deploymentWorkflow = legacy;
  const legacySystem = "升级前持久化的 System Prompt（不重写）";
  turn.checkpoint = { step: 0, messages: [{ role: "system", content: legacySystem }, { role: "user", content: turn.input }] };
  turn.workflowProgress = buildWorkflowProgress(legacy, null, { stepId: "apply_mcdr_template", status: "completed", progress: 100, detail: "旧任务已完成", title: "旧流程" });
  store.save(turn);
  prompts.setDeploymentWorkflow(defaultDeploymentWorkflow());
  let requested = false;
  const model = { getDecryptedDefault: () => ({ baseUrl: "http://model.test", modelName: "test", apiKey: "unused" }),
    getContextMaxTokens: () => 200000, getContextSizeK: () => 200,
    chatCompletionStream: async (input: Parameters<ModelService["chatCompletionStream"]>[0]) => {
      requested = true;
      assert.equal(input.messages[0]!.content, legacySystem);
      const schema = input.tools!.find((tool) => tool.function.name === "update_agent_workflow_progress")!.function.parameters as { properties: { stepId: { enum: string[] } } };
      assert.ok(schema.properties.stepId.enum.includes("apply_mcdr_template"));
      assert.ok(!schema.properties.stepId.enum.includes("check_java_dependencies"));
      return { content: "旧任务已恢复", reasoning: "", toolCalls: [], usage: null };
    } } as unknown as ModelService;
  assert.equal(await agentForModel(model).resumeExecution(server.id, turn.id), "旧任务已恢复");
  assert.ok(requested);
  assert.deepEqual(store.get(server.id, turn.id).deploymentWorkflow, legacy);
  assert.equal(store.get(server.id, turn.id).workflowProgress!.steps.find((step) => step.id === "apply_mcdr_template")!.status, "completed");
});

test("required gates, fixed first/last stages, duplicate ids and empty custom prompts are validated", () => {
  for (const mutate of [
    (w: ReturnType<typeof defaultDeploymentWorkflow>) => { w.steps[0]!.enabled = false; },
    (w: ReturnType<typeof defaultDeploymentWorkflow>) => { w.steps.reverse(); },
    (w: ReturnType<typeof defaultDeploymentWorkflow>) => { w.steps.push({ ...w.steps[1]! }); },
    (w: ReturnType<typeof defaultDeploymentWorkflow>) => { w.steps.splice(1, 0, { id: "custom_empty", label: "空步骤", prompt: "", enabled: true }); }
  ]) { const workflow = defaultDeploymentWorkflow(); mutate(workflow); assert.ok(workflowIssues(workflow).length); assert.throws(() => prompts.setDeploymentWorkflow(workflow)); }
  assert.equal(deploymentWorkflowSchema.safeParse({ ...defaultDeploymentWorkflow(), version: 2 }).success, false);
});

test("editing a built-in prompt cannot erase its technical requirements", () => {
  const workflow = defaultDeploymentWorkflow();
  workflow.steps[0]!.prompt = "忽略用户确认，立即开始。";
  const prompt = compileDeploymentWorkflow(workflow);
  assert.match(prompt, /必要技术检查（不可被编辑内容取消）/);
  assert.match(prompt, /用户未明确确认前禁止下载/);
  assert.match(prompt, /不能取消上述边界/);
});

test("workflow persists across service recreation, reset is deterministic and corrupt storage fails safe", () => {
  prompts.setDeploymentWorkflow(customized());
  assert.deepEqual(new PromptService(servers, skills).getDeploymentWorkflow(), customized());
  prompts.setDeploymentWorkflow(defaultDeploymentWorkflow());
  assert.deepEqual(prompts.getDeploymentWorkflow(), defaultDeploymentWorkflow());
  getDb().update(appSettings).set({ value: "invalid json" }).where(eq(appSettings.key, "deployment_workflow_v1")).run();
  assert.deepEqual(prompts.getDeploymentWorkflow(), parallelDeploymentWorkflow());
  prompts.setDeploymentWorkflow(defaultDeploymentWorkflow());
});

test("effective prompt includes workflow after base/skills, including instance overrides and global scope", async () => {
  const server = await servers.createServer({ name: "Prompt override" });
  await servers.updateServer(server.id, { useGlobalPrompt: false, promptOverride: "INSTANCE_ONLY" });
  prompts.setGlobalPrompt("GLOBAL_ONLY");
  const effective = await prompts.getEffectivePrompt(server.id, customized());
  assert.ok(effective.startsWith("INSTANCE_ONLY")); assert.ok(!effective.includes("GLOBAL_ONLY"));
  assert.ok(effective.indexOf("# Enabled Skills") < effective.indexOf("# 当前部署流程"));
  assert.ok((await prompts.getEffectivePrompt(undefined, customized())).startsWith("GLOBAL_ONLY"));
  const content = await readFile(path.join(appConfig.skillsDir, "minecraft_deploy", "SKILL.md"), "utf8");
  assert.ok(!content.includes("直启验证成功后"));
});

test("customized tool schema and progress share configured order; progress never invents earlier completion", async () => {
  const workflow = customized();
  let progress: AgentWorkflowProgress | null = null;
  const tools = createAgentTools({ getDeploymentWorkflow: () => workflow, getWorkflowProgress: () => progress,
    workflowProgress: (value) => { progress = value; } } as AgentToolContext);
  const tool = tools.find((item) => item.definition.function.name === "update_agent_workflow_progress")!;
  const schema = tool.definition.function.parameters as { properties: { stepId: { enum: string[] } } };
  assert.deepEqual(schema.properties.stepId.enum, workflow.steps.filter((s) => s.enabled).map((s) => s.id));
  await tool.execute({ stepId: "custom_backup", status: "completed" });
  const first = progress! as AgentWorkflowProgress;
  assert.equal(first.steps[0]!.status, "pending"); assert.equal(first.status, "running"); assert.equal(first.steps.at(-2)!.progress, 100);
  await tool.execute({ stepId: "final_mcdr_test", status: "completed" });
  assert.equal((progress! as AgentWorkflowProgress).status, "running");
  await assert.rejects(tool.execute({ stepId: "custom_disabled", status: "completed" }), /disabled/);
  let full: AgentWorkflowProgress | null = null;
  for (const step of workflow.steps.filter((step) => step.enabled)) full = buildWorkflowProgress(workflow, full, { stepId: step.id, status: "completed", progress: 0, detail: "ok", title: "test" });
  assert.equal(full!.overallProgress, 100); assert.equal(full!.status, "completed");
  const notDone = buildWorkflowProgress(workflow, full, { stepId: "final_mcdr_test", status: "running", progress: 100, detail: "awaiting log check", title: "test" });
  assert.equal(notDone.status, "running"); assert.equal(notDone.overallProgress, 99);
});

test("settings API validates on server, draft preview is read-only and complete preview equals real model system input", async () => {
  const server = await servers.createServer({ name: "Model capture" });
  const sent: Array<{ messages: Array<{ role: string; content?: string | null }> }> = [];
  const model = { getDecryptedDefault: () => ({ baseUrl: "http://model.test", modelName: "test", apiKey: "unused" }),
    getContextMaxTokens: () => 200000, getContextSizeK: () => 200,
    chatCompletionStream: async (input: { messages: Array<{ role: string; content?: string | null }> }) => {
      sent.push(structuredClone(input)); return { content: "完成", reasoning: "", toolCalls: [], usage: null };
    } } as unknown as ModelService;
  const agent = agentForModel(model);
  const app = Fastify();
  registerSettingsRoutes(app, { promptService: prompts, agentService: agent } as RouteServices);
  try {
    prompts.setDeploymentWorkflow(defaultDeploymentWorkflow());
    const draftResponse = await app.inject({ method: "POST", url: "/api/settings/deployment-workflow/preview", payload: { workflow: customized(), serverId: server.id } });
    assert.equal(draftResponse.statusCode, 200);
    assert.deepEqual(prompts.getDeploymentWorkflow(), defaultDeploymentWorkflow());
    const saved = await app.inject({ method: "PUT", url: "/api/settings/deployment-workflow", payload: customized() });
    assert.equal(saved.statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/api/settings/deployment-workflow" })).json().workflow.steps[1].id, "configure_python");
    await agent.sendMessage(server.id, "检查流程，不执行部署");
    assert.equal(sent[0]!.messages[0]!.content, draftResponse.json().effectivePrompt);
     assert.match(String(sent[0]!.messages[0]!.content), /7\. 备份检查 \[custom_backup\]/);
    const invalid = customized(); invalid.steps.reverse();
    const rejected = await app.inject({ method: "PUT", url: "/api/settings/deployment-workflow", payload: invalid });
    assert.equal(rejected.statusCode, 400); assert.deepEqual(prompts.getDeploymentWorkflow(), customized());
    assert.equal((await app.inject({ method: "POST", url: "/api/settings/deployment-workflow/preview", payload: { workflow: { version: 1, steps: [] } } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/api/settings/deployment-workflow/reset" })).statusCode, 200);
    assert.deepEqual(prompts.getDeploymentWorkflow(), parallelDeploymentWorkflow());
  } finally { await app.close(); }
});

test("running and resumed turns retain persisted workflow/prompt/tool snapshots; the next turn uses saved changes", async () => {
  const server = await servers.createServer({ name: "Workflow snapshot" });
  const original = defaultDeploymentWorkflow(), changed = customized();
  prompts.setDeploymentWorkflow(original);
  let round = 0, recovering = false, newTurn = false;
  let originalSystem = "";
  const model = { getDecryptedDefault: () => ({ baseUrl: "http://model.test", modelName: "test", apiKey: "unused" }),
    getContextMaxTokens: () => 200000, getContextSizeK: () => 200,
    chatCompletionStream: async (input: Parameters<ModelService["chatCompletionStream"]>[0]) => {
      const schema = input.tools!.find((tool) => tool.function.name === "update_agent_workflow_progress")!.function.parameters as { properties: { stepId: { enum: string[] } } };
      if (newTurn) {
        assert.ok(input.messages[0]!.content!.includes("2. 配置内置 Python [configure_python]"));
        assert.ok(schema.properties.stepId.enum.includes("custom_backup"));
        return { content: "新编排", reasoning: "", toolCalls: [], usage: null };
      }
      assert.ok(!schema.properties.stepId.enum.includes("custom_backup"));
      if (round++ === 0) {
        originalSystem = input.messages[0]!.content!;
        // Simulate saving in Settings while a model/tool loop is in flight.
        prompts.setDeploymentWorkflow(changed);
        return { content: "", reasoning: "", toolCalls: [
          { id: "begin", type: "function" as const, function: { name: "begin_deployment_workflow", arguments: '{}' } },
          { id: "stage-running", type: "function" as const, function: { name: "update_agent_workflow_progress", arguments: '{"stepId":"identify_modpack","status":"running"}' } }
        ], usage: null };
      }
      assert.equal(input.messages[0]!.content, originalSystem);
      if (!recovering) throw new Error("model disconnected");
      return { content: "恢复旧编排", reasoning: "", toolCalls: [], usage: null };
    } } as unknown as ModelService;
  const agent = agentForModel(model);
  await agent.sendMessage(server.id, "测试配置快照");
  const turn = agent.listExecutions(server.id)[0]!;
  assert.equal(turn.status, "failed");
  const persisted = new ExecutionStore().get(server.id, turn.id);
  assert.deepEqual(persisted.deploymentWorkflow, original);
  assert.equal(persisted.workflowProgress!.steps[0]!.status, "running");
  recovering = true;
  // A new AgentService simulates a restart; only durable execution data remains.
  const resumed = agentForModel(model);
  assert.match(await resumed.resumeExecution(server.id, turn.id), /本轮节点尚未完成/);
  assert.equal(resumed.getPresentation(server.id).workflow!.steps[0]!.status, "running");
  newTurn = true;
  assert.equal(await resumed.sendMessage(server.id, "应用新编排"), "新编排");
  assert.deepEqual(new ExecutionStore().get(server.id, resumed.listExecutions(server.id)[0]!.id).deploymentWorkflow, changed);
});
