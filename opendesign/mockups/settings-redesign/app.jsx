/* 应用外壳：统一状态、脏值追踪、保存/放弃、toast。三个方向共用同一份状态，
   所以切方向时改动会保留，方便对比同一条配置在不同布局下的手感。 */

const { useState, useEffect, useCallback } = React;

/* 手风琴分节 → 脏值前缀。方向二用它判断某一节是否有未保存改动。 */
window.SECTION_PREFIXES = {
  model: ["model."],
  agent: ["agent.autoConfirm", "agent.memoryMb"],
  network: ["agent.downloadProxy", "providerKeys."],
  java: ["javaVersionToInstall", "javaDownloadSource"],
  skills: ["skills."],
  runtime: ["instance.name", "instance.java", "instance.minMemory", "instance.maxMemory"],
  launch: ["instance.jarFile", "instance.startArgs", "instance.startupCommand"],
  prompt: ["instance.useGlobalPrompt", "instance.promptOverride", "globalPrompt"]
};

function buildInitialState() {
  return {
    ...window.INITIAL_STATE,
    reasoningEffort: "high",
    globalPrompt: window.GLOBAL_PROMPT,
    /* ServerRecord 的可变字段，方向二/三的实例作用域用 */
    instance: {
      id: "survival",
      name: "生存服 · Moss Valley",
      javaVersion: "21",
      javaPath: "",
      minMemory: "1G",
      maxMemory: "4G",
      jarFile: "server.jar",
      startArgs: "nogui",
      startupCommand: "{java} -Xms{minMemory} -Xmx{maxMemory} -jar {jarFile} {startArgs}",
      useGlobalPrompt: true,
      promptOverride: ""
    },
    /* 进行中的 Java 安装任务，键是版本号 */
    javaTasks: {}
  };
}

function setPath(source, path, value) {
  const keys = path.split(".");
  const next = { ...source };
  let cursor = next;
  for (let index = 0; index < keys.length - 1; index += 1) {
    cursor[keys[index]] = { ...cursor[keys[index]] };
    cursor = cursor[keys[index]];
  }
  cursor[keys[keys.length - 1]] = value;
  return next;
}

function App() {
  const [direction, setDirection] = useState(
    () => localStorage.getItem("settings-direction") || "docked"
  );
  const [tab, setTab] = useState("model");
  const [state, setState] = useState(buildInitialState);
  const [dirty, setDirty] = useState({});
  const [notice, setNotice] = useState("");

  const dirtyCount = Object.keys(dirty).length;

  useEffect(() => {
    localStorage.setItem("settings-direction", direction);
  }, [direction]);

  useEffect(() => {
    if (window.lucide) window.lucide.createIcons({ attrs: { "stroke-width": "2.25" } });
  });

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(""), 2600);
    return () => clearTimeout(timer);
  }, [notice]);

  /* 离开页面前提醒未保存改动。原型里只是 console 记录，不真的拦截。 */
  useEffect(() => {
    if (dirtyCount === 0) return undefined;
    const handler = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirtyCount]);

  const notify = useCallback((message) => setNotice(message), []);

  const patch = useCallback((path, value) => {
    /* skills.<id>.enabled 走单独分支，因为 skills 是数组 */
    if (path.startsWith("skills.")) {
      const skillId = path.split(".")[1];
      setState((current) => ({
        ...current,
        skills: current.skills.map((skill) =>
          skill.id === skillId ? { ...skill, enabled: value } : skill
        )
      }));
    } else {
      setState((current) => setPath(current, path, value));
    }
    setDirty((current) => ({ ...current, [path]: true }));
  }, []);

  const save = useCallback(() => {
    setState((current) => {
      let next = current;
      /* 保存后 Key 草稿转成掩码提示，模拟后端只回传 hint 的行为 */
      if (current.model.apiKeyDraft) {
        next = setPath(next, "model.apiKeyHint", window.maskSecret(current.model.apiKeyDraft));
        next = setPath(next, "model.apiKeyDraft", "");
      }
      if (current.providerKeys.curseForgeApiKeyDraft) {
        next = setPath(next, "providerKeys.curseForgeApiKeyHint", window.maskSecret(current.providerKeys.curseForgeApiKeyDraft));
        next = setPath(next, "providerKeys.curseForgeApiKeyConfigured", true);
        next = setPath(next, "providerKeys.curseForgeApiKeyDraft", "");
      }
      if (current.providerKeys.modrinthApiKeyDraft) {
        next = setPath(next, "providerKeys.modrinthApiKeyHint", window.maskSecret(current.providerKeys.modrinthApiKeyDraft));
        next = setPath(next, "providerKeys.modrinthApiKeyConfigured", true);
        next = setPath(next, "providerKeys.modrinthApiKeyDraft", "");
      }
      return next;
    });
    setNotice(`已保存 ${dirtyCount} 项配置`);
    setDirty({});
  }, [dirtyCount]);

  const discard = useCallback(() => {
    setState(buildInitialState());
    setDirty({});
    setNotice("已放弃未保存的改动");
  }, []);

  const shared = { state, patch, dirty, dirtyCount, save, discard, notify, tab, setTab };

  return (
    <div className="prototype-shell">
      <PrototypeHeader direction={direction} setDirection={setDirection} dirtyCount={dirtyCount} />
      {direction === "docked" && <DockedSettings {...shared} />}
      {direction === "sheet" && <ContextSheet {...shared} />}
      {direction === "ledger" && <ConfigLedger {...shared} />}
      {notice ? (
        <div className="toast" role="status">
          {notice}
        </div>
      ) : null}
    </div>
  );
}

/* security/encrypt.ts maskSecret 的前端等价物 */
window.maskSecret = function maskSecret(value) {
  if (!value) return "未配置";
  if (value.startsWith("sk-")) return "sk-xxxxxxxx";
  return `${value.slice(0, 3)}xxxxxxxx`;
};

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
