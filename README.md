# Minecraft Server Agent4Everyone

一个用于管理、部署和运行 Minecraft 服务端的内部 Agent 平台。

## 开发启动

```bash
npm install
npm run dev
```

对外访问默认只需要暴露 proxy 端口 `3000`：`http://<服务器IP>:3000`。

后端默认监听 `0.0.0.0:8787`，前端默认监听 `0.0.0.0:3001`，proxy 默认监听 `0.0.0.0:3000`，并将 `/api`、`/ws` 转发到后端，其它请求转发到前端。

可通过环境变量覆盖端口和目标：

```bash
APP_PORT=8787 NUXT_PORT=3001 PROXY_PORT=3000 npm run dev
```

也可以单独启动三个进程：`npm run dev:server`、`npm run dev:web`、`npm run dev:proxy`。

## 目录

```text
apps/server  Node.js + TypeScript + Fastify 后端
apps/web     Nuxt 3 + Vue 前端
workspace    运行时工作目录，自动创建
```
