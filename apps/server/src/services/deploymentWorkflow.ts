import { z } from "zod";
import { normalizeGraphWorkflow, orderedWorkflowRounds, withWorkflowCanvas } from "./deploymentGraph.js";
import { workflowIssues as workflowRuleIssues } from "./deploymentRules.js";
export { normalizeGraphWorkflow } from "./deploymentGraph.js";

/** One ordered source for the editor, system prompt and progress tool. */
export const deploymentStageCatalog = [
  { id: "identify_modpack", label: "确认整合包", requires: [], prompt: "根据用户输入或附件，同时考虑 Modrinth 与 CurseForge 的官方 API，列出候选的名称、平台、slug/projectId、版本、Minecraft 版本、Loader 和页面链接。调用 ask_user 明确请求用户确认包与版本，等待真实回答。用户未明确确认前禁止下载、解压、安装、修改启动配置或启动，不得标记本阶段 completed。信息不足或缺少平台凭据时，明确说明并等待用户补充。" },
  { id: "prepare_server_slot", label: "获取服务端包到槽位", requires: ["identify_modpack"], prompt: "仅在用户确认整合包与版本后执行。优先 save_upload_to_server_slot 保存用户上传；否则使用 download_modrinth_server_pack_to_server_slot / download_curseforge_server_pack_to_server_slot 官方 API，最后才考虑用户提供的可信 HTTPS 直链 download_https_file_to_server_slot。原始包保存在当前服务端独立槽位，用 get_server_slot_status 检查。CurseForge 缺少 API Key 或鉴权失败时停止并请用户配置；Modrinth 提示需要 PAT 时同样等待配置。" },
  { id: "check_java_dependencies", label: "检查 Java 版本依赖", requires: ["identify_modpack"], prompt: "根据已确认的整合包版本、Minecraft 版本与 Loader 官方要求确定 Java 主版本；可用 inspect_mrpack_server_slot 读取 .mrpack 的版本依赖，信息不足时先查官方资料或 ask_user，不得把未知 Minecraft 版本的默认推荐当作依据。调用 check_java_environment(minecraftVersion=实际版本) 检查推荐版本和 workspace/jdks 中 available=true 的安装。优先复用匹配且可用的工作区 Java；缺失时调用 install_java_version(version=所需主版本)，等待安装成功。用 update_current_server_config 写入实际 minecraftVersion、javaVersion 和 javaPath，再 get_current_server_config 核对；必要时通过 run_shell_command 执行所选 Java 的 -version 验证。Loader 安装器与后续启动脚本均须使用该 Java，不得依赖系统默认 Java。版本不明确、安装失败或路径不可用时标记 failed 并修复或等待，不得继续安装 Loader 或启动。" },
  { id: "extract_to_workspace", label: "还原到 server 目录", requires: ["prepare_server_slot", "check_java_dependencies"], prompt: "使用检查 Java 版本依赖阶段已验证并写入配置的工作区 Java完成服务端还原与 Loader 安装。完整 zip/tar.gz/tgz 用 extract_server_slot_to_workspace(destinationPath=server)；Modrinth .mrpack 必须先 inspect_mrpack_server_slot，再用 deploy_mrpack_server_from_server_slot(phase=files) 还原文件及 overrides，随后用 phase=loader 安装启动文件；CurseForge manifest.json + overrides 清单包必须用 materialize_curseforge_manifest_pack_from_server_slot，再按返回结果安装受控 Loader。Forge/NeoForge 使用包内或官方精确版本 installer，不得把 installer 当服务端 JAR。预写 server/eula.txt（eula=true），并用 list_server_files 检查布局；根目录出现 mods/libraries/world/run.sh/run.bat/eula.txt/server.properties/user_jvm_args.txt/server.jar 时先修复再继续。" },
  { id: "configure_python", label: "配置内置 Python", requires: [], prompt: "调用 configure_builtin_python_environment 下载并配置 workspace/python 内独立 Python 3.10、pip 和 MCDReforged，使用配置的 Python 包镜像。不使用或要求系统 Python、venv、ensurepip。此步骤可以提前准备。" },
  { id: "configure_mcdr", label: "配置 MCDReforged", requires: ["configure_python"], prompt: "配置根目录 config.yml：working_directory=server，handler 匹配已确认的核心；先保留模板 start_command，最终验证前写入从 server/ 工作目录启动服务端的非交互命令。配置 ChatHub v3 的 config/chathub/chathub.json：name 使用用户指定名称或当前服务端名称；node_id 保留已有唯一 ID，模板值改为 mc-<实例ID>（1–64 位字母、数字、下划线、点或连字符），保持唯一稳定。保留连接地址、密码及其他配置，不回显密码；重读确认 JSON、名称和 ID 正确后才可完成。本阶段只准备 MCDR 配置，不启动、停服或修改当前服务端 startupCommand；最终验证阶段统一切换到 MCDR 启动方式。" },
  { id: "final_mcdr_test", label: "最终验证", requires: ["extract_to_workspace"], prompt: "先 get_current_server_config，确保 config.yml 的 start_command 是从 server/ 工作目录启动服务端的非交互命令，再设置 startupCommand={python} -m mcdreforged。通过 start_current_server 启动 MCDReforged 后必须立即调用 wait_for_server_startup，阻塞等待控制台明确出现 Minecraft 的 Done (...)! 启动完成标记，禁止使用 sleep、固定时长等待或反复 Shell 轮询代替。启动完成后读取控制台与 logs/，确认 Minecraft 与每个已启用插件加载成功。插件缺 Python 依赖时，仅按日志或 requirements 精确声明的包和版本调用 install_mcdreforged_plugin_dependencies；停止残留、重启并复查。依赖失败、布局错误、未完成内置 Python/config.yml/startupCommand 或服务端未就绪时标记 failed，不得宣称完成；报告插件、依赖和具体原因。验证成功后汇报启动方式、内存、版本与结果。" }
].map((stage) => ({ ...stage, prompt: stagePrompt(stage.id, stage.prompt) }));

