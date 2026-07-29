/* 方向一 Docked Settings：设置是一个独立全页，左侧五分组导航，底部粘性保存条。
   适合第一次配置和逐项排查。 */

function DockedSettings(props) {
  const { state, patch, tab, setTab, dirty, dirtyCount, save, discard, notify } = props;
  const [modelTest, setModelTest] = React.useState(null);
  const [proxyTest, setProxyTest] = React.useState(null);

  /* 分组 → 脏值键前缀。tools 组改的是 providerKeys.*，java 组改的是安装参数，
     所以不能直接用分组名当前缀。 */
  const tabPrefixes = {
    model: ["model.", "reasoningEffort"],
    skills: ["skills."],
    tools: ["providerKeys."],
    agent: ["agent.", "globalPrompt"],
    java: ["javaVersionToInstall", "javaDownloadSource"]
  };
  const groupDirty = (group) =>
    Object.keys(dirty).some((key) => (tabPrefixes[group] || []).some((prefix) => key.startsWith(prefix)));

  return (
    <div className="settings-workspace">
      <aside className="command-rail">
        <div className="brand-mark">A/</div>
        {[["agent", "A/"], ["files", "[]"], ["logs", ">_"]].map(([id, label]) => (
          <button key={id} className="rail-button" title={id} onClick={() => notify("原型：返回工作区")}>
            {label}
          </button>
        ))}
        <button className="rail-button active" title="settings">
          ::
        </button>
        <div className="rail-spacer" />
        <button className="rail-button" title="help" onClick={() => notify("原型：打开帮助")}>
          ?
        </button>
      </aside>

      <nav className="settings-nav" aria-label="设置分组">
        <div className="settings-nav-head">
          <span className="panel-label">Settings</span>
          <h2>平台配置</h2>
          <div className="brand-sub">global · 影响所有实例</div>
        </div>
        <div className="settings-nav-list">
          {window.NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              className={`settings-nav-item ${tab === item.id ? "active" : ""}`}
              onClick={() => setTab(item.id)}
              aria-current={tab === item.id ? "true" : undefined}
            >
              {groupDirty(item.id) ? <span className="pill warn nav-flag">改动</span> : null}
              <strong>{item.label}</strong>
              <span>{item.desc}</span>
            </button>
          ))}
        </div>
        <div className="settings-nav-foot">
          <p>实例专属配置（Java 路径、内存、启动指令）在实例卡片里改，不在这里。</p>
          <button className="btn small" style={{ width: "100%" }} onClick={() => notify("原型：打开实例配置")}>
            打开实例配置
          </button>
        </div>
      </nav>

      <main className="settings-main">
        <header className="settings-topbar">
          <div>
            <div className="breadcrumb">SETTINGS / {tab.toUpperCase()}</div>
            <h1 className="settings-title">{window.NAV_ITEMS.find((item) => item.id === tab).label}</h1>
          </div>
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap", justifyContent: "flex-end" }}>
            <span className="pill">{dirtyCount > 0 ? `${dirtyCount} 项待保存` : "无改动"}</span>
            <button className="btn ghost" onClick={() => notify("原型：返回 Agent 对话")}>
              返回工作区
            </button>
          </div>
        </header>

        <div className="settings-body">
          <div className="settings-canvas">
            {tab === "model" && (
              <ModelGroup state={state} patch={patch} test={modelTest} setTest={setModelTest} />
            )}
            {tab === "skills" && <SkillsGroup state={state} patch={patch} notify={notify} />}
            {tab === "tools" && <ToolsGroup state={state} patch={patch} notify={notify} />}
            {tab === "agent" && (
              <AgentGroup
                state={state}
                patch={patch}
                notify={notify}
                test={proxyTest}
                setTest={setProxyTest}
              />
            )}
            {tab === "java" && <JavaGroup state={state} patch={patch} notify={notify} />}
          </div>

          {dirtyCount > 0 ? (
            <div className="savebar" role="region" aria-label="未保存的改动">
              <div className="savebar-text">
                <strong>{dirtyCount}</strong> 项改动尚未写入 SQLite。切换分组不会丢失。
              </div>
              <div className="savebar-actions">
                <button className="btn ghost" onClick={discard}>
                  放弃
                </button>
                <button className="btn primary" onClick={save}>
                  <Icon name="check" />
                  保存
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}

function ModelGroup({ state, patch, test, setTest }) {
  const model = state.model;
  return (
    <section className="settings-group">
      <div className="settings-group-head">
        <span className="panel-label">Single model · default_model</span>
        <h3>模型接入</h3>
        <p>
          平台只保留一条模型配置，保存时会删除其他记录。显示名固定为 OpenAI Compatible，请求发往
          <span className="mono"> {model.baseUrl.replace(/\/$/, "")}/chat/completions</span>。
        </p>
      </div>

      <div className="field-grid">
        <Field label="显示名称" dbKey="display_name" hint="固定值，不可修改。">
          <input className="control" value={model.displayName} readOnly />
        </Field>
        <Field label="模型名称" dbKey="model_name">
          <input
            className="control mono"
            value={model.modelName}
            onChange={(event) => patch("model.modelName", event.target.value)}
          />
        </Field>
        <Field
          label="Base URL"
          dbKey="base_url"
          wide
          hint="尾部斜杠会被规范化。仅需填到 /v1，不要带 /chat/completions。"
        >
          <input
            className="control mono"
            value={model.baseUrl}
            onChange={(event) => patch("model.baseUrl", event.target.value)}
          />
        </Field>
        <ContextField value={model.contextSizeK} onChange={(value) => patch("model.contextSizeK", value)} />
        <Field label="思考深度" dbKey="reasoning_effort（不落库）" hint="随每条消息发送，刷新后回到 high。">
          <select
            className="control"
            value={state.reasoningEffort}
            onChange={(event) => patch("reasoningEffort", event.target.value)}
          >
            {["minimal", "low", "medium", "high"].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div style={{ marginTop: 18 }}>
        <SecretField
          label="API Key"
          dbKey="encrypted_api_key · AES-256-GCM"
          hint="只能覆盖写入，后端不回传明文。留空保存则保留现有 Key。"
          hintValue={model.apiKeyHint}
          configured={Boolean(model.apiKeyHint) && model.apiKeyHint !== "未配置"}
          draft={model.apiKeyDraft}
          onChange={(value) => patch("model.apiKeyDraft", value)}
        />
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
        <button
          className="btn"
          onClick={() =>
            setTest({ ok: true, detail: `${model.modelName} 返回 200，往返 412 ms` })
          }
        >
          <Icon name="plug" />
          测试连通性
        </button>
        <span className="field-hint" style={{ marginTop: 9 }}>
          测试会真实调用一次 chat/completions，可能产生费用。
        </span>
      </div>
      <TestResult result={test} />

      <div className="callout" style={{ marginTop: 16 }}>
        <p>
          <strong>轮换 APP_SECRET_KEY 会使已存 API Key 无法解密</strong>，需要重新填写。该变量同时用于登录
          Token 签名。
        </p>
      </div>
    </section>
  );
}

function SkillsGroup({ state, patch, notify }) {
  return (
    <section className="settings-group">
      <div className="settings-group-head">
        <span className="panel-label">skills 表</span>
        <h3>Agent 技能</h3>
        <p>技能是注入给 Agent 的部署流程说明。只有启用开关可改，内容随版本发布。</p>
      </div>
      {state.skills.map((skill) => (
        <SkillCard
          key={skill.id}
          skill={skill}
          onToggle={() => patch(`skills.${skill.id}.enabled`, !skill.enabled)}
        />
      ))}
      <div className="callout warn" style={{ marginTop: 13 }}>
        <p>
          关闭部署 Skill 后，Agent 仍能读写文件，但不再遵循 EULA、Java 版本匹配和启动脚本约定，出错概率明显上升。
        </p>
      </div>
      <button className="btn" style={{ marginTop: 13 }} onClick={() => notify("原型：从目录导入 Skill")}>
        <Icon name="folder-plus" />
        从 workspace/skills 导入
      </button>
    </section>
  );
}

function ToolsGroup({ state, patch, notify }) {
  return (
    <section className="settings-group">
      <div className="settings-group-head">
        <span className="panel-label">tool catalog</span>
        <h3>工具与凭据</h3>
        <p>工具本身不可关闭。这里只处理它们需要的第三方凭据；缺失时部署会停在需要该工具的那一步。</p>
      </div>
      {window.TOOLS.map((tool) => (
        <ToolCard
          key={tool.name}
          tool={tool}
          providerKeys={state.providerKeys}
          onConfigure={() => notify(`原型：打开 ${tool.name} 的凭据对话框`)}
        />
      ))}

      <div style={{ marginTop: 20 }}>
        <SecretField
          label="CurseForge API Key"
          dbKey="curseforge_api_key"
          hint="未配置时回退到环境变量 CURSEFORGE_API_KEY。"
          hintValue={state.providerKeys.curseForgeApiKeyHint}
          configured={state.providerKeys.curseForgeApiKeyConfigured}
          draft={state.providerKeys.curseForgeApiKeyDraft}
          onChange={(value) => patch("providerKeys.curseForgeApiKeyDraft", value)}
          helpUrl="https://console.curseforge.com/?#/api-keys"
        />
        <SecretField
          label="Modrinth PAT"
          dbKey="modrinth_api_key"
          hint="多数下载不需要。仅在工具返回鉴权失败时才需要填。"
          hintValue={state.providerKeys.modrinthApiKeyHint}
          configured={state.providerKeys.modrinthApiKeyConfigured}
          draft={state.providerKeys.modrinthApiKeyDraft}
          onChange={(value) => patch("providerKeys.modrinthApiKeyDraft", value)}
          helpUrl="https://modrinth.com/settings/pats"
        />
      </div>
    </section>
  );
}

function AgentGroup({ state, patch, notify, test, setTest }) {
  const agent = state.agent;
  const [promptOpen, setPromptOpen] = React.useState(false);
  return (
    <section className="settings-group">
      <div className="settings-group-head">
        <span className="panel-label">app_settings</span>
        <h3>Agent 行为</h3>
        <p>这一组决定 Agent 在你不看着的时候能做什么，以及它怎么联网。</p>
      </div>

      <div style={{ marginBottom: 22 }}>
        <SwitchRow
          label="自动确认写操作"
          description="开启后，修改配置、重启、删除文件不再逐次询问。适合已经熟悉流程的场景。"
          checked={agent.autoConfirm}
          onChange={(value) => patch("agent.autoConfirm", value)}
        />
        <SwitchRow
          label="下载代理"
          description="影响联网工具、Java 安装、Forge installer 和服务端进程。不影响模型请求。"
          checked={agent.downloadProxyEnabled}
          onChange={(value) => patch("agent.downloadProxyEnabled", value)}
        />
      </div>

      {agent.autoConfirm ? (
        <div className="callout warn" style={{ marginBottom: 18 }}>
          <p>
            自动确认已开启。Agent 可以在没有二次确认的情况下覆盖 <span className="mono">server.properties</span>、
            重启实例或删除目录内文件。
          </p>
        </div>
      ) : null}

      <MemoryField
        value={agent.memoryMb}
        systemMemoryMb={agent.systemMemoryMb}
        onChange={(value) => patch("agent.memoryMb", value)}
      />

      <Field
        label="代理地址"
        dbKey="agent_download_proxy_url"
        wide
        hint="仅支持 HTTP / HTTPS。socks5 会被后端拒绝。"
      >
        <div className="control-row">
          <input
            className="control mono"
            placeholder="http://127.0.0.1:7890"
            value={agent.downloadProxyUrl}
            disabled={!agent.downloadProxyEnabled}
            onChange={(event) => patch("agent.downloadProxyUrl", event.target.value)}
          />
          <button
            className="btn"
            disabled={!agent.downloadProxyEnabled}
            onClick={() =>
              setTest({
                ok: true,
                detail: "www.google.com 200 · 经代理 · 683 ms"
              })
            }
          >
            检测
          </button>
        </div>
      </Field>
      <TestResult result={test} />

      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-head">
          <div>
            <h4>默认 System Prompt</h4>
            <p>新实例默认继承。实例可以用自己的 Prompt 覆盖。</p>
          </div>
          <div style={{ display: "flex", gap: 7 }}>
            <button className="btn small" onClick={() => setPromptOpen((open) => !open)}>
              {promptOpen ? "收起" : "修改"}
            </button>
            <button className="btn small ghost" onClick={() => notify("原型：已恢复 defaultSystemPrompt")}>
              恢复默认
            </button>
          </div>
        </div>
        {promptOpen ? (
          <textarea
            className="control mono"
            style={{ minHeight: 190 }}
            value={state.globalPrompt}
            onChange={(event) => patch("globalPrompt", event.target.value)}
          />
        ) : (
          <pre
            className="mono"
            style={{
              margin: 0,
              maxHeight: 132,
              overflow: "auto",
              color: "var(--muted)",
              fontSize: 11,
              lineHeight: 1.7,
              whiteSpace: "pre-wrap"
            }}
          >
            {state.globalPrompt}
          </pre>
        )}
      </div>
    </section>
  );
}

function JavaGroup({ state, patch, notify }) {
  return (
    <section className="settings-group">
      <div className="settings-group-head">
        <span className="panel-label">workspace/jdks</span>
        <h3>Java 运行时</h3>
        <p>
          平台不使用系统 Java。每个实例从这里已安装的版本中选一个，启动时按版本解析到受管 JDK 路径。
        </p>
      </div>

      <div className="field-grid">
        <Field label="下载源" dbKey="source">
          <select
            className="control"
            value={state.javaDownloadSource}
            onChange={(event) => patch("javaDownloadSource", event.target.value)}
          >
            {window.JAVA_SOURCES.map((source) => (
              <option key={source.id} value={source.id}>
                {source.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="安装版本" dbKey="version">
          <div className="control-row">
            <select
              className="control mono"
              value={state.javaVersionToInstall}
              onChange={(event) => patch("javaVersionToInstall", event.target.value)}
            >
              {window.JAVA_VERSIONS.map((record) => (
                <option key={record.version} value={record.version}>
                  Java {record.version}
                  {record.lts ? " · LTS" : ""}
                </option>
              ))}
            </select>
            <button className="btn primary" onClick={() => notify(`原型：开始安装 Java ${state.javaVersionToInstall}`)}>
              安装
            </button>
          </div>
        </Field>
      </div>
      <span className="field-hint" style={{ display: "block", marginTop: -6, marginBottom: 18 }}>
        {window.JAVA_SOURCES.find((source) => source.id === state.javaDownloadSource).description}
      </span>

      <div className="section-head" style={{ marginBottom: 12 }}>
        <h2 className="section-title">已安装 / 可安装</h2>
        <span className="panel-label">
          {window.JAVA_VERSIONS.filter((record) => record.installed).length} / {window.JAVA_VERSIONS.length}
        </span>
      </div>
      {window.JAVA_VERSIONS.map((record) => (
        <JavaVersionRow
          key={record.version}
          record={record}
          task={state.javaTasks[record.version]}
          onInstall={(version) => notify(`原型：安装 Java ${version}`)}
          onCancel={(version) => notify(`原型：取消安装 Java ${version}`)}
        />
      ))}
    </section>
  );
}
