/* 视图一：主界面 Dashboard。
   大欢迎词 → 实例推荐 → 总对话框。对话框嵌在页面主列里（不是浮层），
   左边是对话记录流，点实例卡片或消息里的跳转 chip 会切到实例操作台。 */

function PlatformStats({ instances }) {
  const running = instances.filter((item) => item.status === "running").length;
  const attention = instances.filter((item) => item.status === "crashed" || item.status === "orphaned").length;
  const pending = instances.filter((item) => item.status === "stopped" || item.status === "empty").length;
  const stats = [
    { id: "instances", icon: "server", label: "实例总数", value: String(instances.length), hint: `${pending} 个未运行`, tone: "neutral" },
    { id: "running", icon: "activity", label: "运行中", value: String(running), hint: running ? "实时终端可用" : "当前无实例在跑", tone: running ? "ok" : "neutral" },
    { id: "attention", icon: "triangle-alert", label: "需要处理", value: String(attention), hint: attention ? "存在异常退出的实例" : "一切正常", tone: attention ? "warn" : "ok" },
    { id: "model", icon: "sparkles", label: "Agent 模型", value: "在线", hint: "上下文剩余 82%", tone: "ok" }
  ];
  return (
    <div className="stat-row">
      {stats.map((stat) => (
        <div className={`stat-card tone-${stat.tone}`} key={stat.id}>
          <span className="stat-icon"><Icon name={stat.icon} size={16} /></span>
          <div className="stat-body">
            <span className="stat-label">{stat.label}</span>
            <strong className="stat-value">{stat.value}</strong>
            <span className="stat-hint">{stat.hint}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function DashboardView(props) {
  const { instances, messages, input, busy, autoConfirm, setAutoConfirm, chatRef } = props;
  const recommended = instances.filter((item) => item.recommended);
  const rest = instances.filter((item) => !item.recommended);

  return (
    <main className="dashboard">
      <section className="welcome">
        <div className="welcome-copy">
          <p className="eyebrow">MCTMANAGER · AGENT OPS</p>
          <h1>
            {window.fmt.greeting()}，欢迎回来
          </h1>
          <p className="welcome-sub">
            今天有 <strong>{instances.filter((item) => item.status === "running").length}</strong> 个实例在运行，
            <strong>{instances.filter((item) => item.status === "crashed").length}</strong> 个需要处理。
            你可以直接在下面用一句话开始——建服、部署整合包、巡检或排查崩溃，Agent 会自己挑工具并把结果落到对应实例。
          </p>
        </div>
        <PlatformStats instances={instances} />
      </section>

      <section className="recommend-section">
        <div className="section-head">
          <div>
            <p className="eyebrow">RECOMMENDED</p>
            <h2>实例推荐</h2>
          </div>
          <span className="section-note">按最近活跃度与健康度排序</span>
        </div>
        <div className="instance-grid">
          {recommended.map((instance) => (
            <InstanceCard
              key={instance.id}
              instance={instance}
              active={false}
              busy={instance.status === "starting" || instance.status === "stopping"}
              onOpen={props.onOpen}
              onQuickStart={props.onQuickStart}
            />
          ))}
          {rest.map((instance) => (
            <InstanceCard
              key={instance.id}
              instance={instance}
              active={false}
              busy={instance.status === "starting" || instance.status === "stopping"}
              onOpen={props.onOpen}
              onQuickStart={props.onQuickStart}
            />
          ))}
          <EmptyInstanceCard onCreate={() => props.onCreate("帮我创建一个新实例，用 1.20.1 的生存服")} />
        </div>
      </section>

      <section className="chat-section">
        <div className="section-head">
          <div>
            <p className="eyebrow">AGENT CONSOLE</p>
            <h2>总对话框</h2>
          </div>
          <span className="section-note">全局会话 · 可直接管理任意实例</span>
        </div>

        <div className={`console-panel ${busy ? "busy" : ""}`}>
          <header className="console-panel-head">
            <div className="console-panel-title">
              <span className="agent-avatar"><Icon name="sparkles" size={15} /></span>
              <div>
                <strong>全局 Agent</strong>
                <p className="mono">context · 82% remaining</p>
              </div>
            </div>
            <span className={`session-status ${busy ? "busy" : "idle"}`}>
              <i className={busy ? "dot pulse" : "dot"} />
              {busy ? "正在执行" : "待命"}
            </span>
          </header>

          <div className="message-list" ref={chatRef} aria-live="polite">
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} onJump={props.onJump} />
            ))}
            {busy ? (
              <div className="message-row agent">
                <span className="agent-avatar"><Icon name="sparkles" size={14} /></span>
                <div className="bubble agent typing">
                  <span className="busy-dots"><i /><i /><i /></span>
                  <span>Agent 正在执行…</span>
                </div>
              </div>
            ) : null}
          </div>

          <Composer
            value={input}
            onChange={props.onInput}
            onSend={props.onSend}
            onStop={props.onStop}
            busy={busy}
            autoConfirm={autoConfirm}
            setAutoConfirm={setAutoConfirm}
            quickPrompts={window.QUICK_PROMPTS}
            onQuick={props.onCreate}
            placeholder={props.placeholder}
          />
        </div>
      </section>
    </main>
  );
}

window.DashboardView = DashboardView;
