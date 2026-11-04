# 多后端连接器

## 边界

浏览器 → 连接器（`proxy.js` / `connector/`）→ 多个 `apps/server` 后端节点。连接器直接访问各后端，不需要反向隧道。连接器还将页面请求转给 Nuxt。Minecraft 玩家连接不经过连接器。

- 连接器统一处理面板登录、节点登记、状态检查、HTTP / WebSocket 路由；保留当前单管理员密码模型，没有多用户或按节点授权。
- 节点保留自己的 `workspace/`、SQLite、实例文件、运行环境、设置和 Agent 任务。不要让不同节点共享同一个工作目录 / 数据库。
- 浏览器使用连接器 Cookie；连接器为每个节点注入独立 `x-app-key`，不会转发浏览器 Cookie、Bearer 或 URL 中的 `token`。节点凭据与内部地址不会出现在节点列表中。
- 网关只转发到已登记的目标；登录的面板管理员可以在前端登记新节点，普通 API 请求不接受临时目标 URL。一个节点故障不会回退到另一个节点执行操作。节点增删即使在关闭面板密码的模式下也不开放，必须先设置密码并登录。
- 文件上传 / 下载流式转发；连接器不自动重试请求。写入超时不表示没有执行，必须先检查后端状态。
- 节点 ID 是持久身份：URL 查询参数、草稿、待发送消息、文件编辑器、设置草稿均按 ID 隔离。前端新增时由连接器生成唯一 ID，删除后再次添加不会复用旧 ID 或补发旧消息。手动预置配置中的 ID 不应移作其他机器使用。

## 原有单机启动

`npm run dev` / `npm start` 仍启动本机后端、Nuxt 和连接器，入口仍是 `:1143`。没有设置 `CONNECTOR_NODES_FILE` 时，初始节点为 `local`（本机后端）。启动器生成进程间节点密钥，或使用显式设置的 `APP_ACCESS_KEY`，并启用后端的 `APP_REQUIRE_CONNECTOR=true`。本机节点也可以在前端移除，移除后重启不会重新登记（但组合启动器仍会启动本机后端进程）；单纯管理远程节点请用独立连接器模式。

以前的单机工作区、待发送消息和文件编辑草稿首次访问 `local` 时迁移到节点命名空间。其他节点不会继承它们。

## 部署多个后端

在每台执行机器上安装、构建项目，然后只启动后端。例如服务器 A：

```bash
APP_HOST=10.0.0.11 \
APP_PORT=8787 \
APP_REQUIRE_CONNECTOR=true \
WORKSPACE_ROOT=/srv/mc-agent/workspace \
npm run start --workspace @mc-agent/server
```

**执行前必须通过服务管理器、秘密管理器或私有环境文件设置该节点的 `APP_ACCESS_KEY`。** 每个节点使用不同的高强度随机密钥，并确保连接器拿到对应值；不要把真实凭据写进 Git 或命令历史。`APP_REQUIRE_CONNECTOR=true` 时缺少密钥会拒绝启动，节点的面板登录接口也会禁用。

后端端口只允许连接器访问（防火墙 / 内网 / VPN）。跨不可信网络使用 HTTPS 或 VPN；HTTP 会明文传输节点密钥与文件。连接器公开入口应通过 HTTPS 反向代理访问。

## 启动独立连接器 + 前端

设置独立的 `APP_PASSWORD` 和长随机 `APP_SECRET_KEY`；它们是连接器面板凭据，不需要与节点相同。然后运行：

```bash
npm run dev:connector

# 已完成 npm run build 后：
npm run start:connector

# 重启由独立连接器启动器管理的前端与连接器：
npm run restart:connector
```

独立模式不会启动本机后端，仍在 `0.0.0.0:1143` 提供统一入口。首次没有节点时，登录后在引导页点击「管理后端连接」添加第一台服务器。独立模式重启必须使用 `restart:connector`（普通 `restart` 会切回本机三进程模式），并保留相同的状态文件及凭据环境变量。`.env.example` 只是变量说明，当前启动器不会自动读取 `.env`，请由 shell / 服务管理器注入环境变量。

