/* 原型数据：实例、终端片段、快捷指令、以及脚本化对话所需的素材。
   全部是静态 mock，不依赖后端；字段命名尽量对齐 apps/web/types/app.ts，
   方便看完原型后直接映射到真实的 ServerRecord / AgentMessage。 */

window.INSTANCES = [
  {
    id: "moss-valley",
    name: "生存服 · Moss Valley",
    initial: "MO",
    status: "running",
    kind: "MCDReforged · Forge",
    minecraft: "1.20.1",
    loader: "Forge 47.2.20",
    java: "Java 21",
    memory: "4 GB",
    players: "3 / 20",
    uptime: "已运行 6 小时 12 分",
    lastActive: "2 分钟前",
    directory: "workspace/servers/moss-valley",
    recommended: true,
    reason: "最近活跃、内存占用稳定，适合继续加装模组并回归日常玩法。",
    tags: ["最近活跃", "运行中"]
  },
  {
    id: "sky-block",
    name: "空岛服 · Sky Block",
    initial: "SK",
    status: "stopped",
    kind: "Fabric",
    minecraft: "1.21",
    loader: "Fabric 0.16.5",
    java: "Java 21",
    memory: "2 GB",
    players: "—",
    uptime: "上次运行 3 天前",
    lastActive: "3 天前",
    directory: "workspace/servers/sky-block",
    recommended: false,
    reason: "配置完好但已停服 3 天，随时可以重新启动继续玩。",
    tags: ["已停止"]
  },
  {
    id: "artisan",
    name: "匠造工坊 · Create",
    initial: "CR",
    status: "crashed",
    kind: "MCDReforged · Forge",
    minecraft: "1.16.5",
    loader: "Forge 36.2.39",
    java: "Java 8",
    memory: "6 GB",
    players: "—",
    uptime: "启动 40 秒后异常退出",
    lastActive: "20 分钟前",
    directory: "workspace/servers/artisan",
    recommended: true,
    reason: "检测到致命错误，Agent 建议先定位崩溃原因再重新启动。",
    tags: ["异常退出", "待处理"]
  }
];

/* 原型顶部的视图切换。 */
window.VIEWS = [
  { id: "dashboard", label: "主界面 Dashboard", hint: "欢迎词 / 实例推荐 / 总对话框" },
  { id: "console", label: "实例操作台", hint: "左：Agent 对话记录 · 右：实例终端" }
];

/* 终端输出片段：value 是 [stream, text] 数组，stream 取 stdout / stderr / system。 */
window.TERMINAL_LOGS = {
  "moss-valley": [
    ["stdout", "[12:04:51] [Server thread/INFO]: Starting minecraft server version 1.20.1"],
    ["stdout", "[12:04:52] [Server thread/INFO]: Loading properties"],
    ["stdout", "[12:04:53] [Server thread/INFO]: Preparing level \"world\""],
    ["stdout", "[12:05:08] [Server thread/INFO]: Preparing spawn area: 92%"],
    ["stdout", "[12:05:11] [Server thread/INFO]: Done (19.812s)! For help, type \"help\""],
    ["stdout", "[12:06:02] [Server thread/INFO]: Player Mikan joined the game"],
    ["stdout", "[12:06:30] [Server thread/INFO]: Mikan[/192.168.31.24:51244] logged in with entity id 214"],
    ["stdout", "[12:09:14] [Server thread/INFO]: <Mikan> 这边地形不错，先在这扎营"],
    ["system", "MCDReforged 已接管控制台，{python} -m mcdreforged 运行正常。"]
  ],
  "sky-block": [
    ["stdout", "[09:22:03] [Server thread/INFO]: Starting minecraft server version 1.21"],
    ["stdout", "[09:22:05] [Server thread/INFO]: Loading properties"],
    ["stdout", "[09:22:09] [Server thread/INFO]: Done (3.914s)! For help, type \"help\""],
    ["stdout", "[11:48:20] [Server thread/INFO]: Stopping the server"],
    ["system", "服务端已正常停止，存档已写入磁盘。"]
  ],
  "artisan": [
    ["stdout", "[11:42:10] [main/INFO]: Launching target 'forge_server' with arguments [...]"],
    ["stdout", "[11:42:11] [modloading-worker-0/INFO]: Loading 214 mods"],
    ["stderr", "[11:42:44] [modloading-worker-3/ERROR]: Failed to load class net.minecraft.world.level.chunk.ChunkStatus"],
    ["stderr", "[11:42:44] [main/ERROR]: Exception in thread \"main\" java.lang.NoClassDefFoundError: com/simibubi/create/Create"],
    ["stderr", "[11:42:44] [main/ERROR]: Caused by: java.lang.ClassNotFoundException: com.simibubi.create.Create"],
    ["stderr", "[11:42:44] [main/ERROR]: A mod failed to load: create-1.16.5.jar is built for Forge 36.2.39 but a mismatched version was detected."],
    ["system", "进程以退出码 1 结束。MCDReforged 已捕获崩溃输出。"]
  ],
  "new-instance": [
    ["system", "新实例的目录已创建，还没有服务端包。"]
  ]
};