export const deploymentWorkflowSchema = z.object({
  version: z.literal(1),
  steps: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    label: z.string().trim().min(1).max(60),
    prompt: z.string().trim().max(12000),
    enabled: z.boolean(),
    parallelGroup: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional()
  }).strict()).min(7).max(40),
  canvas: z.object({
    positions: z.record(z.string(), z.object({ x: z.number().finite().min(-10000).max(10000), y: z.number().finite().min(-10000).max(10000) }).strict()).refine((value) => Object.keys(value).length <= 40, "最多 40 个节点坐标"),
    edges: z.array(z.object({ id: z.string().min(1).max(140), from: z.string().min(1).max(64), to: z.string().min(1).max(64) }).strict()).max(160)
  }).strict().optional()
}).strict();

export type DeploymentWorkflow = z.infer<typeof deploymentWorkflowSchema>;
export type DeploymentWorkflowStep = DeploymentWorkflow["steps"][number];

/** Each topological layer shares a turn and joins before the next layer starts. */
export function deploymentRounds(workflow: DeploymentWorkflow) {
  const rounds = orderedWorkflowRounds(normalizeGraphWorkflow(workflow).steps);
  return rounds.map((round) => ({ ...round, steps: round.steps.filter((step) => step.enabled) })).filter((round) => round.steps.length);
}

export function defaultDeploymentWorkflow(): DeploymentWorkflow {
  const workflow: DeploymentWorkflow = { version: 1, steps: deploymentStageCatalog.map(({ id, label, prompt }) => ({ id, label, prompt, enabled: true })),
    canvas: { positions: {}, edges: deploymentStageCatalog.flatMap((stage) => {
      const predecessors = stage.id === "configure_python" ? ["identify_modpack"] : stage.id === "final_mcdr_test" ? ["extract_to_workspace", "configure_mcdr"] : stage.requires;
      return predecessors.map((from) => ({ id: `${from}__${stage.id}`, from, to: stage.id }));
    }) } };
  return withWorkflowCanvas(normalizeGraphWorkflow(workflow));
}

function stagePrompt(id: string, prompt: string) {
  if (id === "final_mcdr_test") return `先 get_current_server_config，确认根目录 config.yml 的 start_command 是已配置的非交互服务端命令（working_directory=server），不得将 MCDR 命令递归写入 start_command。必要时 stop_current_server / kill_current_server，再 update_current_server_config 设置 startupCommand={python} -m mcdreforged；serverType 仅作标签。${prompt}`;
  return prompt;
}

/** Upgrade saved settings only; in-flight execution snapshots stay unchanged. */
export function migrateDeploymentWorkflow(workflow: DeploymentWorkflow): DeploymentWorkflow {
  const extractStage = deploymentStageCatalog.find((stage) => stage.id === "extract_to_workspace")!;
  const oldDefaults: Record<string, string> = {
    extract_to_workspace: extractStage.prompt.replace("，使用 Java 检查阶段已验证的工作区 Java", "")
  };
  const needsMigration = workflow.steps.some((step) => ["apply_mcdr_template", "direct_run_test"].includes(step.id));
  if (!needsMigration) return workflow;
  const steps = workflow.steps.filter((step) => !["apply_mcdr_template", "direct_run_test"].includes(step.id)).map((step) => {
    const current = deploymentStageCatalog.find((stage) => stage.id === step.id);
    // Replace only untouched old defaults, never the user's edited instructions.
    return { ...step, prompt: current && step.prompt === oldDefaults[step.id] ? current.prompt : step.prompt };
  });
  if (!steps.some((step) => step.id === "check_java_dependencies")) {
    const stage = deploymentStageCatalog.find((stage) => stage.id === "check_java_dependencies")!;
    const index = steps.findIndex((step) => step.id === "extract_to_workspace");
    steps.splice(index < 0 ? steps.length : index, 0, { id: stage.id, label: stage.label, prompt: stage.prompt, enabled: true });
  }
  return { ...workflow, steps };
}