也可预置节点：复制 `connector/nodes.example.json` 到私有文件，设置 `CONNECTOR_NODES_FILE`，并给连接器注入其 `accessKeyEnv` 引用的环境变量（与对应后端的 `APP_ACCESS_KEY` 相同）。这是启动种子配置，前端增删不会重写该文件或将其环境变量密钥复制到状态文件。单独启动 `proxy.js` 且希望不登记本机节点时，可设置 `CONNECTOR_ONLY=true`。

也可以分别运行 `npm run dev:web` 和 `npm run dev:proxy`（生产使用对应的 start 命令）。单独启动代理支持 `PROXY_HOST` / `PROXY_PORT` / `PROXY_WEB_TARGET`。SSR 的 `NUXT_API_BASE` 必须指向连接器；浏览器的 `NUXT_PUBLIC_API_BASE` / `NUXT_PUBLIC_WS_BASE` 默认留空，使用同源连接器，不要指向后端。

手动修改预置配置需重启连接器；前端增删则立即生效，不必重启任何服务。组合启动器会管理整个进程组，如要独立重启连接器，请分进程部署。配置格式、重复 ID、缺失密钥、无效 URL / 默认节点均在启动时校验，不会静默忽略。

## 域名与反向代理

浏览器应通过同一个域名访问页面、`/api` 与 `/ws`。Nginx 反代建议保留原始域名（含非默认端口），并需支持 WebSocket，例如在现有 `server` 中：

```nginx
location / {
    proxy_pass http://127.0.0.1:1143;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

连接器不检查 HTTP 写请求和 WebSocket 握手的 `Origin`、`Sec-Fetch-Site`，也不把来源地址与 `Host` 比较，因此反代改写 `Host` 不会导致「不允许跨站操作」。无需配置 `CONNECTOR_PUBLIC_ORIGIN`。登录密码、会话认证、节点管理权限和后端独立密钥认证仍然保留；HTTPS 反代应发送 `X-Forwarded-Proto: https`，让登录 Cookie 使用 `Secure`。

**安全取舍：移除了应用层的跨站请求 / WebSocket 来源防护。** 即使 Cookie 仍有 `HttpOnly`、`SameSite=Lax`，也不应把它们视作完整的 CSRF 防护。公网部署建议在反代增加访问认证、IP 白名单或使用 VPN，不要将关闭密码的面板公开暴露。

取消来源检查不等于开放 CORS，浏览器仍有自己的跨域和 Cookie 限制。页面、API 和 WebSocket 仍应经同一反代入口访问；`NUXT_PUBLIC_API_BASE` / `NUXT_PUBLIC_WS_BASE` 继续留空，不要跨域直连后端。

## 节点管理与持久化

- 左下角「节点」→「添加后端」，填写名称、API 原点地址（如 `http://10.0.0.11:8787`）和目标的 `APP_ACCESS_KEY`。允许先保存离线节点，随后从列表检查在线 / 凭据状态。重复地址拒绝添加，最多 100 个有效节点。
- 名称旁的垃圾桶打开移除确认。移除只删除连接登记，断开其 WebSocket 管理连接，不向后端发送停服或删除请求。已接收的 HTTP 操作可以完成；移除不等于撤销已提交任务。
- 移除当前节点会先检查未保存修改和正在进行的操作，再切换到剩余默认节点；移除最后一个节点进入初始引导页。删除默认节点时自动选择剩余节点为默认。
- 状态文件默认为连接器当前工作目录的 `.data/connector/nodes.json`；用 `CONNECTOR_STATE_FILE` 指定固定绝对路径。该文件包含前端添加的节点密钥、预置节点的移除记录和默认节点选择，必须保留及备份。文件创建权限为 `0600`，新建私有目录为 `0700`，已加入 `.gitignore`。
- 密钥仅在表单提交时发送，节点列表、状态和增删响应不回显密钥，也不写入浏览器存储；关闭表单或添加成功会清空密钥输入。请对浏览器入口使用 HTTPS，并保护服务器上的状态文件 / 备份（凭据以明文保存在这个私有文件，不应公开下载）。
- 保存使用串行写入、临时文件和原子替换，成功落盘才修改实时路由；写入失败保留旧登记，格式损坏时拒绝启动而不是覆盖。一个状态文件只允许由一个连接器进程写入，不支持多副本同时管理。
- 不把状态文件路径与 `CONNECTOR_NODES_FILE` 指向同一个文件。前端删除的种子 ID 不会因重启重新出现；需要再次连接可从前端重新添加，使用新 ID。升级或更换连接器部署目录时保留状态文件，动态本机端口 / 临时密钥仍从本次启动读取，不会写死在文件中。