/* 启动时逐行追加的日志，用来演示“自动跳转到实例终端”。 */
window.START_LOG = [
  ["system", "启动请求已由 Agent 通过 start_current_server 下发…"],
  ["stdout", "[12:31:02] [Server thread/INFO]: Starting minecraft server version {mc}"],
  ["stdout", "[12:31:03] [Server thread/INFO]: Loading properties"],
  ["stdout", "[12:31:05] [Server thread/INFO]: Preparing level \"world\""],
  ["stdout", "[12:31:18] [Server thread/INFO]: Preparing spawn area: 78%"],
  ["stdout", "[12:31:21] [Server thread/INFO]: Done (16.204s)! For help, type \"help\""],
  ["system", "启动完成，实例状态已切换为「运行中」。"]
];

window.DEPLOY_LOG = [
  ["system", "正在从 CurseForge 拉取服务端包到服务端槽位…"],
  ["stdout", "download_curseforge_server_pack_to_server_slot: Server-Files-1.1.1.zip 42.7 MB / 96.4 MB"],
  ["stdout", "download_curseforge_server_pack_to_server_slot: Server-Files-1.1.1.zip 96.4 MB / 96.4 MB"],
  ["system", "materialize_curseforge_manifest_pack_from_server_slot: 校验 manifest.json，标记 187 个 required 模组"],
  ["system", "extract_server_slot_to_workspace: 解压到 server/ …"],
  ["system", "initialize_server_template(template=reference): 套用 MCDReforged 模板"],
  ["system", "configure_builtin_python_environment: 内置 Python 3.10 + MCDReforged 就绪"]
];

window.FIX_LOG = [
  ["system", "已终止残留进程，正在用 Java 17 重新拉起服务端…"],
  ["stdout", "[12:40:10] [Server thread/INFO]: Starting minecraft server version 1.16.5"],
  ["stdout", "[12:40:12] [modloading-worker-0/INFO]: Loading 213 mods"],
  ["stdout", "[12:40:41] [Server thread/INFO]: Done (28.113s)! For help, type \"help\""],
  ["stdout", "[12:40:41] [Server thread/INFO]: 已加载 Create 0.5.1.e，版本校验通过"],
  ["system", "错误已清除，实例状态切换为「运行中」。"]
];

/* 快捷指令：主界面对话框里的一键入口。 */
window.QUICK_PROMPTS = [
  { icon: "rocket", label: "部署整合包", text: "帮我部署一个 1.20.1 的 Forge 整合包" },
  { icon: "activity", label: "巡检实例", text: "我的实例现在都在跑吗？帮我检查一下" },
  { icon: "triangle-alert", label: "排查崩溃", text: "匠造工坊刚才崩了，帮我看看终端报错" },
  { icon: "sparkles", label: "空闲建议", text: "接下来我可以做什么？给我一些建议" }
];

/* 平台总览数字。 */
window.PLATFORM_STATS = [
  { id: "instances", label: "实例总数", value: "3", hint: "1 个空实例可部署", tone: "neutral" },
  { id: "running", label: "运行中", value: "1", hint: "Moss Valley · 3/20 在线", tone: "ok" },
  { id: "attention", label: "需要处理", value: "1", hint: "匠造工坊异常退出", tone: "warn" },
  { id: "model", label: "Agent 模型", value: "在线", hint: "上下文剩余 82%", tone: "ok" }
];

/* 实例名速查，消息里的“跳转到某实例”会用到。 */
window.INSTANCE_NAMES = {
  "moss-valley": "生存服 · Moss Valley",
  "sky-block": "空岛服 · Sky Block",
  "artisan": "匠造工坊 · Create",
  "new-instance": "我的新服"
};

window.fmt = {
  status(value) {
    return {
      running: "运行中",
      starting: "启动中",
      stopping: "关闭中",
      stopped: "已停止",
      crashed: "异常退出",
      orphaned: "疑似后台残留",
      empty: "待部署"
    }[value] || value;
  },
  statusTone(value) {
    if (value === "running") return "ok";
    if (value === "crashed" || value === "orphaned") return "danger";
    if (value === "starting" || value === "stopping") return "busy";
    return "idle";
  },
  greeting() {
    const hour = new Date().getHours();
    if (hour < 6) return "夜深了";
    if (hour < 12) return "早上好";
    if (hour < 18) return "下午好";
    return "晚上好";
  },
  time(value) {
    const date = new Date(value);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
};
