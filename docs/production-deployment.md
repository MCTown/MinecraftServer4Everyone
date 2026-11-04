# 生产环境部署与更新

> 2026-09-26 在 `ubuntu@192.168.31.214` 只读核实。本文更新的是 **Minecraft Server Agent4Everyone 应用**，不是在应用里部署 Minecraft 整合包。执行发布前先确认服务器上的实际配置；本文命令是操作手册，不会自动执行。

## 当前拓扑

以下是历史生产检查快照；当前源码新增了多后端连接器，发布前另见 [多后端连接器](multi-backend.md)。未配置节点文件时仍保持本机三进程部署；`/health` 现为连接器自身健康检查。

| 项目 | 生产现状 |
| --- | --- |
| 代码目录 | `/home/ubuntu/MinecraftServer4Everyone`；不是 Git 仓库，不能在这里 `git pull` |
| 系统服务 | `/etc/systemd/system/minecraftserver4everyone.service`，以 `ubuntu` 运行，开机启用，`Restart=always` |
| 启动命令 | `source /home/ubuntu/start_proxy.sh && exec npm start`；`start_proxy.sh` 设置 HTTP/HTTPS 出站代理 |
| 主进程 | `npm start` → `scripts/run.js start` → Fastify 后端、Nuxt 前端、Node `proxy.js` |
| 监听端口 | 代理固定为 `0.0.0.0:1143`；后端和前端由 `scripts/run.js` 从默认端口开始自动选择可用的本机端口 |
| 路由 | `:1143` 将 `/api`、`/ws`、`/health` 转到后端，其余转到前端；当前无 Nginx/Caddy 或承载该应用的 Docker 容器 |
| 运行环境 | Node.js `v22.22.1`、npm `9.2.0`（版本以发布当天检查为准） |
| 持久化目录 | `/home/ubuntu/MinecraftServer4Everyone/workspace`，约 28 GB |

应用运行时环境变量由 systemd unit 设置；`start_proxy.sh` 负责出站代理，不是应用的 HTTP 入口。生产未发现 `.env` 文件。查看配置用 `systemctl cat minecraftserver4everyone.service`，**不要把可能含密码或密钥的完整配置、进程环境或日志粘贴到公开记录**。修改 unit 后才需要 `sudo systemctl daemon-reload`；单纯更新代码不需要。

`workspace/` 包含 `data/app.db`（SQLite）、`app.db-wal`、`app.db-shm`、`servers/`（Minecraft 实例和世界）、`server_slots/`（上传包）、`jdks/`、`python/`、`templates/`、`skills/` 等。2026-09-26 检查时数据库约 12 GB、WAL 约 4.6 GB，备份前必须重新估算磁盘空间。仓库中的 `templates/reference/` 是**随版本发布的内置模板**，与运行时 `workspace/templates/` 不同。

当前源码还包含连接器节点状态：默认 `.data/connector/nodes.json`，也可由 `CONNECTOR_STATE_FILE` 指向外部私有路径。它包含节点凭据、前端新增节点及移除记录，发布必须保留；外部路径需另行私有备份，不包含在 `workspace/` 备份内。

## 发布前确认

1. 约定维护窗口，确认应用中没有正在运行或需要持续运行的 Minecraft 服务端、Agent 任务和上传。停掉 systemd 服务会中断 Web/API/WebSocket，也可能终止其管理的子进程；需要先从应用里正常停服。
2. 明确发布的是哪个 commit 或哪些本地改动。**当前本地工作区有未提交和未跟踪文件**；`git archive` 不会包含它们，旧的 `.tmp/mcs4e-*.tgz` 也不是当前新版。最好先提交/打标签，记录发布版本。
3. 在 Node 22 环境执行 `npm ci`、`npm run typecheck`、`npm test`、`npm run build`，不通过就不要发布。本机若使用其它 Node 大版本，仍须在生产服务器的暂存目录按下文重新安装并构建；不要上传本机 `node_modules` 或构建产物。
4. 确认空间：服务器执行 `df -h /home/ubuntu`、`du -sh /home/ubuntu/MinecraftServer4Everyone/workspace`。一次完整本地备份当前约需 28 GB，另需留足数据库增长、构建和上传空间；空间不足时先安排外部备份位置，不要跳过备份。

