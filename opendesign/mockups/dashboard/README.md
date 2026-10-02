# 总 Dashboard 设计稿

> **状态：已实现。** 本原型描述的主界面已落地到 `apps/web`（`components/dashboard/DashboardView.vue` + `composables/useGlobalAgent.ts` + 后端全局会话 `/api/agent/*`、`/ws/agent/global`）。下方文档保留为设计依据。

登录后的主界面：大欢迎词 + 实例推荐 + 一个总对话框。用户可以直接用一句话管理下面所有实例、创建新实例；一旦某句话落实成对具体实例的操作，界面自动跳到该实例的操作界面——左侧是 Agent 对话记录，右侧是该实例的实时终端。

这是交互式原型，不是最终实现。依赖全部走 `opendesign/vendor/`，直接双击 `index.html` 或用本地静态服务器打开即可：

```bash
python3 -m http.server 8791   # 在 opendesign/ 目录下
# 打开 http://127.0.0.1:8791/mockups/dashboard/index.html
```

## 两个视图

顶栏可切换，两个视图共用同一份会话与实例状态，跳转是真实发生的：

| 视图 | 内容 |
| --- | --- |
| **主界面 Dashboard** | 大欢迎词 + 平台概览数字、实例推荐卡片（含新建入口）、嵌在页面主列里的总对话框 |
| **实例操作台** | 顶部实例 tabs 与启停操作，左列 Agent 对话记录（含执行活动行），右列该实例的实时终端 |

## 交互演示

对话框是脚本化的：按关键词命中剧本，分步追加消息、工具活动行，并把日志写进对应实例的终端。点快捷指令或直接输入都能触发：

| 输入示例 | 发生的动作 |
| --- | --- |
| 巡检实例 / 都在跑吗 | 生成健康快照，逐条报告各实例状态（不跳转） |
| 排查崩溃 / 匠造工坊崩了 | 读崩溃日志 → **跳到匠造工坊** → 终端打出 Java 17 重启日志 → 实例转「运行中」 |
| 部署整合包 | 检索整合包 → 下载服务端包到槽位 → **跳到新实例** → 终端打出部署流程 |
| 创建实例 / 开个新服 | 在实例列表里**新增一个卡片** → **跳到它** → 终端打出初始化日志 |
| 启动 / 停止 | 状态变「启动中 / 关闭中」→ **跳到对应实例** → 终端写启动/存档日志 → 状态回流 |
| 空闲建议 | 给出下一步建议，不涉及实例操作 |

「重置演示」把实例、终端和对话恢复初始状态。

## 页面结构（映射到实现）

主界面自上而下三块，正好对应真实页面可以拆成三个组件：

```text
DashboardView
├─ welcome          欢迎词 + PlatformStats（实例总数 / 运行中 / 需要处理 / 模型状态）
├─ recommend-section 实例推荐卡片网格（InstanceCard + EmptyInstanceCard）
└─ chat-section     总对话框 ConsolePanel（消息流 + Composer）
```

实例操作台：

```text
ConsoleView
├─ console-topbar   实例名 + 状态 + 启动/停止/重启/强制结束/文件/配置 + 返回主界面
├─ instance-tabs    实例切换，跳转来源会高亮 2.6s
└─ console-grid
   ├─ conversation  左：Agent 对话记录 + 输入串
   └─ terminal-card 右：Terminal（实时输出 + 控制台指令输入）
```

## 落地到 apps/web 需要的东西

原型假定存在一个**全局 Agent 会话**（后端目前只有 per-instance 的 `/api/servers/:id/agent/*`）。落地时大致是：

1. **后端**：新增全局会话实体与 `/api/agent/messages`、`/api/agent/context-usage`、`/api/agent/confirmation` 等路由，以及在全局上下文里可用的实例级工具（`list_instances`、`create_server`、`start_current_server`、`read_console_log` 等）。当前 `AgentService` 以 `serverId` 为键，需要把「会话」与「作用实例」解耦。
2. **前端编排**：全局会话返回的结构化动作（例如 `{ type: "focus_instance", serverId }`）驱动 `selectServer(id)` 跳转；实例操作台复用现有 `ConsolePanel` 与 `AgentPanel`，只是数据源在全局/实例之间切换。
3. **路由**：`pages/index.vue` 目前一个文件承载落地页与工作区。建议拆成 `/`（Dashboard）与 `/instance/[id]`，或保留单页但用视图状态切换——原型用的是后者，先验证体验再决定。

> 原型里所有实例名、日志和工具名都取自真实功能（`start_current_server`、`materialize_curseforge_manifest_pack_from_server_slot`、MCDReforged 模板等），方便评估文案与信息密度。
