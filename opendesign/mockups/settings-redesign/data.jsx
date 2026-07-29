/* 原型数据。字段名与 apps/server/src/types.ts、services/*.ts 保持一致。 */

window.DIRECTIONS = [
  { id: "docked", label: "01 Docked Settings", note: "全页设置" },
  { id: "sheet", label: "02 Context Sheet", note: "不离开运维现场" },
  { id: "ledger", label: "03 Config Ledger", note: "全量配置键" }
];

/* apps/web/pages/index.vue:74-81 settingsNavItems */
window.NAV_ITEMS = [
  { id: "model", label: "模型配置", desc: "Base URL / 模型 / 上下文" },
  { id: "skills", label: "Skills", desc: "Agent 技能与开关" },
  { id: "tools", label: "Tools", desc: "Agent 工具与 API Key" },
  { id: "agent", label: "Agent 设置", desc: "内存 / 代理 / Prompt" },
  { id: "java", label: "JAVA 管理", desc: "安装与版本管理" }
];

window.MODEL_BOUNDS = { min: 8, max: 2000, def: 120 };

window.INITIAL_STATE = {
  /* modelService.ts 单例 default_model */
  model: {
    id: "default_model",
    displayName: "OpenAI Compatible",
    baseUrl: "https://api.openai.com/v1",
    modelName: "gpt-4o-mini",
    apiKeyHint: "sk-xxxxxxxx",
    apiKeyDraft: "",
    contextSizeK: 120
  },
  /* AgentSettings */
  agent: {
    autoConfirm: false,
    downloadProxyEnabled: true,
    downloadProxyUrl: "http://127.0.0.1:7890",
    memoryMb: 2048,
    systemMemoryMb: 32768
  },
  /* app_settings，AES-256-GCM 存储，只回传 hint */
  providerKeys: {
    curseForgeApiKeyConfigured: true,
    curseForgeApiKeyHint: "$2axxxxxxxx",
    curseForgeApiKeyDraft: "",
    modrinthApiKeyConfigured: false,
    modrinthApiKeyHint: "未配置",
    modrinthApiKeyDraft: ""
  },
  skills: [
    {
      id: "minecraft_deploy",
      name: "服务端部署 Skill",
      description: "识别上传的服务端包或整合包，安装 Java、生成启动配置并写入 eula.txt。",
      version: "1.7.0",
      enabled: true,
      builtIn: true
    }
  ],
  javaVersionToInstall: "21",
  javaDownloadSource: "auto-cn"
};

window.GLOBAL_PROMPT = `你是 Minecraft 服务端部署助手。你运行在用户自己的机器上，可以读取和修改当前服务端目录。

在执行任何写入、启动、重启或删除操作前，先说明将要改动的文件与影响，并等待用户确认。
只读检查不需要确认。

必须在服务端工作目录下写入 eula.txt（内容至少包含 eula=true），不要试图以交互方式回答 EULA 提示。
不要使用系统自带 Java，始终使用服务端配置中指定的 Java 路径。`;

/* agent/toolCatalog.ts */
window.TOOLS = [
  { name: "web_search", category: "网络检索", description: "检索服务端版本、整合包与报错信息。", requirements: [] },
  { name: "install_java_version", category: "Java 下载", description: "按版本号安装受管 JDK 到 workspace/jdks。", requirements: [] },
  { name: "configure_builtin_python_environment", category: "Python 环境", description: "准备内置 Python 运行时，供部署脚本使用。", requirements: [] },
  { name: "download_https_file_to_server", category: "文件下载", description: "下载 HTTPS 文件到当前服务端目录。", requirements: [] },
  {
    name: "download_mod_to_server_mods",
    category: "模组下载",
    description: "从 CurseForge 或 Modrinth 下载模组到 mods 目录。",
    requirements: [
      { key: "curseForgeApiKey", label: "CurseForge API Key", required: true, helpUrl: "https://console.curseforge.com/?#/api-keys" },
      { key: "modrinthApiKey", label: "Modrinth PAT", required: false, helpUrl: "https://modrinth.com/settings/pats" }
    ]
  }
];

