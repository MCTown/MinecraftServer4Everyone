# Minecraft Server Agent4Everyone

一个用于管理、部署和运行 Minecraft 服务端的内部 Agent 平台。

## 开发启动

```bash
npm install
npm run dev
```

对外访问默认只需要暴露 proxy 端口 `1143`：`http://<服务器IP>:1143`。组合启动脚本会将 proxy 固定绑定到 `0.0.0.0:1143`。

后端和前端默认只监听本机，并在启动时从默认端口开始自动选择可用端口；连接器统一登录，将 `/api`、`/ws` 路由到对应后端，其它请求转发到前端。默认自动登记本机后端，因此原有单机启动方式不变。

## 多后端管理

支持“一个前端 → 服务器上的连接器 → 多个后端节点”。左下角「节点」按钮可以切换后端实例；各后端的 Minecraft 实例、文件、设置和 Agent 对话独立，草稿与待发送消息也按节点隔离。

在左下角「节点」管理中直接添加或移除后端，填写名称、后端地址及该后端的 `APP_ACCESS_KEY`，保存后立即生效，重启后仍保留。移除只断开登记，不会删除后端实例或文件。独立部署连接器与前端使用 `npm run dev:connector` / `npm run start:connector`，可从空节点列表开始，各执行机器只运行 `apps/server`。

也可通过 `CONNECTOR_NODES_FILE` 预置节点。前端管理的数据独立保存在 `.data/connector/nodes.json`（含凭据，请纳入私有备份，可用 `CONNECTOR_STATE_FILE` 指定路径）。完整配置、安全边界与部署步骤见 [多后端连接器](docs/multi-backend.md)，示例见 [`connector/nodes.example.json`](connector/nodes.example.json)。

可通过环境变量覆盖端口和目标：

```bash
APP_PORT=8787 NUXT_PORT=3000 npm run dev
```

未设置 `APP_PORT`/`NUXT_PORT` 时，组合脚本会自动选择可用端口；`PROXY_PORT` 不参与组合启动，公开入口固定为 `0.0.0.0:1143`。

也可以单独启动三个进程：`npm run dev:server`、`npm run dev:web`、`npm run dev:proxy`。需要重启由组合脚本管理的服务时执行 `npm run restart`；它会先优雅停止旧进程，再执行生产启动流程 `npm start`。

## NeoForge 服务端安装

Agent 支持通过 `neoforge_server_setup` 能力调用 `setup_neoforge_server` 安装 NeoForge。传入 `minecraftVersion`、`neoforgeVersion`、当前服务端内的 `installerPath` 与已安装的 `javaPath`；安装器可来自服务端包或 NeoForged 官方 Maven。支持现代 NeoForge 版本及 Minecraft 1.20.1 的旧版 `47.1.x`。

CurseForge 清单包还原后会返回对应的 NeoForge 官方安装器地址和后续安装步骤；Modrinth `.mrpack` 会按包内依赖自动安装。在 MCDReforged 模板下，安装文件、启动参数、EULA 和内存配置均写入 `server/`，安装完成后继续直启与 MCDReforged 验证流程。

## 文件管理

实例「文件管理」与设置中的「MCDR 模板」共用 VueFinder，支持新建、重命名、删除、搜索、下载、文件/目录上传，以及多选复制和移动。双击支持的文本文件可在 CodeMirror 中编辑，使用 `Ctrl / ⌘ + S` 保存；未保存草稿会保存在当前浏览器中。

- 压缩生成 ZIP，解压支持 ZIP、TAR、TAR.GZ、TGZ；目标同名文件一律报错，不会静默覆盖。解压可合并已有目录，但不会覆盖其中的文件。
- 在线文本编辑上限 2 MiB，单文件上传上限 20 GiB；解压上限为 100000 项、展开后合计 20 GiB。反向代理、可用磁盘和浏览器也可能限制实际大小。
- 拒绝路径穿越、符号链接和压缩包中的特殊文件；文件内容读写、复制与压缩同时拒绝硬链接。请勿在外部进程中同时修改操作路径，这不是用于对抗恶意并发文件系统变更的操作系统级沙箱。
- 模板修改采用写时复制，仅影响之后创建的实例；「恢复默认」不会改动已有实例。旧文件 API 保持兼容。

## Agent Shell

Agent 默认提供 `run_shell_command`，可在 Tools 中查看，无需安装额外能力。支持执行命令、脚本、管道和重定向；Linux/macOS 使用 `/bin/sh`，Windows 使用 `cmd.exe`。

- 参数：`command`（必填）、`cwd`（相对当前服务端根目录，默认 `.`，例如 `server`）、`timeoutMs`（默认 `120000`，最大 `600000`）。
- 沿用现有操作确认及自动确认设置；输出实时写入控制台，返回 stdout、stderr、退出码及截断标记，每路保留最近 4000 字符。命令失败或超时会返回工具错误；用户中断或超时会终止命令进程组/进程树。
- `cwd` 必须是当前服务端内的已有目录。该校验仅限制起始工作目录，不是操作系统沙箱；Shell 命令以应用进程权限运行。命令为非交互执行，持续运行 Minecraft 服务端仍使用 `start_current_server`。

## 目录

```text
apps/server  Node.js + TypeScript + Fastify 后端
apps/web     Nuxt 3 + Vue 前端
connector    多后端管理网关、认证与流式代理
workspace    运行时工作目录，自动创建
```
