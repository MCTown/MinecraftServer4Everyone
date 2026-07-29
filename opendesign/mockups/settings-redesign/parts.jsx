/* 共享组件：header、字段控件、开关行、状态标签 */

function Icon({ name, className = "btn-icon" }) {
  return <i data-lucide={name} className={className} />;
}

function PrototypeHeader({ direction, setDirection, dirtyCount }) {
  return (
    <header className="prototype-header">
      <div className="brand-lockup">
        <div className="brand-mark">A/</div>
        <div>
          <div className="brand-name">Server Agent</div>
          <div className="brand-sub">settings</div>
        </div>
      </div>
      <nav className="direction-tabs" aria-label="原型方向">
        {window.DIRECTIONS.map((item) => (
          <button
            key={item.id}
            className={`direction-tab ${direction === item.id ? "active" : ""}`}
            onClick={() => setDirection(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="header-meta">
        {dirtyCount > 0 ? (
          <span className="pill warn">{dirtyCount} 项未保存</span>
        ) : (
          <span className="connection">
            <i className="status-dot" />
            配置已同步
          </span>
        )}
        <span className="avatar">AM</span>
      </div>
    </header>
  );
}

function Field({ label, dbKey, hint, children, wide = false, action = null }) {
  return (
    <label className={`field ${wide ? "field-wide" : ""}`}>
      <span className="field-label">
        <strong>{label}</strong>
        {action || (dbKey ? <code className="field-key">{dbKey}</code> : null)}
      </span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

function SwitchRow({ label, description, checked, onChange }) {
  return (
    <div className="switch-row">
      <div className="switch-row-body">
        <strong>{label}</strong>
        <p>{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked ? "true" : "false"}
        aria-label={label}
        className="switch"
        onClick={() => onChange(!checked)}
      />
    </div>
  );
}

function MemoryField({ value, systemMemoryMb, onChange, label = "Agent 默认内存", dbKey = "agent_memory_mb" }) {
  const over = value > systemMemoryMb * 0.9;
  return (
    <Field
      label={label}
      dbKey={dbKey}
      wide
      hint={`下限 512 MB，上限取本机物理内存 ${window.formatMb(systemMemoryMb)}。作为新建实例的推荐值，不会改写已有实例。`}
    >
      <div className="range-row">
        <input
          type="range"
          min="512"
          max={systemMemoryMb}
          step="512"
          value={value}
          aria-label={label}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <span className="range-value">{window.formatMb(value)}</span>
      </div>
      {over ? (
        <span className="field-hint" style={{ color: "var(--amber)" }}>
          已超过物理内存的 90%，服务端与系统可能同时被 OOM 终止。
        </span>
      ) : null}
    </Field>
  );
}

function SecretField({ label, dbKey, hint, hintValue, configured, draft, onChange, helpUrl }) {
  return (
    <Field
      label={label}
      wide
      hint={hint}
      action={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span className={`pill ${configured ? "ok" : ""}`}>{configured ? hintValue : "未配置"}</span>
          {helpUrl ? (
            <a
              href={helpUrl}
              target="_blank"
              rel="noreferrer"
              className="field-key"
              style={{ color: "var(--teal)" }}
            >
              申请
            </a>
          ) : null}
        </span>
      }
    >
      <input
        type="password"
        className="control mono"
        value={draft}
        placeholder={configured ? "留空则保留现有 Key" : "粘贴 Key 后保存"}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
      />
      {dbKey ? <span className="field-hint mono">{dbKey}</span> : null}
    </Field>
  );
}

function ContextField({ value, onChange }) {
  const { min, max } = window.MODEL_BOUNDS;
  const clamped = value < min || value > max;
  return (
    <Field
      label="上下文窗口"
      dbKey="context_size_k"
      hint={`允许 ${min}–${max}K。用于计算剩余上下文比例，与模型真实窗口不一致会导致提前或过晚截断。`}
    >
      <div className="control-row">
        <input
          type="number"
          className="control mono"
          min={min}
          max={max}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <span className="panel-label">K tokens</span>
      </div>
      {clamped ? (
        <span className="field-hint" style={{ color: "var(--amber)" }}>
          保存时会被夹紧到 {min}–{max}。
        </span>
      ) : null}
    </Field>
  );
}

function TestResult({ result }) {
  if (!result) return null;
  return (
    <div className={`callout ${result.ok ? "" : "warn"}`} style={{ marginTop: 11 }}>
      <p>
        <strong>{result.ok ? "连通" : "失败"}</strong> · {result.detail}
      </p>
    </div>
  );
}

function JavaVersionRow({ record, task, onInstall, onCancel }) {
  const busy = task && task.status !== "installed" && task.status !== "failed";
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h4>
            Java {record.version}{" "}
            {record.lts ? <span className="pill" style={{ marginLeft: 6 }}>LTS</span> : null}
          </h4>
          <p className="mono">{record.installed ? record.installPath : "未安装"}</p>
        </div>
        {record.installed ? (
          <span className="pill ok">已安装</span>
        ) : busy ? (
          <button className="btn small danger" onClick={() => onCancel(record.version)}>
            取消
          </button>
        ) : (
          <button className="btn small" onClick={() => onInstall(record.version)}>
            安装
          </button>
        )}
      </div>
      {busy ? (
        <div>
          <div className="progress">
            <span style={{ width: `${task.progress}%` }} />
          </div>
          <span className="field-hint mono">
            {task.status} · {task.progress}% · {task.sourceLabel}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function SkillCard({ skill, onToggle }) {
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h4>{skill.name}</h4>
          <p>{skill.description}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={skill.enabled ? "true" : "false"}
          aria-label={`启用 ${skill.name}`}
          className="switch"
          onClick={() => onToggle(skill.id)}
        />
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <span className="pill">v{skill.version}</span>
        {skill.builtIn ? <span className="pill">内置</span> : null}
        <span className={`pill ${skill.enabled ? "ok" : ""}`}>{skill.enabled ? "已启用" : "已禁用"}</span>
      </div>
    </div>
  );
}

function ToolCard({ tool, providerKeys, onConfigure }) {
  const missing = tool.requirements.filter(
    (req) => req.required && !providerKeys[`${req.key}Configured`]
  );
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h4 className="mono">{tool.name}</h4>
          <p>{tool.description}</p>
        </div>
        <span className="pill">{tool.category}</span>
      </div>
      {tool.requirements.length === 0 ? (
        <span className="field-hint">无需额外配置，始终可用。</span>
      ) : (
        <div>
          {tool.requirements.map((req) => {
            const configured = providerKeys[`${req.key}Configured`];
            return (
              <div className="switch-row" key={req.key}>
                <div className="switch-row-body">
                  <strong>{req.label}</strong>
                  <p>
                    {req.required ? "必填" : "可选"} ·{" "}
                    {configured ? providerKeys[`${req.key}Hint`] : "未配置"}
                  </p>
                </div>
                <button className="btn small" onClick={() => onConfigure(req.key)}>
                  {configured ? "覆盖" : "配置"}
                </button>
              </div>
            );
          })}
          {missing.length > 0 ? (
            <div className="callout warn" style={{ marginTop: 11 }}>
              <p>
                缺少 <strong>{missing.map((req) => req.label).join("、")}</strong>，调用时会返回{" "}
                <span className="mono">tool_config_required</span> 并中止部署。
              </p>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

window.formatMb = function formatMb(mb) {
  return mb % 1024 === 0 ? `${mb / 1024} GB` : `${mb} MB`;
};
