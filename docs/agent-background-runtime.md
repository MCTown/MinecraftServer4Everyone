# Agent 后台任务与 Inbox 协议

此实现参考 OpenCode v2 的 Job / Session Inbox / restart 语义，继续使用 MCTAgent 的实例 scope、Deployment Workflow 和现有部署工具。它不是把 OpenCode 的 Effect runtime 或整个 Session 产品模型搬进来。

## 后台执行与等待

- 仅明确支持的 Shell、Java、Forge、NeoForge、mrpack 工具接受 `background=true`。
- 创建 job、恢复元数据和稳定 `notificationId` 后，立即返回 `jobId`。
- job 的 AbortController 和生命周期独立于发起它的模型 step；当前 turn 可以继续独立工作。
- 完成状态和 Inbox admission 在同一个 SQLite 事务中写入，然后发布事件。
- 空闲 scope 自动续跑；正在运行的 scope 在完整 assistant/tool-result 屏障之后接收 steer。
- `wait_for_background_job(jobId)` 订阅完成事件，不调用模型、不设置轮询定时器，也不探测进程。
- workflow join 可以被外部 steer 唤回处理新约束；后台任务仍归原执行所有，未完成时不能提前结束部署。新部署在一个持续执行中按步骤推进，不再按阶段创建 successor；旧分轮记录保留其恢复协议。
- 当存在后台任务时，明显的 Shell 固定等待、安装器进程轮询、`tail -f` 会返回指导性 TOOL_ERROR。该检测是行为提示，不是 Shell 沙箱或完整语法分析。

## Inbox admission 与 delivery

`agent_inbox` 是当前投影，`agent_inbox_events` 是带单调序号的持久化生命周期日志。

支持输入类型：

- `user`：正式用户输入、实例任务交接。
- `synthetic`：后台结果、恢复通知和外部补充。
- `compaction`：控制边界，不伪装成用户消息进入模型历史。

每个输入有 ID、scope、delivery、enqueue sequence、状态和可选来源信息：

- 同 ID、同 scope、同类型：首次 admission 生效，重试不覆盖正文或 delivery，包括已投递/取消的输入。
- 跨 scope 或跨类型重用 ID：拒绝。
- `resume=false`：只持久化，不单独唤醒；以后执行仍可在合法边界消费它。
- `steer`：安全 step 边界按顺序成批投递；遇到 compaction 控制项先停下，处理控制后才允许后面的输入跨入历史。
- `queue`：当前工作继续时保持 pending；idle boundary 优先 steer，否则只取一条 queue，再重新判断是否继续。
- queue/cancel mutation 仅通知前端；promote-to-steer 才调度模型。
- 消息、Inbox delivered 状态和模型 checkpoint 同事务提交。压缩的 history replacement 同步更新活动 execution checkpoint。
- 旧 Inbox 行启动时按原插入顺序一次性补序号，不重写旧消息。

普通 `/requests` 保留现有请求冲突语义（同 requestId 不同内容报错），但其确认信息通过持久化 Inbox claim/delivery 对账，后端对象重建不会重复创建 turn。忙时新增输入使用 `/inbox` 的 user/steer/queue admission。

## 通知生命周期与恢复

Job 的 `notificationState`：

1. `pending`：后台任务尚未提交完成通知。
2. `admitted`：结果已进入 Inbox。
3. `delivered` / `cancelled`：消费者确认或用户取消。

通知 ID 沿用兼容的 `inbox:<jobId>`。重启时同时检查 running 和 terminal job，补回遗漏的 admission，已消费的通知不会重新插入。

重启行为：

- running job 变为 `interrupted`，保存“外部副作用结果不确定”的事实；不重新执行 installer、不尝试接管任意 PID。
- 后台 receipt 可对账恢复；前台 orphan tool call 则终结为明确的 uncertain TOOL_ERROR。
- 恢复模型看到旧工具的真实/不确定结果，不重放旧参数；它应先核对实际状态。
- 仅恢复各 scope 的最新 interrupted owner，使用其已持久化模型决定和 checkpoint。
- 每个 owner 的自动重启恢复最多 3 次；显式失败、用户取消和已被新任务替代的 turn 不自动恢复。
- 单独的重启通知 `resume=false`，不会把原本空闲的长任务 owner 重新启动。
- `focus_instance` 的子任务按稳定 ID 进入目标 Inbox，忙时 queue；子 workflow 继承 parentTurnId，终态通过稳定的父 Inbox 通知回传。重启可补齐尚未 admission 的交接和完成通知。

不保证外部副作用 exactly-once；与 OpenCode v2 一样，进程崩溃不能证明外部命令是否已经生效。

## 并发与资源归属

- 同一 scope 的执行由进程级 owner 保护，多个 AgentService 对象不能同时 drain 相同 scope；不同实例仍可并发。
- 同一模型响应中的连续只读工具调用可立即并发启动（最大 8 个）；结果按原调用顺序汇合，失败时先等待同批 sibling 结束再释放 step。
- 配置写入、交互审批、能力启用和 workflow 控制保留串行屏障。不能从任意 Shell 字符串可靠推断是否独立，因此不默认并发所有 Shell。
- 后台任务和前台关键写操作经过同一个进程级 ResourceScheduler：同版本 JDK、同实例 Loader、MCDR、实例独占资源分别建租约。
- workflow 的 `configure_mcdr` / `install_modloader` Shell 分支使用明确资源归属；其他 Shell 默认实例独占。它们是调度约定，不是防止恶意命令跨目录写入的安全沙箱。
- 等待资源和等待 job 都是事件驱动，并支持取消。资源在完成、失败和取消后释放。

进程级所有权不是多进程/多机 fencing。本产品依然是“一实例一个 Agent 对话”的 scope 模型；同实例多独立 Session、Session 移动到另一个 workspace 属于额外产品/存储模型，不在此处伪造支持。跨实例使用明确任务交接，不搬迁正在部署实例的文件归属。

## 输出与 API

Shell stdout/stderr 的完整流保存在 `agent_job_output`，每块最多 4096 字符；UI 控制台和模型即时结果继续使用原来的截断上限。

实例 API 前缀为 `/api/servers/:id/agent`，全局为 `/api/agent`：

- `GET /tools/jobs`：最近任务及通知状态。
- `GET /tools/jobs/:jobId/output?cursor=0`：exclusive cursor 增量读取（最多 100 块）。
- `DELETE /tools/jobs/:jobId`：仅取消此 scope 的指定 live job。
- `GET /inbox/events?after=0`：按持久化序号读取生命周期日志。
- `POST /inbox`：支持 `id`、`kind=user|synthetic`、`text`、`delivery`、`resume`。
- `POST /tools/output/prune`，正文 `{ "before": "2026-10-01T00:00:00Z" }`：显式清理旧输出，不清理 running 或尚未确认通知的 job，不删除任务审计元数据。

WebSocket 的 `tool_output` 只是包含 jobId 的失效提示；重连后以输出 cursor 和任务投影为准，无需模型轮询。

## 验证边界

单元/集成测试覆盖幂等性、事务回滚、旧数据迁移、steer/queue/control 顺序、后台通知恢复、孤儿工具不重放、有界恢复、同 scope ownership、并发结果顺序、资源租约、单任务取消、完整 Shell 流、输出清理和 HTTP 参数/归属校验。

这些测试不等于新的真实模型部署 benchmark；模型是否减少等待、部署实际耗时是否降低，需要另跑相同隔离任务验证。
