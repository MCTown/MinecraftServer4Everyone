/* 方向三 Config Ledger：把所有配置键摊平成一张可搜索的表，标注来源与作用域。
   适合排查「这个值到底从哪来、为什么改不动」。 */

function ConfigLedger(props) {
  const { state, patch, notify } = props;
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState("all");
  const [selected, setSelected] = React.useState({ section: "model", key: "base_url" });

  const filters = [
    { id: "all", label: "全部" },
    { id: "db", label: "可在此修改" },
    { id: "env", label: "环境变量" },
    { id: "file", label: "服务端文件" }
  ];

  const needle = query.trim().toLowerCase();
  const sections = window.LEDGER.map((section) => ({
    ...section,
    rows: section.rows.filter((row) => {
      if (filter === "db" && row.source !== "db" && row.source !== "request") return false;
      if (filter === "env" && row.source !== "env") return false;
      if (filter === "file" && row.source !== "file") return false;
      if (!needle) return true;
      return (
        row.key.toLowerCase().includes(needle) ||
        row.name.toLowerCase().includes(needle) ||
        String(row.value).toLowerCase().includes(needle)
      );
    })
  })).filter((section) => section.rows.length > 0);

  const total = sections.reduce((sum, section) => sum + section.rows.length, 0);
  const allRows = window.LEDGER.reduce((sum, section) => sum + section.rows.length, 0);
  const activeSection = window.LEDGER.find((section) => section.id === selected.section);
  const activeRow = activeSection && activeSection.rows.find((row) => row.key === selected.key);

  return (
    <div className="ledger-workspace">
      <header className="ledger-topbar">
        <div>
          <div className="breadcrumb">SETTINGS / LEDGER</div>
          <h1 className="settings-title">配置总览</h1>
        </div>
        <div className="ledger-search">
          <span>/</span>
          <input
            value={query}
            placeholder="搜索键名、显示名或当前值"
            aria-label="搜索配置项"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button className="section-action" onClick={() => setQuery("")} aria-label="清空搜索">
              清空
            </button>
          ) : null}
        </div>
        <div className="ledger-filters" role="group" aria-label="按来源筛选">
          {filters.map((item) => (
            <button
              key={item.id}
              className={filter === item.id ? "active" : ""}
              onClick={() => setFilter(item.id)}
              aria-pressed={filter === item.id}
            >
              {item.label}
            </button>
          ))}
        </div>
        <span className="pill">
          {total} / {allRows}
        </span>
      </header>

      <div className="ledger-shell">
        <div className="ledger-scroll">
          {sections.length === 0 ? (
            <p className="ledger-empty">没有匹配的配置项。试试搜 memory、proxy 或 port。</p>
          ) : (
            sections.map((section) => (
              <section key={section.id}>
                <div className="ledger-section-head">
                  <span className="panel-label">{section.label}</span>
                  <span className="field-key">{section.rows.length}</span>
                </div>
                {section.rows.map((row) => {
                  const meta = window.SOURCE_META[row.source];
                  const isActive = selected.section === section.id && selected.key === row.key;
                  return (
                    <button
                      key={`${section.id}-${row.key}`}
                      className={`ledger-row ${isActive ? "active" : ""}`}
                      onClick={() => setSelected({ section: section.id, key: row.key })}
                      aria-current={isActive ? "true" : undefined}
                    >
                      <span className="ledger-key">
                        <strong>{row.name}</strong>
                        <code>{row.key}</code>
                      </span>
                      <span className={`ledger-value ledger-col-value ${row.secret ? "dim" : ""}`}>
                        {row.value}
                      </span>
                      <span className="ledger-col-source">
                        <span className={`pill ${meta.tone}`}>{meta.label}</span>
                      </span>
                      <span className="ledger-value dim">{row.editable ? "可改" : "只读"}</span>
                    </button>
                  );
                })}
              </section>
            ))
          )}
        </div>

        <aside className="ledger-detail">
          {activeRow ? (
            <LedgerDetail
              row={activeRow}
              section={activeSection}
              state={state}
              patch={patch}
              notify={notify}
            />
          ) : (
            <p className="ledger-empty">选中左侧任意一项查看来源与影响面。</p>
          )}
        </aside>
      </div>
    </div>
  );
}

function LedgerDetail({ row, section, state, patch, notify }) {
  const meta = window.SOURCE_META[row.source];
  return (
    <div>
      <div className="detail-head">
        <span className="panel-label">{section.label}</span>
        <h3>{row.name}</h3>
        <code>{row.key}</code>
      </div>

      {row.editable ? (
        <LedgerEditor row={row} state={state} patch={patch} notify={notify} />
      ) : (
        <div className={`callout ${row.source === "file" ? "warn" : ""}`}>
          <p>
            {row.source === "env"
              ? "该值来自启动时的环境变量，界面里无法修改。改完需要重启进程。"
              : "该值只存在于服务端文件里，目前没有结构化编辑器，需要在文件管理器中改纯文本。"}
          </p>
        </div>
      )}

      {row.source === "file" ? (
        <button className="btn small" style={{ marginTop: 11 }} onClick={() => notify("原型：在文件管理器中打开")}>
          <Icon name="file-text" />
          在文件管理器中打开
        </button>
      ) : null}

      <div className="detail-meta">
        <div className="detail-meta-row">
          <span>来源</span>
          <strong>{meta.label}</strong>
        </div>
        <div className="detail-meta-row">
          <span>作用域</span>
          <strong>{row.scope}</strong>
        </div>
        <div className="detail-meta-row">
          <span>当前值</span>
          <strong>{row.secret ? "已掩码" : row.value}</strong>
        </div>
        <div className="detail-meta-row">
          <span>可写</span>
          <strong>{row.editable ? "是" : "否"}</strong>
        </div>
      </div>

      {row.note ? (
        <div className="callout" style={{ marginTop: 16 }}>
          <p>{row.note}</p>
        </div>
      ) : null}
    </div>
  );
}

function LedgerEditor({ row, state, patch, notify }) {
  if (row.secret) {
    return (
      <SecretField
        label="覆盖写入"
        hint="保存后立即加密存库，无法读回。"
        hintValue={row.value}
        configured={row.value !== "未配置"}
        draft=""
        onChange={() => notify("原型：填写后保存即覆盖")}
      />
    );
  }

  if (row.key === "agent_memory_mb") {
    return (
      <MemoryField
        value={state.agent.memoryMb}
        systemMemoryMb={state.agent.systemMemoryMb}
        onChange={(value) => patch("agent.memoryMb", value)}
      />
    );
  }

  if (row.value === "true" || row.value === "false" || row.value === "1") {
    const checked = row.value !== "false";
    return (
      <SwitchRow
        label="当前状态"
        description={checked ? "已开启" : "已关闭"}
        checked={checked}
        onChange={() => notify(`原型：切换 ${row.key}`)}
      />
    );
  }

  if (row.key === "global_system_prompt" || row.key === "prompt_override") {
    return (
      <Field label="内容" dbKey={row.key} hint="改动影响后续对话，不重写已有历史。">
        <textarea
          className="control mono"
          style={{ minHeight: 170 }}
          value={row.key === "global_system_prompt" ? state.globalPrompt : state.instance.promptOverride}
          onChange={(event) =>
            patch(row.key === "global_system_prompt" ? "globalPrompt" : "instance.promptOverride", event.target.value)
          }
        />
      </Field>
    );
  }

  return (
    <Field label="值" dbKey={row.key}>
      <input
        className="control mono"
        defaultValue={row.value}
        onChange={() => notify(`原型：编辑 ${row.key}`)}
      />
    </Field>
  );
}
