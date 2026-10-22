// Pure transforms used only by the isolated ablation preload; no production imports.
export const profiles = ["control", "no-skill", "no-progress", "single-turn", "lean-runtime", "compact-static"];

export function transformPrompt(text, profile) {
  if (profile === "no-progress") {
    return text
      .replace(/按上述顺序执行；每阶段开始、完成或失败都调用 update_agent_workflow_progress\(stepId, status, progress, detail\)。/g, "按上述顺序执行；进度由后端工具事件记录，不主动调用进度工具。")
      .replace(/进度使用 stepId。/g, "进度由后端记录。")
      .replace(/依据证据更新完成\/失败，简短汇总后系统推进。/g, "依据证据确认完成或失败，简短汇总后系统推进。");
  }
  if (profile === "single-turn") {
    return text
      .replace(/完整部署调用 begin_deployment_workflow，/g, "完整部署在本次会话完成，")
      .replace(/完整部署必须先调用 begin_deployment_workflow，由后端调度 turn；普通排错、查询、安装单个模组不启动完整流程。/g, "完整部署在一个 turn 内完成全部阶段，不调用 begin_deployment_workflow；阶段依赖与技术检查不变。")
      .replace(/- 串行节点各一个 turn，并行组共用一个 turn，由系统推进。/g, "- 全部节点在当前 turn 内按依赖执行。")
      .replace(/## Turn 调度（分叉必须汇合）[\s\S]*?(?=按上述顺序执行)/, "## 单 turn 执行\n\n所有阶段在本次 turn 内完成，不等待后端创建后续 turn；原图依赖与并行汇合要求不变。\n\n");
  }
  return text;
}

export function leanRuntime(text) {
  return text.split("\n").filter(line => !["配置策略：", "模板与目录事实：", "启动事实：", "工作空间约束：", "对话要求："].some(prefix => line.startsWith(prefix))).join("\n");
}

// Purposefully retains safety, backend management, stage dependencies, failure
// semantics and exact stage IDs. This is semantic compression, not padding.
export function compactStatic(workflow) {
  const stages = {
    identify_modpack: "检查已确认本地包/README，确定包版本、Minecraft、Loader；不另找候选或重复询问，无法核实则报告失败。",
    prepare_server_slot: "已上传包优先复用槽位；否则只用官方API/可信HTTPS。原包留槽位；缺凭据停止，不猜测。",
    check_java_dependencies: "按实际MC/Loader要求调用check_java_environment；复用available工作区Java，缺少才install_java_version；update_current_server_config写入MC/Java版本路径并核对，不用系统Java，失败不装Loader或启动。",
    configure_python: "configure_builtin_python_environment准备workspace/python独立Python3.10、pip、MCDR；用配置镜像，不用系统Python/venv/ensurepip。",
    extract_to_workspace: "仅还原到server/。完整包extract_server_slot_to_workspace；mrpack先inspect再deploy(phase=files)；CF清单用materialize_curseforge_manifest_pack_from_server_slot。检查布局与包内脚本，Loader留下一阶段。",
    install_modloader: "用已验证Java；现有匹配启动文件可复用，否则装包指定Loader。Forge/NeoForge优先包内installer或官方Maven并启用能力后setup(background=true)；mrpack用phase=loader。installer不是服务端jar；文件在server/；等真实成功，期间可做无冲突MCDR配置。",
    configure_mcdr: "根config.yml设working_directory=server，handler匹配（Forge/NeoForge为forge_handler），start_command从server/运行可用包内脚本/非交互Java而非递归MCDR。ChatHub保留地址密码及已有唯一node_id，模板ID改mc-实例ID(1–64字母数字_.-)，name为指定名称，不回显密码。YAML/JSON解析核对，不探索内部API；与Loader并行只改根config.yml/config/chathub，不改server/或实例启动配置。",
    final_mcdr_test: "核对配置/安装结果，内存Xms=Xmx=推荐值且不超限；startupCommand={python} -m mcdreforged。start_current_server→wait_for_server_startup→inspect_current_server_validation→send_current_server_command(list默认等响应)。复用已通过证据只查unknown。缺依赖按日志/requirements精确install_mcdreforged_plugin_dependencies；重启stop→wait_for_server_stopped确认退出→start，不sleep/轮询/默认强杀。游戏就绪、13模板插件加载与ERROR/FATAL独立报告；报错不自动禁模组/重启，插件加载不等于功能正常；未验收/失败如实说。"
  };
  const rounds = "1确认；2槽位∥Java∥Python；3还原；4Loader∥MCDR；5最终验证";
  return [
    "你是Minecraft部署Agent，仅操作绑定实例，用受控工具与后端管理持续进程；不得切换/新建实例、越界写入或伪造结果。安全权限、确认、凭据检查始终生效。",
    "本次非交互，用户包/版本已确认，不调用ask_user；信息不足报告缺项。新实例已套用reference模板，不重复初始化，旧实例缺失仅overwrite=false。Minecraft在server/，MCDR在根目录。",
    "完整部署先begin_deployment_workflow，按后端当前turn节点和原图依赖执行；串行节点一turn、并行组同turn，后台汇合后才推进。每阶段开始/结束/失败用update_agent_workflow_progress(stepId,status,progress,detail)，不得假报完成。默认轮次：" + rounds,
    ...workflow.steps.filter(step => step.enabled).map(step => `${step.id}: ${stages[step.id] ?? step.prompt}`),
    "仅无资源冲突工作并行；background回执非完成，Inbox接收结果，依赖时wait_for_background_job，输出用游标read_background_job_output；不轮询/重复安装，interrupted先检查外部副作用不盲重放。",
    "专用工具优先，Shell用于补充检查修复且按退出码判断。TOOL_ERROR按实际原因改路径/参数/方案；缺能力install_agent_capability；不原样重复失败调用。必要资料web_search/fetch，下载只官方或可信来源；单模组download_mod_to_server_mods；客户端模组仅日志有证据才禁用重命名不删除。",
    "端口/内存/隔离及本次生产ChatHub禁止外连以用户任务为准。远程功能未授权不验收；最终保留运行供外部runner验收。"
  ].join("\n\n");
}