## 前端切换

左下角网络图标的「节点」按钮打开“切换后端实例”，显示节点名称、默认标识和连接状态。原有侧栏仍用于切换当前节点内的 Minecraft 实例。

- 当前节点写在 `?node=host-a`，可收藏、刷新，也可在不同标签页分别管理节点。
- 切换后工作区重建，旧 WebSocket 与轮询关闭，新的所有 API、上传、下载、控制台及 Agent 连接都明确携带节点 ID。
- 待发送 Agent 消息只在所属节点重试，不会在另一个节点补发；离开该节点后暂停定时重试，已提交的后端任务继续运行。
- 活跃写操作、上传、文件操作、未保存的流程编排 / 模板修改会阻止切换；实例文件草稿确认后按节点保留。请先关闭实例配置 / 地图编辑窗口。
- 状态检查调用经过节点认证的 `/api/node`：区分在线、网络不可达、凭据无效和旧版后端需要升级。

## 协议与兼容

```text
GET  /health                                  连接器自身健康状态
POST /api/auth/login                          连接器登录
GET  /api/auth/verify                         连接器会话验证
POST /api/auth/logout                         清除连接器 Cookie
GET  /api/connector/nodes                      节点列表与管理能力（无地址 / 密钥）
POST /api/connector/nodes                      添加节点（管理员，JSON: name/url/accessKey）
DELETE /api/connector/nodes/:nodeId             移除连接登记（管理员）
GET  /api/connector/nodes/:nodeId/status        节点连通与认证检查
/api/nodes/:nodeId/...                        转发到该节点 /api/...
/ws/nodes/:nodeId/...                         转发到该节点 /ws/...
```

未带节点前缀的旧 `/api/...` 和 `/ws/...` 仅路由到 `defaultNodeId`，作为单机兼容入口，新前端使用显式节点路径。节点路径不允许调用后端的认证 / 连接器管理接口。

手动启动旧的本机后端且没有 `APP_ACCESS_KEY` 时，代理仅允许回环目标，使用旧本机签名认证兼容；远程后端必须配置节点密钥。推荐始终使用专用密钥与 `APP_REQUIRE_CONNECTOR=true`。

当前未实现跨节点迁移、全局调度、共享数据库或网关高可用。网关重启会断开管理连接，但正常情况下不会终止独立运行后端上的 Minecraft / Agent 任务；重连后从后端快照恢复。后端进程自身重启的恢复语义保持现有实现，不等同于断开网关。

## 验证

```bash
npm run test:connector
npm run typecheck
npm test
npm run build
```

连接器集成测试覆盖独立凭据、路由、双向 WebSocket、流式上传、下载、离线响应、会话，以及代理改写 Host 时不依赖来源配置的登录 / 节点增删 / WebSocket；跨站来源不拦截，未认证请求仍拒绝。还覆盖节点增删即时生效、重启恢复、私有文件权限、并发写入、重复提交、写入失败不改变路由和移除后断开隧道。前端测试覆盖 URL / 草稿 / 待发送状态隔离及节点表单提交锁定、密钥清理、删除前离开检查；后端测试覆盖仅连接器访问模式。
