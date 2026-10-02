/* 原型外壳：两个视图（主界面 Dashboard / 实例操作台 Console）共用一份会话与实例状态。
   对话是脚本化的：按关键词命中剧本，逐步追加消息、活动行与终端输出，
   并在“涉及实例操作”时自动把视图切到实例操作台，模拟真实的跳转手感。 */

const { useState, useEffect, useCallback, useRef } = React;

let messageSeq = 0;
function nextId(prefix) {
  messageSeq += 1;
  return `${prefix}-${messageSeq}`;
}
function now() {
  return new Date().toISOString();
}
function makeMessage(role, content, extra) {
  return { id: nextId(role), role, content, status: null, createdAt: now(), ...extra };
}
function makeActivity(title, toolName, detail, status) {
  return { id: nextId("activity"), role: "system", content: title, status, createdAt: now(), activity: { kind: "tool", title, toolName, detail, status } };
}

/* 命中检测：按顺序取第一个匹配的剧本。 */
function pickScript(text) {
  const value = text.trim();
  const has = (...words) => words.some((word) => value.includes(word));
  if (has("建", "创建", "新建", "开一个服", "开个服") && has("实例", "服", "1.20", "1.21", "整合包")) return "create";
  if (has("整合包", "部署", "mrpack", "curseforge", "modrinth", "服务端包")) return "deploy";
  if (has("崩", "报错", "错误", "异常", "崩溃")) return "fix";
  if (has("巡检", "检查", "都在跑", "状态", "健康")) return "inspect";
  if (has("启动", "开服", "拉起", "重开")) return "start";
  if (has("停", "关闭", "关服")) return "stop";
  if (has("建议", "可以做", "空闲", "推荐")) return "advice";
  return "fallback";
}

/* 初始对话：一次“什么都没干就打开面板”的普通开场。 */
function initialMessages() {
  const stamp = now();
  return [
    { id: "seed-1", role: "user", content: "我的实例现在都还好吗？", status: null, createdAt: stamp },
    {
      id: "seed-2",
      role: "agent",
      content: "刚巡检完，3 个实例里 1 个在跑、1 个停着、1 个异常退出。匠造工坊是崩的，建议优先处理；空岛服随时可以重启。要我现在就动手吗？",
      status: "completed",
      createdAt: stamp
    }
  ];
}

const DEFAULTS = {
  instances: () => window.INSTANCES.map((item) => ({ ...item })),
  logs: () => JSON.parse(JSON.stringify(window.TERMINAL_LOGS))
};