/* javaService.ts fallbackVersions / fallbackLtsVersions */
window.JAVA_VERSIONS = [
  { version: "8", lts: true, installed: false },
  { version: "11", lts: true, installed: false },
  { version: "16", lts: false, installed: false },
  { version: "17", lts: true, installed: true, installPath: "workspace/jdks/jdk-17" },
  { version: "21", lts: true, installed: true, installPath: "workspace/jdks/jdk-21" },
  { version: "22", lts: false, installed: false },
  { version: "23", lts: false, installed: false },
  { version: "24", lts: false, installed: false },
  { version: "25", lts: false, installed: false }
];

window.JAVA_SOURCES = [
  { id: "auto-cn", label: "国内高速（自动）", description: "按可用性自动选择国内镜像" },
  { id: "tsinghua", label: "清华镜像", description: "mirrors.tuna.tsinghua.edu.cn" },
  { id: "cernet", label: "校园网联合镜像", description: "mirrors.cernet.edu.cn" },
  { id: "official", label: "Adoptium 官方", description: "api.adoptium.net，海外直连" }
];

window.SERVERS = [
  { id: "survival", name: "生存服 · Moss Valley", version: "1.21.4", state: "运行中", dot: "live" },
  { id: "creative", name: "创造服 · Redstone Lab", version: "1.20.6", state: "已停止", dot: "" },
  { id: "modpack", name: "整合包 · Skybound", version: "1.20.1", state: "待配置", dot: "warn" }
];