## 1. 本地打包并上传

以下命令在**本地仓库根目录**执行，`release` 是示例发布标识；包只包含源码、文档和内置资源。显式列出打包目录可以避免把运行数据、密钥、历史归档或本机依赖带上：

```bash
release="$(date -u +%Y%m%dT%H%M%SZ)"
tar -czf "/tmp/mcs4e-${release}.tgz" \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='.nuxt' \
  --exclude='.output' \
  --exclude='.env' \
  package.json package-lock.json tsconfig.base.json proxy.js connector scripts apps templates \
  README.md pre-skill.md docs agent.md

tar -tzf "/tmp/mcs4e-${release}.tgz" | head -40
scp "/tmp/mcs4e-${release}.tgz" "ubuntu@192.168.31.214:/home/ubuntu/"
```

如果发布包中需要其它运行资源，先核对应用的实际引用再添加；不要把 `workspace/` 打入发布包。在服务器上对归档来源进行确认，**只解压可信的、自己刚上传的包**。

## 2. 在服务器暂存目录构建（不停生产服务）

以下命令在 `ssh ubuntu@192.168.31.214` 的 shell 执行。把 `release` 换成上一步的值；后续步骤沿用同一个 shell 的变量：

```bash
release="YYYYMMDDTHHMMSSZ"
app=/home/ubuntu/MinecraftServer4Everyone
stage="/home/ubuntu/mcs4e-releases/$release"

mkdir -p "$stage"
tar -tzf "/home/ubuntu/mcs4e-${release}.tgz" | head -40
tar -xzf "/home/ubuntu/mcs4e-${release}.tgz" -C "$stage"

cd "$stage"
source /home/ubuntu/start_proxy.sh
npm ci
npm run typecheck
npm test
npm run build
test -f apps/server/dist/main.js
test -f apps/web/.output/server/index.mjs
```

任何一步失败都停止，不要更新生产目录。`npm ci` 按发布包的 `package-lock.json` 安装依赖；同机暂存构建也能保证 `better-sqlite3` 等本机模块和 Node 版本匹配。**不要在暂存目录启动 `npm start`**：它默认会创建一个新的 `workspace/`，而且端口可能与生产冲突。

## 3. 停服、备份与切换

先在应用中正常停止 Minecraft 实例并确认维护窗口。之后在服务器执行；不要在生产服务仍向数据库写入时仅复制 `app.db`：

```bash
sudo systemctl stop minecraftserver4everyone.service
systemctl is-active minecraftserver4everyone.service  # 应输出 inactive
ps -eo pid,ppid,cmd | grep -E '(java|mcdreforged)' | grep -v grep || true

backup="/home/ubuntu/mcs4e-backup-${release}"
mkdir -p "$backup/code"
cp -a "$app/workspace" "$backup/"
rsync -a --exclude='/workspace/' --exclude='/logs/' --exclude='/.tmp/' \
  "$app/" "$backup/code/"
sudo cp -a /etc/systemd/system/minecraftserver4everyone.service "$backup/"
cp -a /home/ubuntu/start_proxy.sh "$backup/"
```

核对 `$backup/workspace/data/app.db*`、`$backup/code/package-lock.json` 与 `$backup/code/apps/web/.output/` 存在、备份容量合理。整个 `workspace/` 一起备份，才能保留 SQLite 数据库及其 WAL/SHM 和 Minecraft 实例数据；如果有其它进程仍在访问这些文件，应先协调停写。重要备份还应复制到服务器外，不要只依赖同一磁盘。

将经过测试的暂存内容切换到原有目录：

