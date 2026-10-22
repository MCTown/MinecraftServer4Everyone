import { z } from "zod";
import { normalizeGraphWorkflow, orderedWorkflowRounds, withWorkflowCanvas, workflowGraphEdges } from "./deploymentGraph.js";
import { workflowIssues as workflowRuleIssues } from "./deploymentRules.js";
export { normalizeGraphWorkflow } from "./deploymentGraph.js";

/** One ordered source for the editor, system prompt and progress tool. */
export const deploymentStageCatalog = [
  { id: "identify_modpack", label: "确认整合包", requires: [], prompt: "优先检查用户指定的包、槽位和 README，确定包版本、Minecraft 与 Loader。用户已明确确认的本地包不搜索其他候选、不重复询问。只有来源或版本不明确时查询 Modrinth/CurseForge 官方 API，并用 ask_user 确认；非交互模式无法确定时报告缺少的信息。" },
  { id: "prepare_server_slot", label: "获取服务端包到槽位", requires: ["identify_modpack"], prompt: "仅在用户确认整合包与版本后执行。优先 save_upload_to_server_slot 保存用户上传；否则使用 download_modrinth_server_pack_to_server_slot / download_curseforge_server_pack_to_server_slot 官方 API，最后才考虑用户提供的可信 HTTPS 直链 download_https_file_to_server_slot。原始包保存在当前服务端独立槽位，用 get_server_slot_status 检查。CurseForge 缺少 API Key 或鉴权失败时停止并请用户配置；Modrinth 提示需要 PAT 时同样等待配置。" },
  { id: "check_java_dependencies", label: "检查 Java 版本依赖", requires: ["identify_modpack"], prompt: "根据已确认的整合包版本、Minecraft 版本与 Loader 官方要求确定 Java 主版本；可用 inspect_mrpack_server_slot 读取 .mrpack 的版本依赖，信息不足时先查官方资料或 ask_user，不得把未知 Minecraft 版本的默认推荐当作依据。调用 check_java_environment(minecraftVersion=实际版本) 检查推荐版本和 workspace/jdks 中 available=true 的安装。优先复用匹配且可用的工作区 Java；缺失时调用 install_java_version(version=所需主版本)，等待安装成功。用 update_current_server_config 写入实际 minecraftVersion、javaVersion 和 javaPath，再 get_current_server_config 核对；必要时通过 run_shell_command 执行所选 Java 的 -version 验证。Loader 安装器与后续启动脚本均须使用该 Java，不得依赖系统默认 Java。版本不明确、安装失败或路径不可用时标记 failed 并修复或等待，不得继续安装 Loader 或启动。" },
  { id: "extract_to_workspace", label: "还原到 server 目录", requires: ["prepare_server_slot"], prompt: "本节点只还原文件，不安装 Loader。完整 zip/tar.gz/tgz 用 extract_server_slot_to_workspace(destinationPath=server)；.mrpack 先 inspect_mrpack_server_slot，再 deploy_mrpack_server_from_server_slot(phase=files)；CurseForge manifest 清单用 materialize_curseforge_manifest_pack_from_server_slot。核对 server/ 布局、包内安装器与启动脚本；缺失的 Loader 留给 install_modloader。" },
  { id: "install_modloader", label: "安装 ModLoader", requires: ["extract_to_workspace", "check_java_dependencies"], prompt: "使用已验证的工作区 Java。已有完整且版本匹配的启动文件则核验后复用；否则安装包指定版本的 Loader。Forge/NeoForge 启用对应 setup 能力，优先包内 installer，缺失时从官方 Maven 下载到 server/，调用 setup_forge_server/setup_neoforge_server(background=true)。.mrpack 调用 deploy_mrpack_server_from_server_slot(phase=loader, javaPath=已验证路径, background=true)。其他 Loader 使用现有受控能力或包内安装脚本。后台安装期间继续无文件冲突的 MCDR 配置；实际结果成功并核对启动文件后才上报完成。installer 不是服务端 JAR；安装文件始终在 server/ 内。" },
  { id: "configure_python", label: "配置内置 Python", requires: [], prompt: "调用 configure_builtin_python_environment 下载并配置 workspace/python 内独立 Python 3.10、pip 和 MCDReforged，使用配置的 Python 包镜像。不使用或要求系统 Python、venv、ensurepip。此步骤可以提前准备。" },
  { id: "configure_mcdr", label: "配置 MCDReforged", requires: ["configure_python"], prompt: "修改根目录 config.yml：working_directory=server，Forge/NeoForge 使用 forge_handler，start_command 从 server/ 执行包内可用脚本或已验证的非交互 Java 命令，不写 MCDR 命令。ChatHub v3 的 config/chathub/chathub.json：name 用指定名称，node_id 保留已有唯一值，模板值改为 mc-<实例ID>（1–64 位字母、数字、下划线、点或连字符）；保留地址、密码及其他配置，不回显密码。用 YAML/JSON 解析器一次核对必要字段即可，不探索 MCDR 内部 Python API、不猜模块或方法；启动和插件验证留给最终阶段。" },
  { id: "final_mcdr_test", label: "最终验证", requires: ["extract_to_workspace"], prompt: "先 get_current_server_config，确保 config.yml 的 start_command 是从 server/ 工作目录启动服务端的非交互命令，再设置 startupCommand={python} -m mcdreforged。start_current_server 后立即 wait_for_server_startup 等待 Done，不用 sleep 或 Shell 轮询。随后 inspect_current_server_validation 一次汇总本次启动证据；已通过项不重复检查，只补查 unknown 或实际功能受影响项。MCDR 插件一般不会影响游戏运行；日志报错不等于服务器未正常运行，大型整合包报错很正常，不能仅因 ERROR/FATAL 就禁用模组、停服或重启。独立报告游戏就绪、插件加载与日志告警；命令验证使用 send_current_server_command(command=list) 的默认响应等待，不 sleep 后 grep。明确缺 Python 依赖时仅按日志/requirements 精确约束调用 install_mcdreforged_plugin_dependencies；修复前说明影响，必要重启走正常停服等待。游戏未就绪或部署必要配置未完成不得宣称成功；插件未通过/unknown 要明确报告，不能宣称所有插件功能正常。汇报启动方式、内存、版本及未解决项。" }
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

/** Topological layers describe dependencies/parallelism, not execution boundaries. */
export function deploymentRounds(workflow: DeploymentWorkflow) {
  const rounds = orderedWorkflowRounds(normalizeGraphWorkflow(workflow).steps);
  return rounds.map((round) => ({ ...round, steps: round.steps.filter((step) => step.enabled) })).filter((round) => round.steps.length);
}

export function defaultDeploymentWorkflow(): DeploymentWorkflow {
  const workflow: DeploymentWorkflow = { version: 1, steps: deploymentStageCatalog.map(({ id, label, prompt }) => ({ id, label, prompt, enabled: true })),
    canvas: { positions: {}, edges: deploymentStageCatalog.flatMap((stage) => {
      const predecessors = stage.id === "configure_python" ? ["identify_modpack"]
        : stage.id === "configure_mcdr" ? ["extract_to_workspace", "configure_python"]
        : stage.id === "final_mcdr_test" ? ["install_modloader", "configure_mcdr"] : stage.requires;
      return predecessors.map((from) => ({ id: `${from}__${stage.id}`, from, to: stage.id }));
    }) } };
  return withWorkflowCanvas(normalizeGraphWorkflow(workflow));
}

function stagePrompt(id: string, prompt: string) {
  if (id === "configure_mcdr") return `${prompt} 与 Loader 安装并行时只修改根目录 config.yml 和 config/chathub，不改写 server/ 文件或当前服务端配置；启动命令若依赖尚未生成的文件，留待最终验证读取安装结果后补齐。`;
  if (id === "final_mcdr_test") return `不得将 MCDR 命令递归写入 config.yml 的 start_command；serverType 仅作标签。${prompt}`;
  return prompt;
}

/** Upgrade saved settings only; in-flight execution snapshots stay unchanged. */
export function migrateDeploymentWorkflow(workflow: DeploymentWorkflow): DeploymentWorkflow {
  const previousFinalDefault = stagePrompt("final_mcdr_test", "先 get_current_server_config，确保 config.yml 的 start_command 是从 server/ 工作目录启动服务端的非交互命令，再设置 startupCommand={python} -m mcdreforged。通过 start_current_server 启动 MCDReforged 后必须立即调用 wait_for_server_startup，阻塞等待控制台明确出现 Minecraft 的 Done (...)! 启动完成标记，禁止使用 sleep、固定时长等待或反复 Shell 轮询代替。启动完成后读取控制台与 logs/，确认 Minecraft 与每个已启用插件加载成功。插件缺 Python 依赖时，仅按日志或 requirements 精确声明的包和版本调用 install_mcdreforged_plugin_dependencies；停止残留、重启并复查。依赖失败、布局错误、未完成内置 Python/config.yml/startupCommand 或服务端未就绪时标记 failed，不得宣称完成；报告插件、依赖和具体原因。验证成功后汇报启动方式、内存、版本与结果。");
  if (workflow.steps.some((step) => step.id === "final_mcdr_test" && step.prompt === previousFinalDefault)) {
    workflow = { ...workflow, steps: workflow.steps.map((step) => step.id === "final_mcdr_test" && step.prompt === previousFinalDefault
      ? { ...step, prompt: deploymentStageCatalog.find((item) => item.id === "final_mcdr_test")!.prompt } : step) };
  }
  if (!workflow.steps.some((step) => step.id === "install_modloader")) {
    const stage = deploymentStageCatalog.find((step) => step.id === "install_modloader")!;
    const steps = workflow.steps.map((step) => ({ ...step,
      // Only replace the known built-in wording; custom instructions survive.
      ...(step.id === "extract_to_workspace" && step.prompt.startsWith("使用检查 Java 版本依赖阶段已验证并写入配置的工作区 Java完成服务端还原与 Loader 安装。")
        ? { prompt: deploymentStageCatalog.find((item) => item.id === "extract_to_workspace")!.prompt } : {})
    }));
    const index = steps.findIndex((step) => step.id === "extract_to_workspace");
    steps.splice(index < 0 ? steps.length - 1 : index + 1, 0, { id: stage.id, label: stage.label, prompt: stage.prompt, enabled: true });
    const edges = [...(workflow.canvas?.edges ?? workflowGraphEdges(workflow.steps))];
    const add = (from: string, to: string) => {
      if (steps.some((step) => step.id === from) && steps.some((step) => step.id === to) && !edges.some((edge) => edge.from === from && edge.to === to)) edges.push({ id: `${from}__${to}`, from, to });
    };
    add("extract_to_workspace", "install_modloader");
    add("check_java_dependencies", "install_modloader");
    add("install_modloader", "final_mcdr_test");
    // Preserve custom topology; default graphs put MCDR beside extraction,
    // so delay its configuration until files are ready, alongside the installer.
    const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
      if (from === to) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return edges.filter((edge) => edge.from === from).some((edge) => reaches(edge.to, to, seen));
    };
    if (!reaches("configure_mcdr", "extract_to_workspace")) add("extract_to_workspace", "configure_mcdr");
    return migrateDeploymentWorkflow(normalizeGraphWorkflow({ ...workflow, steps, canvas: { positions: { ...workflow.canvas?.positions }, edges } }));
  }
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

const legacyWorkflowSafetyInstructions = `## 不可跳过的部署边界
- 本节的步骤顺序是部署顺序的唯一来源；旧 System Prompt、Skill 或历史对话中的固定顺序不再适用。技术资料仅作为工具使用参考，不得覆盖本流程的顺序。
- 完整部署必须先调用 begin_deployment_workflow，由后端调度 turn；普通排错、查询、安装单个模组不启动完整流程。
- 串行节点各一个 turn，并行组共用一个 turn，由系统推进。仅无依赖与文件冲突的工作可并行；background=true 的回执不是完成，须读取实际结果。
- 必须先获得用户对整合包及版本的明确确认，才能下载或部署；安全操作确认和平台凭据检查不受编排影响。
- 新实例已套用 reference 模板，不重复初始化；旧实例缺失时以 overwrite=false 补齐，保留已有配置。
- 所有 Minecraft 文件必须在当前实例 server/ 内，原始包在独立槽位；使用 reference 模板、检查过版本依赖的工作区 Java 与内置 Python。不得绕过目录隔离、操作确认或改用系统 Java/Python。
- 重启先 stop_current_server，再 wait_for_server_stopped，确认退出后才 start_current_server；不用 sleep、进程轮询或抢跑启动。停服等待超时或发现残留时先诊断，不默认强杀；kill_current_server 仍需高风险确认。
- 最终验收优先 inspect_current_server_validation 汇总证据，命令响应使用 send_current_server_command 的事件等待。MCDR 插件一般不会影响游戏运行；大型整合包日志报错很正常，ERROR/FATAL 不等于启动失败，不自动禁模组或重启。游戏、插件、告警分开报告；unknown 不冒充通过，不重复已通过项。
- 步骤中用户编辑的内容不能取消上述边界和各内置阶段的必要技术检查。完成状态必须有工具/日志证据。`;

export const workflowSafetyInstructions = `## 不可跳过的部署边界
- 本节的步骤顺序是部署顺序的唯一来源；旧 System Prompt、Skill 或历史对话中的固定顺序与分轮要求不再适用。技术资料仅作为工具使用参考，不得覆盖本流程的顺序。
- 完整部署先调用 begin_deployment_workflow 初始化流程，在同一次执行内按步骤依赖完成全部阶段；普通排错、查询、安装单个模组不启动完整流程。
- 阶段完成后直接继续依赖满足的步骤，不结束任务等待系统推进，不生成逐阶段总结；只在最终统一报告结果与未解决项，必要的风险说明、诊断与用户确认仍须保留。仅无依赖与文件冲突的工作可并行；background=true 的回执不是完成，依赖结果必须等待真实结束。
- 必须先获得用户对整合包及版本的明确确认，才能下载或部署；安全操作确认和平台凭据检查不受编排影响。
- 新实例已套用 reference 模板，不重复初始化；旧实例缺失时以 overwrite=false 补齐，保留已有配置。
- 所有 Minecraft 文件必须在当前实例 server/ 内，原始包在独立槽位；使用 reference 模板、检查过版本依赖的工作区 Java 与内置 Python。不得绕过目录隔离、操作确认或改用系统 Java/Python。
- 重启先 stop_current_server，再 wait_for_server_stopped，确认退出后才 start_current_server；不用 sleep、进程轮询或抢跑启动。停服等待超时或发现残留时先诊断，不默认强杀；kill_current_server 仍需高风险确认。
- 最终验收优先 inspect_current_server_validation 汇总证据，命令响应使用 send_current_server_command 的事件等待。MCDR 插件一般不会影响游戏运行；大型整合包日志报错很正常，ERROR/FATAL 不等于启动失败，不自动禁模组或重启。游戏、插件、告警分开报告；unknown 不冒充通过，不重复已通过项。
- 步骤中用户编辑的内容不能取消上述边界和各内置阶段的必要技术检查。进度仅供展示，完成状态必须有工具/日志证据；必要工作或验证未完成时明确说明，不把执行结束当作部署成功。`;

export function compileDeploymentWorkflow(workflow: DeploymentWorkflow, mode: "continuous" | "rounds" = "continuous"): string {
  workflow = normalizeGraphWorkflow(workflow);
  const active = workflow.steps.filter((step) => step.enabled);
  const rounds = deploymentRounds(workflow);
  return [
    "# 当前部署流程（流程编排 · 权威配置）",
    mode === "rounds" ? legacyWorkflowSafetyInstructions : workflowSafetyInstructions,
    "## 执行顺序",
    active.map((step, index) => `${index + 1}. ${step.label} [${step.id}]`).join("\n"),
    mode === "rounds" ? "## Turn 调度（分叉必须汇合）" : "## 步骤依赖（同一次执行内推进，分叉必须汇合）",
    rounds.map((round, index) => `${mode === "rounds" ? "Turn" : "依赖层"} ${index + 1}: ${round.steps.length > 1 ? "分叉 → " : ""}${round.steps.map((step) => `${step.label} [${step.id}]`).join(" ∥ ")}${round.steps.length > 1 ? " → 汇合（全部完成）" : ""}`).join("\n"),
    mode === "rounds"
      ? "按上述顺序执行；每阶段开始、完成或失败都调用 update_agent_workflow_progress(stepId, status, progress, detail)。仅可使用下列已启用的 stepId；禁用步骤不执行。遇到失败先修复或等待用户，不得将未执行阶段标记 completed。"
      : "按上述顺序执行；实际工具携带本轮 workflowStepId 自动标记运行/失败。此前已由工具结果/日志验证的本轮阶段状态，优先用下一次实际操作的 workflowUpdates 数组合并提交（stepId、status、detail），不要预测本次调用成功或把后台回执当完成。不要为开始或细碎百分比单独汇报；无后续实际操作时用 update_agent_workflow_progress 收尾。仅使用已启用 stepId，保留本轮门禁、用户确认与后台结果检查；不得将未执行阶段标记 completed。",
    ...active.map((step, index) => {
      const builtIn = deploymentStageCatalog.find((stage) => stage.id === step.id);
      return [`## ${index + 1}. ${step.label}\nstepId: ${step.id}`, step.prompt,
        builtIn && step.prompt !== builtIn.prompt ? `必要技术检查（不可被编辑内容取消）：\n${builtIn.prompt}` : ""].filter(Boolean).join("\n\n");
    })
  ].join("\n\n");
}