/* 方向三：全量配置键。source 决定是否可在 UI 内改。 */
window.LEDGER = [
  {
    id: "model",
    label: "模型配置",
    rows: [
      { key: "base_url", name: "Base URL", value: "https://api.openai.com/v1", source: "db", scope: "全局", editable: true, note: "请求发往 ${baseUrl}/chat/completions，尾斜杠会被规范化。" },
      { key: "model_name", name: "模型名称", value: "gpt-4o-mini", source: "db", scope: "全局", editable: true, note: "" },
      { key: "encrypted_api_key", name: "API Key", value: "sk-xxxxxxxx", source: "db", scope: "全局", editable: true, secret: true, note: "AES-256-GCM 存储，只能覆盖写入，不能读回明文。" },
      { key: "context_size_k", name: "上下文窗口", value: "120K", source: "db", scope: "全局", editable: true, note: "允许 8–2000，超出会被 normalizeContextSizeK 夹紧。" },
      { key: "reasoning_effort", name: "思考深度", value: "high", source: "request", scope: "单次请求", editable: true, note: "随每条消息发送，不落库。可选 minimal / low / medium / high。" }
    ]
  },
  {
    id: "agent",
    label: "Agent 设置",
    rows: [
      { key: "agent_memory_mb", name: "推荐内存", value: "2048 MB", source: "db", scope: "全局", editable: true, note: "下限 512 MB，上限取 os.totalmem()。仅作为新建实例的推荐值。" },
      { key: "agent_auto_confirm", name: "自动确认写操作", value: "false", source: "db", scope: "全局", editable: true, note: "" },
      { key: "agent_download_proxy_enabled", name: "下载代理", value: "true", source: "db", scope: "全局", editable: true, note: "" },
      { key: "agent_download_proxy_url", name: "代理地址", value: "http://127.0.0.1:7890", source: "db", scope: "全局", editable: true, note: "仅支持 HTTP / HTTPS。影响联网工具、Java 安装、Forge installer 与服务端进程，不影响模型请求。" },
      { key: "global_system_prompt", name: "默认 System Prompt", value: "已自定义（412 字）", source: "db", scope: "全局", editable: true, note: "可恢复为 config.ts 中的 defaultSystemPrompt。" },
      { key: "curseforge_api_key", name: "CurseForge API Key", value: "$2axxxxxxxx", source: "db", scope: "全局", editable: true, secret: true, note: "未配置时回退到环境变量 CURSEFORGE_API_KEY。" },
      { key: "modrinth_api_key", name: "Modrinth PAT", value: "未配置", source: "db", scope: "全局", editable: true, secret: true, note: "多数下载不需要。" }
    ]
  },
  {
    id: "server",
    label: "实例配置",
    rows: [
      { key: "name", name: "服务端名字", value: "生存服 · Moss Valley", source: "db", scope: "本实例", editable: true, note: "" },
      { key: "java_version", name: "Java 版本", value: "21", source: "db", scope: "本实例", editable: true, note: "只能选已安装版本。留空 java_path 时按此自动解析。" },
      { key: "java_path", name: "Java 可执行路径", value: "workspace/jdks/jdk-21/bin/java", source: "db", scope: "本实例", editable: true, note: "解析顺序：受管 JDK → java_path → 字面量 java。" },
      { key: "min_memory", name: "最小内存", value: "1G", source: "db", scope: "本实例", editable: true, note: "写入 -Xms，并同步到 user_jvm_args.txt。" },
      { key: "max_memory", name: "最大内存", value: "4G", source: "db", scope: "本实例", editable: true, note: "写入 -Xmx。超过物理内存 90% 会警告。" },
      { key: "jar_file", name: "服务端 Jar", value: "server.jar", source: "db", scope: "本实例", editable: true, note: "" },
      { key: "start_args", name: "启动附加参数", value: "nogui", source: "db", scope: "本实例", editable: true, note: "" },
      { key: "startup_command", name: "启动指令", value: "{java} -Xms{minMemory} …", source: "db", scope: "本实例", editable: true, note: "支持 {java} {javaHome} {python} {workspace} {serverDir} {minMemory} {maxMemory} {jarFile} {startArgs} 等占位符。" },
      { key: "use_global_prompt", name: "使用全局 Prompt", value: "1", source: "db", scope: "本实例", editable: true, note: "" },
      { key: "prompt_override", name: "实例 Prompt 覆盖", value: "未设置", source: "db", scope: "本实例", editable: true, note: "" }
    ]
  },
  {
    id: "runtime",
    label: "运行环境",
    rows: [
      { key: "APP_PORT", name: "后端端口", value: "8787", source: "env", scope: "部署时", editable: false, note: "改动需重启进程。" },
      { key: "NUXT_PORT", name: "前端端口", value: "3000", source: "env", scope: "部署时", editable: false, note: "" },
      { key: "PROXY_PORT", name: "对外代理端口", value: "1143", source: "env", scope: "部署时", editable: false, note: "对外只需暴露这一个端口。" },
      { key: "APP_PASSWORD", name: "登录密码", value: "已设置", source: "env", scope: "部署时", editable: false, secret: true, note: "单一共享口令，7 天 HMAC-SHA256 Cookie。" },
      { key: "APP_SECRET_KEY", name: "密钥种子", value: "已设置", source: "env", scope: "部署时", editable: false, secret: true, note: "同时用于 Token 签名与 API Key 加密。轮换会使已存 API Key 失效。" },
      { key: "WORKSPACE_ROOT", name: "工作目录", value: "./workspace", source: "env", scope: "部署时", editable: false, note: "GET /api/meta 只读回显。" }
    ]
  },
  {
    id: "file",
    label: "服务端文件",
    rows: [
      { key: "server-port", name: "服务端端口", value: "25565", source: "file", scope: "本实例", editable: false, note: "只存在于 server.properties。当前没有结构化编辑器，需在文件管理器里改纯文本。" },
      { key: "motd", name: "MOTD", value: "Minecraft Server Agent", source: "file", scope: "本实例", editable: false, note: "同上。" },
      { key: "eula", name: "EULA", value: "true", source: "file", scope: "本实例", editable: false, note: "由部署流程写入 eula.txt，没有 UI 开关。" },
      { key: "white-list", name: "白名单", value: "false", source: "file", scope: "本实例", editable: false, note: "whitelist.json / ops.json 目前完全不受应用管理。" },
      { key: "rcon.port", name: "RCON", value: "未启用", source: "file", scope: "本实例", editable: false, note: "应用代码里没有 RCON 实现，仅模板数据中出现。" }
    ]
  }
];

window.SOURCE_META = {
  db: { label: "SQLite", tone: "ok" },
  env: { label: "环境变量", tone: "env" },
  file: { label: "服务端文件", tone: "warn" },
  request: { label: "单次请求", tone: "" }
};