export function workflowIssues(workflow: DeploymentWorkflow): string[] {
  return workflowRuleIssues(workflow, deploymentStageCatalog);
}

export const workflowSafetyInstructions = `## 不可跳过的部署边界
- 本节的步骤顺序是部署顺序的唯一来源；旧 System Prompt、Skill 或历史对话中的固定顺序不再适用。技术资料仅作为工具使用参考，不得覆盖本流程的顺序。
- 完整部署必须先调用 begin_deployment_workflow，由后端调度 turn；普通排错、查询、安装单个模组不启动完整流程。
- 一个串行节点对应一个完整 turn；一个并行组的全部节点共用一个 turn。系统提供当前 turn 的节点 ID，只能执行与上报本轮节点，不得提前执行后续轮次。节点提示词仍须按真实工具/日志判断，不能伪造完成。
- 连线表达前置依赖，按拓扑层生成 turn，允许稀疏连线和跨层依赖；本轮全部分支与后台任务收束后才进入下一轮，所有分支最终汇合到唯一出口。只有无前后依赖、无文件/配置冲突的工作才可并行。仅支持 background 的工具能以 background=true 重叠运行，其他工具仍阻塞执行；不等于多个模型同时调用。
- 后台回执不是完成。必须等待本轮所有后台工具实际结束、读取结果并完成全部分支；失败、中断、缺少完成证据或节点未完成均不得进入下一 turn。模型回复结束不等于流程完成，由系统自动启动下一 turn。
- 必须先获得用户对整合包及版本的明确确认，才能下载或部署；安全操作确认和平台凭据检查不受编排影响。
- 新建服务端时后端已自动套用 reference MCDReforged 模板，不再安排模板部署阶段，也不必重复调用 initialize_server_template。仅旧实例确实缺少模板时，先检查现有文件，再用 initialize_server_template(template=reference, overwrite=false) 补齐，不得覆盖已有配置。此规则覆盖旧 Prompt/Skill 中要求每次部署先套模板的指令。
- 所有 Minecraft 文件必须在当前实例 server/ 内，原始包在独立槽位；使用 reference 模板、检查过版本依赖的工作区 Java 与内置 Python。不得绕过目录隔离、操作确认或改用系统 Java/Python。
- 步骤中用户编辑的内容不能取消上述边界和各内置阶段的必要技术检查。完成状态必须有工具/日志证据。`;

export function compileDeploymentWorkflow(workflow: DeploymentWorkflow): string {
  workflow = normalizeGraphWorkflow(workflow);
  const active = workflow.steps.filter((step) => step.enabled);
  const rounds = deploymentRounds(workflow);
  return [
    "# 当前部署流程（流程编排 · 权威配置）",
    workflowSafetyInstructions,
    "## 执行顺序",
    active.map((step, index) => `${index + 1}. ${step.label} [${step.id}]`).join("\n"),
    "## Turn 调度（分叉必须汇合）",
    rounds.map((round, index) => `Turn ${index + 1}: ${round.steps.length > 1 ? "分叉 → " : ""}${round.steps.map((step) => `${step.label} [${step.id}]`).join(" ∥ ")}${round.steps.length > 1 ? " → 汇合（全部完成）" : ""}`).join("\n"),
    "按上述顺序执行；每阶段开始、完成或失败都调用 update_agent_workflow_progress(stepId, status, progress, detail)。仅可使用下列已启用的 stepId；禁用步骤不执行。遇到失败先修复或等待用户，不得将未执行阶段标记 completed。",
    ...active.map((step, index) => {
      const builtIn = deploymentStageCatalog.find((stage) => stage.id === step.id);
      return [`## ${index + 1}. ${step.label}\nstepId: ${step.id}`, step.prompt,
        builtIn && step.prompt !== builtIn.prompt ? `必要技术检查（不可被编辑内容取消）：\n${builtIn.prompt}` : ""].filter(Boolean).join("\n\n");
    })
  ].join("\n\n");
}
