# Agent 执行模型

## 前缀缓存与模型会话

参照 DeepSeek Harness 的 Session、PromptContext 和 compaction-basic 契约：

- `agent_session_events` 是模型可见历史的独立追加日志，不从 UI 气泡反推后续模型请求。旧会话首次使用时导入现有文本历史，此后跨 Turn/服务对象重建继续保留结构化 tool_calls/tool 结果。
- 固定 system 位于历史开头。运行状态快照在完整历史尾部追加，内容未变化时不重复注入；每个安全模型边界刷新。system 政策变化显式开启新序列。
- 实例工具声明包含全部内置能力的稳定 schema；启用能力只改变执行准入，不绕过原有确认。全局工具仍为独立工具集。
- 原始 Chat Completions content/reasoning 保留空白，DeepSeek 路由回传 `reasoning_content`，包括无工具调用的 assistant 最终消息。非 DeepSeek 路由不发送此专有字段。
- 请求 header 保存模型路由、协议、reasoning effort、完整工具声明，不保存 API Key。供应商 cache hit/miss usage 保存在 Step 模型结果，未返回时保持未知。
- 每个 Step 发送前检查压力；摘要请求重放原 system、tools 和配对完整的历史前缀，摘要指令在尾部。压缩记录为显式 replace，旧事件不删除；它从首个被替换消息开始失去缓存复用。仅接受确实缩小上下文的摘要。
- 清空上下文写 clear 事件，未来请求不再使用旧消息；这不是物理删除审计数据。失败/取消的未完成工具批次不自动重放，仍遵守下面的恢复安全边界。

参考：
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/system-prompt.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/compaction/compaction-basic/README.md
- https://api-docs.deepseek.com/guides/thinking_mode

### 验证边界

离线测试覆盖 30 Turn/32 请求的消息前缀及 tools 恒等、状态变化、能力启用、服务对象重建、原始 reasoning、清空、摘要前缀和真实 usage 字段解析。它验证应用不主动破坏前缀，**不证明供应商实际命中率**。

官方接口实测（会产生费用，显式提供环境变量，不使用本地数据库中的密钥）：

```bash
DEEPSEEK_CACHE_LIVE=1 DEEPSEEK_API_KEY=... DEEPSEEK_MODEL=deepseek-flash \
  npx tsx --test apps/server/test/deepseekCache.live.test.ts
```

验收：1 次冷启动 + 3 次尾部追加请求；逐请求打印供应商真实 hit/miss tokens，三次暖请求按输入 token 加权命中率必须 >=90%，未返回缓存统计直接失败。此长固定前缀测试是供应商缓存链路基准，不代表所有真实业务负载：短请求、路由切换、缓存驱逐、工具 schema/政策变更及压缩均可能降低命中率。生产效果必须从真实 Step usage 另行统计。

经用户授权，也可使用当前数据库配置（只读获取，不运行数据库初始化/恢复，不输出密钥）：

```bash
DEEPSEEK_CACHE_LIVE=1 DEEPSEEK_CACHE_USE_SAVED=1 \
  npx tsx --test apps/server/test/deepseekCache.live.test.ts
```

`DEEPSEEK_CACHE_NO_TOOLS=1` 仅用于无工具链路诊断，不代表 Agent 验收；`DEEPSEEK_CACHE_DIAGNOSTICS=1` 仅打印 SSE usage，不打印密钥/消息正文。

2026-10-20 当前网关实测未通过：`deepseek-v4-flash-vision-exp` 的 Chat Completions function tools 返回 422（上游按 Anthropic 工具类型解析）。无工具调用可返回文本，但一次原始 usage 为 `prompt_tokens=202`、`cached_tokens=35712`，缺少 DeepSeek hit/miss 字段；缓存数大于总输入数，不符合标准 OpenAI usage 口径，无法据此计算可信命中率。没有擅自将两数相加或报告超过 100% 的命中率。需要先修正网关的工具协议转换和 usage 统计口径，再跑完整暖请求验收。

## 层次与关联

