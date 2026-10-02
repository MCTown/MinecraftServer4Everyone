/* 视图二：实例操作台。
   左侧是 Agent 对话记录（含执行活动行），右侧是该实例的实时终端。
   顶部可切换实例、执行启停操作；从主界面跳转过来时高亮对应实例。 */

function InstanceTabs({ instances, activeId, spotlight, onSelect }) {
  return (
    <div className="instance-tabs" role="tablist" aria-label="实例切换">
      {instances.map((instance) => (
        <button
          key={instance.id}
          role="tab"
          aria-selected={instance.id === activeId}
          className={`instance-tab ${instance.id === activeId ? "active" : ""} ${spotlight === instance.id ? "spotlight" : ""}`}
          onClick={() => onSelect(instance.id)}
        >
          <span className={`tab-dot tone-${window.fmt.statusTone(instance.status)}`} />
          <span className="tab-name">{instance.name}</span>
          <span className="tab-state">{window.fmt.status(instance.status)}</span>
        </button>
      ))}
    </div>
  );
}

function ConsoleView(props) {
  const { instance, instances, logs, messages, input, busy, autoConfirm, setAutoConfirm, chatRef, spotlight } = props;
  if (!instance) return null;

  const canStart = instance.status === "stopped" || instance.status === "crashed";
  const canStop = instance.status === "running" || instance.status === "starting" || instance.status === "orphaned";

  return (
    <main className="workspace-console">
      <header className="console-topbar">
        <div className="topbar-left">
          <button className="ghost-button" onClick={props.onBack}>
            <Icon name="arrow-left" size={15} />
            返回主界面
          </button>
          <div className="topbar-divider" />
          <div className="topbar-title">
            <p className="eyebrow">INSTANCE / {instance.id}</p>
            <h1>{instance.name}</h1>
          </div>
          <StatusPill status={instance.status} />
        </div>

        <div className="topbar-actions">
          <button className="primary" disabled={!canStart || busy} onClick={() => props.onQuickStart ? props.onQuickStart(instance.id) : null}>
            <Icon name="play" size={15} />
            启动
          </button>
          <button disabled={!canStop || busy} onClick={() => props.onStopRequest && props.onStopRequest()}>
            <Icon name="square" size={15} />
            停止
          </button>
          <button disabled>
            <Icon name="rotate-cw" size={15} />
            重启
          </button>
          <button className="danger" disabled={!canStop}>
            <Icon name="power" size={15} />
            强制结束
          </button>
          <button className="ghost-button" disabled>
            <Icon name="folder" size={15} />
            文件
          </button>
          <button className="ghost-button" disabled>
            <Icon name="sliders-horizontal" size={15} />
            配置
          </button>
        </div>
      </header>

      <InstanceTabs instances={instances} activeId={instance.id} spotlight={spotlight} onSelect={props.onJump} />

      <div className="console-grid">
        <section className="conversation card">
          <header className="conversation-head">
            <span className="agent-avatar"><Icon name="sparkles" size={15} /></span>
            <div className="conversation-title">
              <strong>Agent 对话记录</strong>
              <p className="mono">全局会话 · 正在操作 {instance.name}</p>
            </div>
            <span className={`session-status ${busy ? "busy" : "idle"}`}>
              <i className={busy ? "dot pulse" : "dot"} />
              {busy ? "执行中" : "待命"}
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
        </section>

        <section className={`terminal-card card ${spotlight === instance.id ? "spotlight" : ""}`}>
          <Terminal
            instance={instance}
            logs={logs}
            command={props.command}
            onCommand={props.onCommand}
            onSend={props.onSendCommand}
            onRefresh={() => undefined}
          />
        </section>
      </div>
    </main>
  );
}

window.ConsoleView = ConsoleView;
