/* 共享展示组件：图标、状态标签、实例卡片、终端、消息气泡、输入串。
   纯展示，不含业务状态；业务状态都在 app.jsx 里。 */

function Icon({ name, size = 16, className = "", spin = false }) {
  return (
    <i
      data-lucide={name}
      className={className}
      style={{ width: size, height: size, ...(spin ? { animation: "spin 1s linear infinite" } : null) }}
      aria-hidden="true"
    />
  );
}

function StatusPill({ status, label, pulse = false }) {
  const tone = window.fmt.statusTone(status);
  return (
    <span className={`status-pill ${tone}`}>
      <i className={pulse ? "dot pulse" : "dot"} />
      {label || window.fmt.status(status)}
    </span>
  );
}

function PrototypeHeader({ view, setView, onReset }) {
  return (
    <header className="prototype-header">
      <div className="brand-lockup">
        <div className="brand-mark">MC</div>
        <div>
          <div className="brand-name">MCTManager</div>
          <div className="brand-sub">dashboard</div>
        </div>
      </div>
      <nav className="view-tabs" aria-label="原型视图">
        {window.VIEWS.map((item) => (
          <button
            key={item.id}
            className={`view-tab ${view === item.id ? "active" : ""}`}
            onClick={() => setView(item.id)}
            title={item.hint}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="header-meta">
        <span className="connection">
          <i className="status-dot" />
          后端已连接
        </span>
        <button className="ghost-button" onClick={onReset} title="把原型恢复到初始状态">
          <Icon name="rotate-cw" size={14} />
          重置演示
        </button>
        <span className="avatar">AM</span>
      </div>
    </header>
  );
}

function InstanceCard({ instance, active, busy, onOpen, onQuickStart }) {
  const empty = instance.status === "empty";
  const canStart = instance.status === "stopped" || instance.status === "crashed";
  return (
    <article className={`instance-card ${active ? "active" : ""}`} data-instance={instance.id}>
      <div className="instance-card-head">
        <span className={`instance-avatar tone-${window.fmt.statusTone(instance.status)}`}>{instance.initial}</span>
        <div className="instance-card-title">
          <h3>{instance.name}</h3>
          <p className="mono">{instance.kind}</p>
        </div>
        <StatusPill status={instance.status} pulse={busy} />
      </div>

      <dl className="instance-facts">
        <div>
          <dt>版本</dt>
          <dd>{empty ? "—" : instance.minecraft}</dd>
        </div>
        <div>
          <dt>内存</dt>
          <dd>{empty ? "待分配" : instance.memory}</dd>
        </div>
        <div>
          <dt>{empty ? "目录" : "在线"}</dt>
          <dd>{empty ? "空" : instance.players}</dd>
        </div>
      </dl>

      {instance.recommended ? (
        <p className="instance-reason">
          <Icon name="sparkles" size={13} />
          {instance.reason}
        </p>
      ) : (
        <p className="instance-reason muted">{instance.reason}</p>
      )}

      <div className="instance-card-actions">
        <button className="primary" onClick={() => onOpen(instance.id)}>
          <Icon name="arrow-right" size={15} />
          打开实例
        </button>
        {canStart ? (
          <button className="ghost-button" disabled={busy} onClick={() => onQuickStart(instance.id)}>
            <Icon name={busy ? "loader" : "play"} size={15} spin={busy} />
            {instance.status === "crashed" ? "诊断并启动" : "启动"}
          </button>
        ) : null}
      </div>
    </article>
  );
}

function EmptyInstanceCard({ onCreate }) {
  return (
    <article className="instance-card ghost">
      <div className="instance-card-head">
        <span className="instance-avatar tone-idle">+</span>
        <div className="instance-card-title">
          <h3>创建新实例</h3>
          <p className="mono">交给 Agent 从零部署</p>
        </div>
      </div>
      <p className="instance-reason muted">直接在上面的对话框里说“帮我开一个 1.20.1 的生存服”，Agent 会建实例、装 Java、套模板、写 EULA。</p>
      <div className="instance-card-actions">
        <button className="ghost-button" onClick={onCreate}>
          <Icon name="plus" size={15} />
          用对话创建
        </button>
      </div>
    </article>
  );
}

/* 终端：等宽输出 + 行内高亮 + 底部命令输入。 */
function Terminal({ instance, logs, command, onCommand, onSend, onRefresh, compact = false }) {
  const listRef = React.useRef(null);
  React.useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [logs.length, instance && instance.id]);

  return (
    <div className={`terminal ${compact ? "compact" : ""}`}>
      <div className="terminal-head">
        <div className="terminal-title">
          <Icon name="terminal" size={15} />
          <strong>{instance ? instance.name : "实例终端"}</strong>
          {instance ? <StatusPill status={instance.status} /> : null}
        </div>
        <div className="terminal-actions">
          <button className="icon-button" title="刷新日志" aria-label="刷新日志" onClick={onRefresh}>
            <Icon name="rotate-cw" size={14} />
          </button>
          <span className="mono terminal-path">{instance ? instance.directory : "—"}</span>
        </div>
      </div>

      <div className="terminal-body" ref={listRef}>
        {logs.length === 0 ? (
          <p className="terminal-empty">暂无输出。实例启动后会在这里实时显示控制台日志。</p>
        ) : null}
        {logs.map((line, index) => (
          <div className={`terminal-line ${line[0]}`} key={`${index}-${line[1].slice(0, 12)}`}>
            <span className="terminal-stream">{line[0] === "stderr" ? "ERR" : line[0] === "system" ? "SYS" : "OUT"}</span>
            <span className="terminal-text">{line[1]}</span>
          </div>
        ))}
      </div>

      <form
        className="terminal-command"
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
      >
        <span className="prompt-char">&gt;</span>
        <input
          value={command}
          placeholder="输入服务端控制台指令，例如 list"
          aria-label="服务端控制台指令"
          onChange={(event) => onCommand(event.target.value)}
        />
        <button className="primary" type="submit" disabled={!command.trim()}>
          <Icon name="send" size={14} />
          发送
        </button>
      </form>
    </div>
  );
}

function MessageBubble({ message, onJump }) {
  const { role, content, status, activity, createdAt, targetInstanceId } = message;

  if (activity) {
    const running = activity.status === "running" || activity.status === "waiting_confirmation";
    return (
      <div className={`activity-row ${activity.status}`}>
        <span className={`activity-icon ${running ? "spinning" : ""}`}>
          <Icon name={activity.status === "failed" ? "triangle-alert" : activity.status === "completed" ? "check" : "loader"} size={13} />
        </span>
        <div>
          <strong>{activity.title}</strong>
          {activity.toolName ? <code className="mono">{activity.toolName}</code> : null}
          {activity.detail ? <p>{activity.detail}</p> : null}
        </div>
        {activity.status === "completed" ? <span className="activity-state ok">完成</span> : null}
        {activity.status === "running" ? <span className="activity-state">执行中</span> : null}
      </div>
    );
  }

  if (role === "user") {
    return (
      <div className="message-row user">
        <div className="bubble user">
          <p>{content}</p>
          <time className="mono">{window.fmt.time(createdAt)}</time>
        </div>
        <span className="avatar small">AM</span>
      </div>
    );
  }

  const failed = status === "failed";
  return (
    <div className={`message-row agent ${failed ? "failed" : ""}`}>
      <span className="agent-avatar"><Icon name="sparkles" size={14} /></span>
      <div className="bubble agent">
        {failed ? (
          <div className="bubble-error">
            <strong>
              <Icon name="triangle-alert" size={13} />
              执行失败
            </strong>
            <p>{content}</p>
          </div>
        ) : (
          <p>{content}</p>
        )}
        {targetInstanceId ? (
          <button className="jump-chip" onClick={() => onJump(targetInstanceId)}>
            <Icon name="terminal" size={13} />
            已跳转到「{window.INSTANCE_NAMES[targetInstanceId] || targetInstanceId}」· 查看终端
            <Icon name="chevron-right" size={13} />
          </button>
        ) : null}
        <time className="mono">{window.fmt.time(createdAt)}</time>
      </div>
    </div>
  );
}

function Composer({ value, onChange, onSend, busy, onStop, placeholder, quickPrompts, onQuick, autoConfirm, setAutoConfirm }) {
  const inputRef = React.useRef(null);
  return (
    <div className="composer">
      <div className="composer-quick">
        {quickPrompts.map((prompt) => (
          <button key={prompt.label} className="quick-chip" disabled={busy} onClick={() => onQuick(prompt.text)}>
            <Icon name={prompt.icon} size={13} />
            {prompt.label}
          </button>
        ))}
      </div>
      <div className="composer-shell">
        <textarea
          ref={inputRef}
          rows={2}
          value={value}
          placeholder={placeholder || "描述你想做的事：部署整合包、启动实例、排查崩溃…"}
          aria-label="发送给 Agent 的消息"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (!busy) onSend();
            }
          }}
        />
        <div className="composer-footer">
          <div className="composer-tools">
            <span className="mono composer-scope">
              <Icon name="globe" size={13} />
              全局会话
            </span>
            <label className="auto-confirm">
              <input type="checkbox" checked={autoConfirm} onChange={(event) => setAutoConfirm(event.target.checked)} />
              <span>自动确认操作</span>
            </label>
          </div>
          {busy ? (
            <button className="stop-button" onClick={onStop} title="中断任务">
              <Icon name="square" size={15} />
              中断
            </button>
          ) : (
            <button className="send-button" disabled={!value.trim()} onClick={onSend} title="发送 (Enter)">
              <Icon name="send" size={15} />
              发送
            </button>
          )}
        </div>
      </div>
      <p className="composer-hint">Enter 发送 · Shift + Enter 换行 · 涉及具体实例的操作会自动跳到该实例</p>
    </div>
  );
}

function SuggestionRow({ onCreate }) {
  const suggestions = [
    { icon: "rocket", title: "从零建一个服", text: "带我去看 Agent 怎么建实例并部署服务端" },
    { icon: "triangle-alert", title: "处理异常实例", text: "匠造工坊崩了，先修好它" },
    { icon: "activity", title: "全部巡检", text: "帮我巡检所有实例的健康状况" }
  ];
  return (
    <div className="suggestion-row">
      {suggestions.map((item) => (
        <button key={item.title} className="suggestion" onClick={() => onCreate(item.text)}>
          <Icon name={item.icon} size={15} />
          <span>
            <strong>{item.title}</strong>
            <small>{item.text}</small>
          </span>
        </button>
      ))}
    </div>
  );
}

window.Icon = Icon;
window.StatusPill = StatusPill;
window.PrototypeHeader = PrototypeHeader;
window.InstanceCard = InstanceCard;
window.EmptyInstanceCard = EmptyInstanceCard;
window.Terminal = Terminal;
window.MessageBubble = MessageBubble;
window.Composer = Composer;
window.SuggestionRow = SuggestionRow;
