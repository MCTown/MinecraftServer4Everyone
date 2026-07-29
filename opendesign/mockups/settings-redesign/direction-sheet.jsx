/* 方向二 Context Sheet：设置作为右侧抽屉压在工作区上，不跳走。
   带作用域切换（全局 / 本实例），手风琴分节，改动即时生效并可撤销。 */

function ContextSheet(props) {
  const { state, patch, dirty, dirtyCount, save, discard, notify } = props;
  const [scope, setScope] = React.useState("global");
  const [open, setOpen] = React.useState("model");
  const [serverId, setServerId] = React.useState("survival");
  const server = window.SERVERS.find((item) => item.id === serverId);

  const toggle = (id) => setOpen((current) => (current === id ? "" : id));
  const globalSections = [
    { id: "model", label: "模型接入", meta: state.model.modelName },
    { id: "agent", label: "Agent 行为", meta: state.agent.autoConfirm ? "自动确认开启" : "逐次确认" },
    { id: "network", label: "网络与凭据", meta: state.agent.downloadProxyEnabled ? "代理已启用" : "直连" },
    { id: "java", label: "Java 运行时", meta: `${window.JAVA_VERSIONS.filter((r) => r.installed).length} 个已安装` },
    { id: "skills", label: "Skills", meta: `${state.skills.filter((s) => s.enabled).length} 个启用` }
  ];
  const instanceSections = [
    { id: "runtime", label: "运行参数", meta: `${state.instance.maxMemory} · Java ${state.instance.javaVersion}` },
    { id: "launch", label: "启动方式", meta: state.instance.jarFile },
    { id: "prompt", label: "实例 Prompt", meta: state.instance.useGlobalPrompt ? "继承全局" : "已覆盖" }
  ];
  const sections = scope === "global" ? globalSections : instanceSections;

  return (
    <div className="sheet-workspace">
      <section className="sheet-backdrop" aria-hidden="true">
        <header className="backdrop-topbar">
          <div>
            <div className="breadcrumb">WORKSPACE / {serverId.toUpperCase()}</div>
            <h1 className="settings-title">{server.name}</h1>
          </div>
          <span className="pill ok">{server.state}</span>
        </header>
        <div className="backdrop-body">
          <div className="faux-chat">
            <div className="faux-message">
              <span className="faux-avatar">A/</span>
              <div className="faux-bubble">
                我需要从 CurseForge 下载 3 个模组，但当前没有可用的 API Key。填好之后我会继续，不用重开任务。
              </div>
            </div>
            <div className="faux-message user">
              <span className="faux-avatar">你</span>
              <div className="faux-bubble">顺便把最大内存提到 6G。</div>
            </div>
            <div className="faux-message">
              <span className="faux-avatar">A/</span>
              <div className="faux-bubble">
                内存改动会重写 <code>user_jvm_args.txt</code>，下次启动生效。我已经把设置面板停在对应位置。
              </div>
            </div>
          </div>
          <div className="faux-console">
            <div>[10:44:08] INFO Preparing spawn area: 92%</div>
            <div>[10:44:01] INFO Done (3.421s)! For help, type "help"</div>
            <div>[10:43:55] WARN Can't keep up! Is the server overloaded?</div>
          </div>
          <div className="backdrop-veil" />
        </div>
      </section>

      <aside className="sheet" role="dialog" aria-label="设置">
        <div className="sheet-head">
          <div className="sheet-head-top">
            <div>
              <span className="panel-label">Settings</span>
              <h2>{scope === "global" ? "平台配置" : "实例配置"}</h2>
            </div>
            <button className="btn ghost small" onClick={() => notify("原型：关闭设置抽屉")}>
              收起
            </button>
          </div>
          <div className="sheet-scope">
            <span className="panel-label">作用域</span>
            <div className="sheet-scope-toggle">
              <button className={scope === "global" ? "active" : ""} onClick={() => { setScope("global"); setOpen("model"); }}>
                全局
              </button>
              <button className={scope === "instance" ? "active" : ""} onClick={() => { setScope("instance"); setOpen("runtime"); }}>
                本实例
              </button>
            </div>
          </div>
          {scope === "instance" ? (
            <label className="field" style={{ marginTop: 12, marginBottom: 0 }}>
              <span className="field-label">
                <strong>目标实例</strong>
                <code className="field-key">servers.id</code>
              </span>
              <select className="control" value={serverId} onChange={(event) => setServerId(event.target.value)}>
                {window.SERVERS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>

        <div className="sheet-body">
          {scope === "instance" && server.state === "运行中" ? (
            <div className="callout warn" style={{ marginBottom: 12 }}>
              <p>
                该实例正在运行。内存、Java 与启动指令的改动会保存，但要到下次启动才生效。
              </p>
            </div>
          ) : null}

          {sections.map((section) => {
            const isOpen = open === section.id;
            const prefixes = window.SECTION_PREFIXES[section.id] || [];
            const touched = Object.keys(dirty).some((key) =>
              prefixes.some((prefix) => key.startsWith(prefix))
            );
            return (
              <div className={`accordion ${isOpen ? "open" : ""}`} key={section.id}>
                <button className="accordion-trigger" onClick={() => toggle(section.id)} aria-expanded={isOpen}>
                  <span className="accordion-caret">▸</span>
                  <strong>{section.label}</strong>
                  <span className="accordion-meta">
                    {touched ? <span className="pill warn">改动</span> : null}
                    <span className="field-key">{section.meta}</span>
                  </span>
                </button>
                {isOpen ? (
                  <div className="accordion-panel">
                    <SheetPanel
                      id={section.id}
                      state={state}
                      patch={patch}
                      notify={notify}
                      server={server}
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="sheet-foot">
          <span className="savebar-text">
            {dirtyCount > 0 ? (
              <>
                <strong>{dirtyCount}</strong> 项待保存
              </>
            ) : (
              "已与 SQLite 同步"
            )}
          </span>
          <div className="savebar-actions">
            <button className="btn ghost small" onClick={discard} disabled={dirtyCount === 0}>
              撤销
            </button>
            <button className="btn primary small" onClick={save} disabled={dirtyCount === 0}>
              保存
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}

function SheetPanel({ id, state, patch, notify, server }) {
  if (id === "model") {
    return (
      <div>
        <Field label="模型名称" dbKey="model_name">
          <input
            className="control mono"
            value={state.model.modelName}
            onChange={(event) => patch("model.modelName", event.target.value)}
          />
        </Field>
        <Field label="Base URL" dbKey="base_url">
          <input
            className="control mono"
            value={state.model.baseUrl}
            onChange={(event) => patch("model.baseUrl", event.target.value)}
          />
        </Field>
        <ContextField value={state.model.contextSizeK} onChange={(value) => patch("model.contextSizeK", value)} />
        <SecretField
          label="API Key"
          hint="覆盖写入，不回传明文。"
          hintValue={state.model.apiKeyHint}
          configured
          draft={state.model.apiKeyDraft}
          onChange={(value) => patch("model.apiKeyDraft", value)}
        />
        <button className="btn small" onClick={() => notify("原型：测试模型连通性")}>
          测试连通性
        </button>
      </div>
    );
  }

  if (id === "agent") {
    return (
      <div>
        <SwitchRow
          label="自动确认写操作"
          description="关闭时每次写入都会在对话里等你点确认。"
          checked={state.agent.autoConfirm}
          onChange={(value) => patch("agent.autoConfirm", value)}
        />
        <div style={{ marginTop: 14 }}>
          <MemoryField
            value={state.agent.memoryMb}
            systemMemoryMb={state.agent.systemMemoryMb}
            onChange={(value) => patch("agent.memoryMb", value)}
          />
        </div>
        <div className="callout" style={{ marginTop: 14 }}>
          <p>这是推荐值，只在新建实例时套用。已有实例要在「本实例 → 运行参数」里改。</p>
        </div>
      </div>
    );
  }

  if (id === "network") {
    return (
      <div>
        <SwitchRow
          label="下载代理"
          description="覆盖联网工具、Java 安装、Forge installer 与服务端进程。模型请求不走这里。"
          checked={state.agent.downloadProxyEnabled}
          onChange={(value) => patch("agent.downloadProxyEnabled", value)}
        />
        <div style={{ marginTop: 14 }}>
          <Field label="代理地址" dbKey="agent_download_proxy_url" hint="仅 HTTP / HTTPS。">
            <div className="control-row">
              <input
                className="control mono"
                value={state.agent.downloadProxyUrl}
                disabled={!state.agent.downloadProxyEnabled}
                onChange={(event) => patch("agent.downloadProxyUrl", event.target.value)}
              />
              <button
                className="btn small"
                disabled={!state.agent.downloadProxyEnabled}
                onClick={() => notify("原型：检测代理连通性")}
              >
                检测
              </button>
            </div>
          </Field>
        </div>
        <SecretField
          label="CurseForge API Key"
          hint="模组下载工具必填。"
          hintValue={state.providerKeys.curseForgeApiKeyHint}
          configured={state.providerKeys.curseForgeApiKeyConfigured}
          draft={state.providerKeys.curseForgeApiKeyDraft}
          onChange={(value) => patch("providerKeys.curseForgeApiKeyDraft", value)}
          helpUrl="https://console.curseforge.com/?#/api-keys"
        />
        <SecretField
          label="Modrinth PAT"
          hint="可选。"
          hintValue={state.providerKeys.modrinthApiKeyHint}
          configured={state.providerKeys.modrinthApiKeyConfigured}
          draft={state.providerKeys.modrinthApiKeyDraft}
          onChange={(value) => patch("providerKeys.modrinthApiKeyDraft", value)}
          helpUrl="https://modrinth.com/settings/pats"
        />
      </div>
    );
  }

  if (id === "java") {
    return (
      <div>
        {window.JAVA_VERSIONS.filter((record) => record.installed || record.lts).map((record) => (
          <JavaVersionRow
            key={record.version}
            record={record}
            task={state.javaTasks[record.version]}
            onInstall={(version) => notify(`原型：安装 Java ${version}`)}
            onCancel={(version) => notify(`原型：取消安装 Java ${version}`)}
          />
        ))}
        <span className="field-hint">只列出 LTS 与已安装版本。完整列表在全页设置里。</span>
      </div>
    );
  }

  if (id === "skills") {
    return (
      <div>
        {state.skills.map((skill) => (
          <SkillCard
            key={skill.id}
            skill={skill}
            onToggle={() => patch(`skills.${skill.id}.enabled`, !skill.enabled)}
          />
        ))}
      </div>
    );
  }

  if (id === "runtime") {
    return (
      <div>
        <Field label="服务端名字" dbKey="name">
          <input
            className="control"
            value={state.instance.name}
            onChange={(event) => patch("instance.name", event.target.value)}
          />
        </Field>
        <Field label="Java 版本" dbKey="java_version" hint="只能选已安装的版本。">
          <select
            className="control mono"
            value={state.instance.javaVersion}
            onChange={(event) => patch("instance.javaVersion", event.target.value)}
          >
            {window.JAVA_VERSIONS.filter((record) => record.installed).map((record) => (
              <option key={record.version} value={record.version}>
                Java {record.version}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Java 可执行路径"
          dbKey="java_path"
          hint="留空则按所选版本自动解析到 workspace/jdks。"
        >
          <input
            className="control mono"
            placeholder="留空自动解析"
            value={state.instance.javaPath}
            onChange={(event) => patch("instance.javaPath", event.target.value)}
          />
        </Field>
        <div className="field-grid">
          <Field label="最小内存" dbKey="min_memory">
            <input
              className="control mono"
              value={state.instance.minMemory}
              onChange={(event) => patch("instance.minMemory", event.target.value)}
            />
          </Field>
          <Field label="最大内存" dbKey="max_memory">
            <input
              className="control mono"
              value={state.instance.maxMemory}
              onChange={(event) => patch("instance.maxMemory", event.target.value)}
            />
          </Field>
        </div>
        <span className="field-hint">
          两者会写成 -Xms / -Xmx，并同步到服务端根目录和 server/ 下的 user_jvm_args.txt。
        </span>
      </div>
    );
  }

  if (id === "launch") {
    return (
      <div>
        <div className="field-grid">
          <Field label="服务端 Jar" dbKey="jar_file">
            <input
              className="control mono"
              value={state.instance.jarFile}
              onChange={(event) => patch("instance.jarFile", event.target.value)}
            />
          </Field>
          <Field label="附加参数" dbKey="start_args">
            <input
              className="control mono"
              value={state.instance.startArgs}
              onChange={(event) => patch("instance.startArgs", event.target.value)}
            />
          </Field>
        </div>
        <Field
          label="启动指令"
          dbKey="startup_command"
          hint="留空则由 Jar、内存和附加参数拼装。占位符：{java} {javaHome} {python} {workspace} {serverDir} {minMemory} {maxMemory} {jarFile} {startArgs}"
        >
          <textarea
            className="control mono"
            value={state.instance.startupCommand}
            onChange={(event) => patch("instance.startupCommand", event.target.value)}
          />
        </Field>
      </div>
    );
  }

  return (
    <div>
      <SwitchRow
        label="使用全局 Prompt"
        description="关闭后该实例使用下面的覆盖内容。"
        checked={state.instance.useGlobalPrompt}
        onChange={(value) => patch("instance.useGlobalPrompt", value)}
      />
      <div style={{ marginTop: 14 }}>
        <Field label="实例 Prompt 覆盖" dbKey="prompt_override">
          <textarea
            className="control mono"
            style={{ minHeight: 150 }}
            placeholder={state.instance.useGlobalPrompt ? "启用全局 Prompt 时不生效" : "写入该实例专属指令"}
            disabled={state.instance.useGlobalPrompt}
            value={state.instance.promptOverride}
            onChange={(event) => patch("instance.promptOverride", event.target.value)}
          />
        </Field>
      </div>
    </div>
  );
}
