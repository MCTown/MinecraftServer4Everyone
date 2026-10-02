# Minecraft Server Agent4Everyone

一个用于管理、部署和运行 Minecraft 服务端的内部 Agent 平台。

## 开发启动

```bash
npm install
npm run dev
```

对外访问默认只需要暴露 proxy 端口 `1143`：`http://<服务器IP>:1143`。组合启动脚本会将 proxy 固定绑定到 `0.0.0.0:1143`。

后端和前端默认只监听本机，并在启动时从默认端口开始自动选择可用端口；proxy 将 `/api`、`/ws` 转发到后端，其它请求转发到前端。这样即使开发工具占用了默认端口，启动和重启仍可正常工作。

可通过环境变量覆盖端口和目标：

```bash
APP_PORT=8787 NUXT_PORT=3000 npm run dev
```

未设置 `APP_PORT`/`NUXT_PORT` 时，组合脚本会自动选择可用端口；`PROXY_PORT` 不参与组合启动，公开入口固定为 `0.0.0.0:1143`。

也可以单独启动三个进程：`npm run dev:server`、`npm run dev:web`、`npm run dev:proxy`。需要重启由组合脚本管理的服务时执行 `npm run restart`；它会先优雅停止旧进程，再执行生产启动流程 `npm start`。

## NeoForge 服务端安装

Agent 支持通过 `neoforge_server_setup` 能力调用 `setup_neoforge_server` 安装 NeoForge。传入 `minecraftVersion`、`neoforgeVersion`、当前服务端内的 `installerPath` 与已安装的 `javaPath`；安装器可来自服务端包或 NeoForged 官方 Maven。支持现代 NeoForge 版本及 Minecraft 1.20.1 的旧版 `47.1.x`。

CurseForge 清单包还原后会返回对应的 NeoForge 官方安装器地址和后续安装步骤；Modrinth `.mrpack` 会按包内依赖自动安装。在 MCDReforged 模板下，安装文件、启动参数、EULA 和内存配置均写入 `server/`，安装完成后继续直启与 MCDReforged 验证流程。

## Agent Shell

Agent 默认提供 `run_shell_command`，可在 Tools 中查看，无需安装额外能力。支持执行命令、脚本、管道和重定向；Linux/macOS 使用 `/bin/sh`，Windows 使用 `cmd.exe`。

- 参数：`command`（必填）、`cwd`（相对当前服务端根目录，默认 `.`，例如 `server`）、`timeoutMs`（默认 `120000`，最大 `600000`）。
- 沿用现有操作确认及自动确认设置；输出实时写入控制台，返回 stdout、stderr、退出码及截断标记，每路保留最近 4000 字符。命令失败或超时会返回工具错误；用户中断或超时会终止命令进程组/进程树。
- `cwd` 必须是当前服务端内的已有目录。该校验仅限制起始工作目录，不是操作系统沙箱；Shell 命令以应用进程权限运行。命令为非交互执行，持续运行 Minecraft 服务端仍使用 `start_current_server`。

## 目录

```text
apps/server  Node.js + TypeScript + Fastify 后端
apps/web     Nuxt 3 + Vue 前端
workspace    运行时工作目录，自动创建
```