- Scope：`global` 或实例 `serverId`，同一 Scope 只允许一个活跃任务。
- Turn：一次完整模型/工具对话，持久化在 `agent_executions`。普通聊天为一次用户任务；完整部署中，每个串行节点独立一轮，同一闭合并行组共享一轮，所有节点和后台任务收束后自动创建下一轮。重试、恢复沿用同一个 Turn ID。详见 [流程编排](deployment-workflow.md#turn-执行和并行收束)。
- Step：一次模型决策及其工具批次，持久化在 `agent_execution_steps`，同一 Turn 内从 0 编号，最多 500 轮。
- ToolCall：Step 中的一次工具调用，持久化在 `agent_execution_tools`。调用前写入 `running`，结果落库后写入 `completed`。`completed` 表示结果已确定，业务失败仍可能返回 `TOOL_ERROR`。
- Activity：仍用于展示 reasoning/tool/retry；消息及实时事件新增 `turnId`、`stepId`。旧消息的关联字段为 null，不尝试猜测回填。
- 全局交接：实例 Turn 的 `parentTurnId` 指向全局 Turn；父 Turn 保存交接状态和 `childTurnId`。目标忙时记录 blocked，而不是静默丢弃。当前不提供排队调度或子任务结果自动回传。

## 检查点与恢复

检查点保存结构化 `messages`（包括 assistant tool_calls 和 tool 结果）、当前 Step、已返回的模型决策、模型名及已安装能力。数据库不保存模型 API Key；恢复读取当前凭据。

1. 模型请求前落检查点；请求失败可重新请求当前 Step。
2. 模型决策返回后先持久化，再执行工具。
3. 工具执行前写调用记录；每个工具结果独立保存。
4. 整批工具完成后，将下一 Step 的完整上下文落库。
5. 数据库初始化时，将残留活跃 Turn / Step 标记为 interrupted，不自动执行任何工具。
6. 显式恢复时，复用已有模型决策，跳过已完成工具，并将已保存结果重新装入结构化上下文。

### 安全边界

- 仅允许恢复 interrupted / failed 且存在检查点的任务；完成或主动取消不恢复。
- 同一会话必须空闲，且只能恢复最新 Turn。已有后续任务时，旧上下文可能过期，必须发起新任务。
- 若任何工具保留在 running，可能已经产生外部副作用但尚未保存结果，**拒绝自动重放**。请人工检查文件、进程等实际状态，再发起新任务。本实现不承诺外部工具 exactly-once。
- 确认等待是工具执行的一部分；重启时同样保守阻断，不会默认批准或自动重复操作。
- 不恢复 Shell 进程、下载流或旧确认 Promise；恢复粒度是 Agent 模型/工具边界，不是工具内部的业务步骤。
- 当前按单后端进程运行，不提供多进程分布式租约。
- 全局任务完成与交接子任务启动尚非持久化队列的原子操作。若在二者之间崩溃，父 Turn 保留 pending 供检查，不会启动时自动重派。

## HTTP API

实例前缀：`/api/servers/:id/agent`；全局前缀：`/api/agent`。

- `GET <prefix>/executions`：最近 100 条 Turn 元数据和 resumable 标志，不返回完整检查点。
- `GET <prefix>/executions/:turnId`：Turn、Steps、ToolCalls、父子关联及 resumable 标志。
- `POST <prefix>/executions/:turnId/resume`：显式恢复；响应 `{ response }`，执行期间仍通过原有 Agent 事件推送进度。

执行记录可能包含工具参数、输出和上下文，应按聊天记录同等敏感级别保护数据库。清空会话上下文不会删除执行审计记录。当前未添加执行历史/恢复按钮 UI，可通过接口使用。

## 迁移

沿用现有启动时的幂等 SQLite 迁移：创建执行表，为两张消息表添加可空关联列，不删除旧数据。执行表 JSON payload 由 `ExecutionStore` 读写；消息继续通过现有 Drizzle schema 读写。

## 后台工具与 Inbox

参考 OpenCode V2 公开契约：
- <https://opencode.ai/v2/docs/api> 的 session.background、session.synthetic、session.inbox。
- <https://opencode.ai/v2/openapi.json> 中 `Session.Inbox.Delivery` 的 steer / queue。

本项目实现相同方向的边界语义，不声称复制 OpenCode 的内部运行时：

- **ToolJob 与 Step 解耦**：`agent_tool_jobs` 独立保存工具执行状态。Step 等待前台工具；后台化后只等待任务句柄，不等待真实结果。原 `agent_execution_tools.output` 保存 Step 实际收到的结果（可能是后台句柄），真正后台输出在 ToolJob。
- **显式后台参数**：可后台工具的模型参数增加 `background: boolean`，默认前台。后台立即返回 jobId，模型不可把句柄当作成功结果，不应轮询或重复执行。
- **运行中转后台**：`POST <prefix>/background` 将当前可后台化的前台工具解除阻塞；底层任务继续使用独立 AbortController。后续 Step 可以推进。
- **开放范围**：仅 run_shell_command、install_java_version 支持后台化，默认仍为前台串行等待。其余工具（包括搜索、网页抓取、文件读取）不开放后台参数，也不能通过 background 接口解除阻塞。
- **操作确认**：后台 Shell / Java 安装仍必须经过原有操作确认或自动确认策略，不绕过审批。确认等待归工具任务所有，不改变已经结束或正在推进的 Turn 状态。后续操作不得依赖未完成结果，也应避免与后台命令修改相同文件、进程或 Java 配置。
- **原子结果通知**：后台结果与 synthetic inbox 条目在同一个 SQLite 事务中落库，以 jobId 去重。Activity 独立持久化并携带源 Turn / Step / Job ID，不依赖原 Run 存活。
- **steer**：在下一个安全模型边界注入当前 Turn；不会打断正在生成的模型响应或前台工具，也不会插入未配对的 tool_calls / tool 消息之间。模型刚产生最终回复时若已有 steer，继续下一 Step 而不是结束。
- **idle 唤醒**：原 Turn 已结束时，steer 启动 synthetic 续接 Turn，消息不伪装成用户输入。Inbox 的 sourceJobId/sourceTurnId/deliveredTurnId 提供跨 Turn 关联。
- **部署流程例外**：后台结果在源 workflow Turn 中核验；即使标为 queue，本轮结果也会投递到本轮以完成汇合。其他轮次的迟到结果不注入当前轮次。未收束、失败/取消的流程不通过 synthetic 续接绕过门禁，需恢复原轮；普通聊天不受此限制。
- **queue**：只在下一次新 Turn 开始时投递，不主动唤醒，也不插入当前 Turn 中途。可改为 steer 手动唤醒。
- **取消**：会话 cancel 中断前后台工具，将已有及迟到结果降为 queue，防止取消后自动重新启动模型。Shell 响应 AbortSignal 终止进程；JavaService 的同版本安装可能由多个请求共享，不取消共享下载，但会在安装返回后检查取消信号，禁止继续写入当前实例 Java 配置。
- **重启**：遗留 running ToolJob 标记 interrupted；后台任务生成一次失败通知，不自动重放原工具。服务就绪后扫描持久化 steer 并调度；无模型配置时保留 inbox，不循环启动本地 fallback。
- **投递检查点**：Inbox delivered 状态与注入后的结构化上下文一并提交。模型调用失败后按原执行恢复接口继续；不自动无限重试。
- **清理边界**：有运行中的工具时不允许清空上下文，避免迟到回调重新生成被清空的消息。

新增接口（沿用上文实例 / 全局 prefix）：

```text
GET    <prefix>/tools/jobs
POST   <prefix>/background
GET    <prefix>/inbox
POST   <prefix>/inbox                 { text, delivery?: "steer" | "queue" }
PATCH  <prefix>/inbox/:inboxId        { delivery: "steer" | "queue" }
DELETE <prefix>/inbox/:inboxId
```

当前不提供后台化按钮或 inbox 编辑 UI；可通过接口操作。运行时仍按单后端进程设计，无分布式 worker、跨进程租约或工具内部执行恢复。后台观察可能读取变化中的状态，依赖这些结果的操作必须等待 inbox 中的真实结果后再决定。