function App() {
  const [view, setView] = useState(() => localStorage.getItem("dash-view") || "dashboard");
  const [instances, setInstances] = useState(DEFAULTS.instances);
  const [logsByInstance, setLogsByInstance] = useState(DEFAULTS.logs);
  const [messages, setMessages] = useState(initialMessages);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [activeInstanceId, setActiveInstanceId] = useState("moss-valley");
  const [autoConfirm, setAutoConfirm] = useState(true);
  const [commandDrafts, setCommandDrafts] = useState({});
  const [notice, setNotice] = useState("");
  const [spotlight, setSpotlight] = useState(null);

  const timers = useRef([]);
  const chatRef = useRef(null);
  const spotlightTimer = useRef(null);

  useEffect(() => {
    localStorage.setItem("dash-view", view);
  }, [view]);
  useEffect(() => {
    if (window.lucide) window.lucide.createIcons({ attrs: { "stroke-width": "2" } });
  });
  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(""), 2400);
    return () => clearTimeout(timer);
  }, [notice]);

  /* 组件卸载时清掉所有脚本定时器，避免切视图后还在追加消息。 */
  useEffect(() => () => {
    timers.current.forEach(clearTimeout);
    clearTimeout(spotlightTimer.current);
  }, []);

  useEffect(() => {
    const list = chatRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages, view]);

  const flash = useCallback((id) => {
    setSpotlight(id);
    clearTimeout(spotlightTimer.current);
    spotlightTimer.current = setTimeout(() => setSpotlight(null), 2600);
  }, []);

  const later = useCallback((fn, delay) => {
    timers.current.push(setTimeout(fn, delay));
  }, []);

  const pushLog = useCallback((instanceId, lines) => {
    setLogsByInstance((current) => ({ ...current, [instanceId]: [...(current[instanceId] || []), ...lines] }));
  }, []);
  const setInstanceStatus = useCallback((instanceId, status, patch) => {
    setInstances((current) => current.map((item) => (item.id === instanceId ? { ...item, status, ...(patch || {}) } : item)));
  }, []);

  const focusConsole = useCallback((instanceId) => {
    setActiveInstanceId(instanceId);
    setView("console");
    flash(instanceId);
  }, [flash]);

  const openConsole = useCallback((instanceId) => {
    setActiveInstanceId(instanceId);
    setView("console");
  }, []);

  /* ── 剧本 ─────────────────────────────────────────────── */

  const scripts = {
    inspect() {
      const agentId = nextId("agent");
      setMessages((current) => [...current, makeMessage("agent", "好的，我挨个看一遍。", { id: agentId, status: "running" })]);
      const rows = [
        ["生成实例健康快照", "list_instances", "读取 3 个实例的状态、内存与最近报错"],
        ["读取各实例终端尾部", "read_console_log", "匠造工坊：捕获到 NoClassDefFoundError (Create)"],
        ["检查 Java 与内存配置", "inspect_runtime", "Java 21 / Java 21 / Java 8，均在有效期"]
      ];
      rows.forEach((row, index) => {
        later(() => setMessages((current) => [...current, makeActivity(row[0], row[1], row[2], index === rows.length - 1 ? "completed" : "running")]), 700 + index * 650);
      });
      later(() => {
        setMessages((current) => current.map((message) => message.id === agentId
          ? { ...message, status: "completed", content: "巡检完成：Moss Valley 运行正常（在线 3/20）；Sky Block 已停止，可随时启动；匠造工坊崩溃，日志显示 Create 模组与 Forge 版本不匹配，需要换 Java 8→17 再重启。要我现在修匠造工坊吗？" }
          : message));
        setBusy(false);
      }, 700 + rows.length * 650 + 500);
    },

    fix() {
      later(() => {
        const agentId = nextId("agent");
        setMessages((current) => [...current, makeMessage("agent", "收到，先看匠造工坊的崩溃现场。", { id: agentId, status: "running" })]);
        setMessages((current) => [...current, makeActivity("定位崩溃原因", "read_console_log", "3 条 ERROR，根因：Create 与 Forge 版本不匹配", "completed")]);
        setMessages((current) => [...current, makeActivity("切换运行环境并重启", "start_current_server", "Java 8 → Java 17，重新拉起匠造工坊", "running")]);
      }, 450);
      later(() => focusConsole("artisan"), 1250);
      later(() => pushLog("artisan", window.FIX_LOG), 1500);
      later(() => setInstanceStatus("artisan", "running", { players: "1 / 20", uptime: "已运行 1 分钟", tags: ["运行中"], recommended: false, reason: "崩溃已修复，正在稳定运行。" }), 2650);
      later(() => {
        setMessages((current) => {
          const cleaned = current.map((message) => message.activity && message.activity.status === "running"
            ? { ...message, activity: { ...message.activity, status: "completed" } }
            : message);
          return [...cleaned, makeMessage("agent", "匠造工坊已经修好并重新启动：根因是 Create 模组与 Forge 版本不匹配，我把运行环境切到 Java 17 后服务端正常加载，现在状态是「运行中」。终端已经停在匠造工坊，你可以直接看启动日志。", { status: "completed", targetInstanceId: "artisan" })];
        });
        setBusy(false);
      }, 2900);
    },

    start() {
      const target = instances.find((item) => item.status === "stopped") || instances[0];
      const targetId = target ? target.id : "sky-block";
      later(() => {
        setMessages((current) => [...current, makeMessage("agent", `好的，我来启动 ${window.INSTANCE_NAMES[targetId] || targetId}。`, { status: "running" })]);
        setMessages((current) => [...current, makeActivity("启动服务端", "start_current_server", "下发启动指令，等待端口就绪", "running")]);
        setInstanceStatus(targetId, "starting", { tags: ["启动中"] });
      }, 400);
      later(() => focusConsole(targetId), 1150);
      later(() => pushLog(targetId, window.START_LOG.map((line) => line[1].includes("{mc}") ? [line[0], line[1].replace("{mc}", target ? target.minecraft : "1.20.1")] : line)), 1400);
      later(() => setInstanceStatus(targetId, "running", { players: "1 / 20", uptime: "已运行 12 秒", tags: ["运行中"], reason: "刚刚由 Agent 启动，运行稳定。" }), 2700);
      later(() => {
        setMessages((current) => current.map((message) => message.activity && message.activity.status === "running"
          ? { ...message, activity: { ...message.activity, status: "completed" } }
          : message));
        setMessages((current) => [...current, makeMessage("agent", `${window.INSTANCE_NAMES[targetId] || targetId} 已启动完成，终端显示 Done，实例状态切成「运行中」。右侧就是它的实时控制台。`, { status: "completed", targetInstanceId: targetId })]);
        setBusy(false);
      }, 2950);
    },

    stop() {
      const target = instances.find((item) => item.status === "running") || { id: "moss-valley", minecraft: "1.20.1" };
      later(() => {
        setMessages((current) => [...current, makeMessage("agent", `收到，正在正常关闭 ${window.INSTANCE_NAMES[target.id] || target.id}，会先保存存档。`, { status: "running" })]);
        setMessages((current) => [...current, makeActivity("停止服务端", "stop_current_server", "执行 stop，等待存档写入完成", "running")]);
        setInstanceStatus(target.id, "stopping", { tags: ["关闭中"] });
      }, 400);
      later(() => focusConsole(target.id), 1000);
      later(() => pushLog(target.id, [["stdout", "[12:52:01] [Server thread/INFO]: Stopping the server"], ["stdout", "[12:52:04] [Server thread/INFO]: Saving worlds"], ["system", "存档已写入，进程退出码 0。"]]), 1300);
      later(() => setInstanceStatus(target.id, "stopped", { players: "—", uptime: "刚刚停止", tags: ["已停止"] }), 2400);
      later(() => {
        setMessages((current) => current.map((message) => message.activity && message.activity.status === "running"
          ? { ...message, activity: { ...message.activity, status: "completed" } }
          : message));
        setMessages((current) => [...current, makeMessage("agent", `${window.INSTANCE_NAMES[target.id] || target.id} 已安全关闭，存档已落盘。需要的话我随时可以再拉起来。`, { status: "completed", targetInstanceId: target.id })]);
        setBusy(false);
      }, 2600);
    },

    deploy() {
      const targetId = instances.find((item) => item.status === "empty") ? "new-instance" : (instances[0] && instances[0].id) || "moss-valley";
      later(() => {
        setMessages((current) => [...current, makeMessage("agent", "好，按部署 Skill 的流程走：先确认整合包，再下载服务端包到槽位、套 MCDReforged 模板、准备内置 Python。", { status: "running" })]);
        setMessages((current) => [...current, makeActivity("检索整合包", "identify_modpack", "Modrinth 命中 3 个候选，等待确认版本", "completed")]);
        setMessages((current) => [...current, makeActivity("下载服务端包到槽位", "download_curseforge_server_pack_to_server_slot", "Server-Files-1.1.1.zip · 96.4 MB", "running")]);
      }, 500);
      later(() => focusConsole(targetId), 1200);
      later(() => pushLog(targetId, window.DEPLOY_LOG.slice(0, 3)), 1500);
      later(() => pushLog(targetId, window.DEPLOY_LOG.slice(3)), 2400);
      later(() => {
        setMessages((current) => current.map((message) => message.activity && message.activity.toolName === "download_curseforge_server_pack_to_server_slot"
          ? { ...message, activity: { ...message.activity, status: "completed" } }
          : message));
      }, 3000);
      later(() => {
        setMessages((current) => [...current, makeMessage("agent", "服务端包已放进槽位，模板和 Python 也准备好了。下一步需要在终端里确认 EULA 并首次启动——左侧终端已经切到该实例，你可以在那里跟进，或让我继续自动完成。", { status: "completed", targetInstanceId: targetId })]);
        setBusy(false);
      }, 3300);
    },

    create() {
      later(() => {
        setMessages((current) => [...current, makeMessage("agent", "可以，我来建一个新实例并直接部署。先创建目录、分配内存，再装 Java、套模板、写 EULA。", { status: "running" })]);
        setMessages((current) => [...current, makeActivity("创建实例", "create_server", "名为「我的新服」，初始目录空置", "running")]);
      }, 450);
      later(() => {
        setInstances((current) => [
          ...current,
          {
            id: "new-instance",
            name: "我的新服",
            initial: "新",
            status: "starting",
            kind: "MCDReforged · Forge",
            minecraft: "1.20.1",
            loader: "Forge 47.2.20",
            java: "Java 21",
            memory: "4 GB",
            players: "—",
            uptime: "部署中",
            lastActive: "刚刚创建",
            directory: "workspace/servers/new-instance",
            recommended: true,
            reason: "正在由 Agent 从零部署，全程会显示在右侧终端。",
            tags: ["部署中"]
          }
        ]);
        setLogsByInstance((current) => ({ ...current, "new-instance": window.TERMINAL_LOGS["new-instance"] }));
      }, 1100);
      later(() => focusConsole("new-instance"), 1150);
      later(() => {
        setMessages((current) => current.map((message) => message.activity && message.activity.toolName === "create_server"
          ? { ...message, activity: { ...message.activity, status: "completed" } }
          : message));
        setMessages((current) => [...current, makeActivity("准备运行环境", "configure_builtin_python_environment", "内置 Python 3.10 + MCDReforged + Java 21", "running")]);
        pushLog("new-instance", window.DEPLOY_LOG.slice(3));
      }, 1700);
      later(() => setInstanceStatus("new-instance", "stopped", { uptime: "部署完成，待启动", tags: ["待启动"] }), 3100);
      later(() => {
        setMessages((current) => current.map((message) => message.activity && message.activity.status === "running"
          ? { ...message, activity: { ...message.activity, status: "completed" } }
          : message));
        setMessages((current) => [...current, makeMessage("agent", "新实例创建完成，运行环境就绪，现在处于「已停止」。要我立刻启动并写一份基础 server.properties 吗？", { status: "completed", targetInstanceId: "new-instance" })]);
        setBusy(false);
      }, 3350);
    },

    advice() {
      later(() => {
        setMessages((current) => [...current, makeMessage("agent", [
          "给你几个当下最值得做的：",
          "1. 匠造工坊还在崩溃状态，换 Java 17 后能直接恢复；",
          "2. 空岛服停了 3 天，启动前可以先备份存档；",
          "3. Moss Valley 可以在线跑，适合直接加装新模组做回归测试。",
          "想从哪件开始？直接说“修匠造工坊”或者“建个新服”都行。"
        ].join("\n"), { status: "completed" })]);
        setBusy(false);
      }, 700);
    },

    fallback() {
      later(() => {
        setMessages((current) => [...current, makeMessage("agent", "我明白你的意思，但目前演示只覆盖了几条主流程：部署整合包 / 巡检实例 / 排查崩溃 / 创建实例 / 启停实例。点上面的快捷指令看看完整链路，或者换个说法再试。", { status: "completed" })]);
        setBusy(false);
      }, 650);
    }
  };

  /* ── 交互 ─────────────────────────────────────────────── */

  const send = useCallback((text) => {
    const content = (text !== undefined ? text : input).trim();
    if (!content || busy) return;
    const script = pickScript(content);
    setMessages((current) => [...current, makeMessage("user", content)]);
    setInput("");
    setBusy(true);
    scripts[script]();
  }, [input, busy, scripts]);

  const stop = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setMessages((current) => {
      const cleaned = current.map((message) => message.activity && message.activity.status === "running"
        ? { ...message, activity: { ...message.activity, status: "cancelled" } }
        : message);
      return [...cleaned, makeMessage("agent", "已中断当前任务。已执行的步骤保留在终端记录里，需要继续随时说。", { status: "cancelled" })];
    });
    setBusy(false);
  }, []);

  const quickStart = useCallback((instanceId) => {
    const target = instances.find((item) => item.id === instanceId);
    if (!target) return;
    if (target.status === "crashed") return send(`帮我修好并启动${target.name}`);
    return send(`启动${target.name}`);
  }, [instances, send]);

  const sendCommand = useCallback((instanceId) => {
    const draft = (commandDrafts[instanceId] || "").trim();
    if (!draft) return;
    pushLog(instanceId, [["system", `> ${draft}`], ["stdout", `[控制台] 已下发指令：${draft}`]]);
    setCommandDrafts((current) => ({ ...current, [instanceId]: "" }));
    if (draft === "list") {
      const online = instances.filter((item) => item.status === "running").length;
      later(() => pushLog(instanceId, [["stdout", online ? "[12:53:40] [Server thread/INFO]: There are 3 of a max of 20 players online: Mikan, Aris, Kite" : "[12:53:40] [Server thread/INFO]: There are 0 of a max of 20 players online:"]]), 420);
    } else {
      later(() => pushLog(instanceId, [["stdout", `[12:53:40] [Server thread/INFO]: Unknown or incomplete command, see below for error`], ["stderr", `[12:53:40] [Server thread/INFO]: ${draft}<--[HERE]`]]), 420);
    }
  }, [commandDrafts, instances, pushLog, later]);

  const reset = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setInstances(DEFAULTS.instances());
    setLogsByInstance(DEFAULTS.logs());
    setMessages(initialMessages());
    setInput("");
    setBusy(false);
    setActiveInstanceId("moss-valley");
    setView("dashboard");
    setNotice("演示已重置");
  }, []);

  const activeInstance = instances.find((item) => item.id === activeInstanceId) || instances[0] || null;
  const placeholder = busy ? "可以先草拟下一条消息…" : "描述你想做的事：部署整合包、启动实例、排查崩溃…";

  return (
    <div className="prototype-shell">
      <PrototypeHeader view={view} setView={setView} onReset={reset} />

      {view === "dashboard" ? (
        <DashboardView
          instances={instances}
          messages={messages}
          input={input}
          busy={busy}
          autoConfirm={autoConfirm}
          setAutoConfirm={setAutoConfirm}
          chatRef={chatRef}
          onOpen={openConsole}
          onQuickStart={quickStart}
          onCreate={(text) => send(text)}
          onSend={() => send()}
          onInput={setInput}
          onStop={stop}
          onJump={openConsole}
          placeholder={placeholder}
        />
      ) : (
        <ConsoleView
          instance={activeInstance}
          instances={instances}
          logs={logsByInstance[activeInstanceId] || []}
          messages={messages}
          input={input}
          busy={busy}
          autoConfirm={autoConfirm}
          setAutoConfirm={setAutoConfirm}
          chatRef={chatRef}
          spotlight={spotlight}
          command={commandDrafts[activeInstanceId] || ""}
          onCommand={(value) => setCommandDrafts((current) => ({ ...current, [activeInstanceId]: value }))}
          onSendCommand={() => sendCommand(activeInstanceId)}
          onSend={() => send()}
          onInput={setInput}
          onStop={stop}
          onJump={openConsole}
          onBack={() => setView("dashboard")}
          onQuickStart={quickStart}
          onStopRequest={() => send(activeInstance ? `帮我关闭${activeInstance.name}` : "帮我关闭实例")}
          onCreate={(text) => send(text)}
          placeholder={placeholder}
        />
      )}

      {notice ? (
        <div className="toast" role="status">{notice}</div>
      ) : null}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