```bash
rsync -a \
  --exclude='node_modules/' --exclude='dist/' --exclude='.nuxt/' \
  --exclude='.output/' --exclude='/workspace/' --exclude='/.data/' --exclude='/logs/' --exclude='/.tmp/' \
  "$stage/" "$app/"
rsync -a --delete "$stage/node_modules/" "$app/node_modules/"
rsync -a --delete "$stage/apps/server/dist/" "$app/apps/server/dist/"
rsync -a --delete "$stage/apps/web/.output/" "$app/apps/web/.output/"
```

`--delete` **仅限以上三处可重建的依赖/编译产物目录**，绝对不要用于整个应用目录或 `workspace/`。更新时保留了代码目录中可能存在的旧文件；下次构建仍从干净的暂存目录进行，不依赖它们。不要对生产根目录执行 `rm -rf`、`git clean` 或不带排除规则的整目录同步。

## 4. 启动和验收

```bash
sudo systemctl start minecraftserver4everyone.service
systemctl status minecraftserver4everyone.service --no-pager
ss -ltnp | grep -E ':(1143)\b'
curl -fsS http://127.0.0.1:1143/health
curl -sSI http://127.0.0.1:1143/ | head -12  # 未登录时应跳转 /login
journalctl -u minecraftserver4everyone.service -n 100 --no-pager
```

通过浏览器实际检查登录、静态资源、实例列表/历史消息、Agent 对话和 WebSocket 日志，确认已有实例文件与设置完整；确认后再结束维护窗口。生产端口 `3100` 由现有 unit 指定，发布代码时不要自行改回默认 `3000`。

## 失败与回滚

切换前失败：生产服务尚未停机，无需回滚，修复暂存版本后重试。

切换后失败：停止服务，从本次**已核对的** `$backup/code/` 恢复应用代码、依赖和编译产物，再启动；保留现场日志以便定位。示例（仍在同一个 shell，且 `$app`、`$backup` 已设置）：

```bash
sudo systemctl stop minecraftserver4everyone.service
rsync -a --exclude='/.data/' "$backup/code/" "$app/"
rsync -a --delete "$backup/code/node_modules/" "$app/node_modules/"
rsync -a --delete "$backup/code/apps/server/dist/" "$app/apps/server/dist/"
rsync -a --delete "$backup/code/apps/web/.output/" "$app/apps/web/.output/"
sudo systemctl start minecraftserver4everyone.service
curl -fsS http://127.0.0.1:1143/health
```

**不要默认回滚 `workspace/`**：启动新版本后它可能已经写入数据。只有确认数据库迁移或数据损坏需要恢复、接受备份后新数据丢失，并且所有写入者均停止时，才能单独恢复整份 `workspace`（含 `app.db`、`app.db-wal`、`app.db-shm`）。如果本次发布还修改了 systemd unit 或 `start_proxy.sh`，回滚时也要从 `$backup/` 恢复它们并执行 `sudo systemctl daemon-reload`；只发布代码不需要改动 unit。

同样不要默认回滚 `.data/` 或外部连接器状态文件，以免丢失发布后新登记的节点和移除记录。备份中包含这些文件时，备份也必须按含密钥资料保护。

## 已知风险和后续改进

- 2026-09-26 检查时 unit 没有显式配置 `APP_PASSWORD`、`APP_SECRET_KEY`，代码可能使用内置默认值。应单独安排安全整改，密钥不要写入仓库或公开文档；**不要在常规发版中顺手旋转 `APP_SECRET_KEY`**，它同时用于登录令牌和数据库里已加密的 API Key，直接更换可能导致旧凭据无法解密。
- 组合启动脚本现在让后端和前端只监听 `127.0.0.1`，并自动避开已占用的内部端口；外部只需开放代理 `1143`。
- 当前没有 TLS/滚动发布；按现有方式切换需维护窗口。后续可考虑固定 `WORKSPACE_ROOT` 到独立数据目录并采用版本目录 + 原子切换，但那属于**改造部署架构**，不能不经迁移直接套用本文命令。
