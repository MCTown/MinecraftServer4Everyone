import { createServer } from "node:http";
import { createProxyServer } from "httpxy";
import { COOKIE_NAME, TOKEN_MAX_AGE_MS, generateAuthToken, hasSession, sameSecret } from "./auth.js";
import { NODE_ID_PATTERN } from "./config.js";
import { NodeRegistry } from "./registry.js";

function json(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw Object.assign(new Error("请求过大"), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw Object.assign(new Error("无效的 JSON"), { status: 400 }); }
}

function sameOrigin(req) {
  if (!req.headers.origin) return true;
  try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
}

/** Stream requests directly to a fixed registry target. Never retry mutations. */
export function createConnector(config) {
  const registry = new NodeRegistry(config);
  const nodes = new Map();
  function createNode(node) {
    const proxy = createProxyServer({ target: node.url, changeOrigin: true, xfwd: true, ws: true, proxyTimeout: 600_000 });
    const boundConnect = (outgoing) => {
      const track = (socket) => {
        if (!socket.connecting) return;
        const timer = setTimeout(() => outgoing.destroy(new Error("Backend connection timed out")), 10_000);
        timer.unref();
        const clear = () => clearTimeout(timer);
        socket.once("connect", clear);
        outgoing.once("close", clear);
      };
      if (outgoing.socket) track(outgoing.socket);
      else outgoing.once("socket", track);
    };
    proxy.on("proxyReq", boundConnect);
    proxy.on("proxyReqWs", boundConnect);
    // Backend sessions may never replace the connector's browser session.
    proxy.on("proxyRes", (response) => { delete response.headers["set-cookie"]; });
    return { ...node, proxy, sockets: new Set() };
  }
  function syncNodes() {
    const snapshot = registry.snapshot();
    const ids = new Set(snapshot.nodes.map((node) => node.id));
    for (const [id, node] of nodes) {
      if (ids.has(id)) continue;
      nodes.delete(id);
      // Prevent an existing tunnel from continuing to send commands to a
      // removed target. HTTP requests already admitted may finish normally.
      for (const socket of node.sockets) socket.destroy();
    }
    for (const node of snapshot.nodes) if (!nodes.has(node.id)) nodes.set(node.id, createNode(node));
  }
  registry.on("change", syncNodes);
  syncNodes();
  function publicRegistry() {
    const { nodes: entries, defaultNodeId } = registry.snapshot();
    return {
      defaultNodeId, nodes: entries.map(({ id, name }) => ({ id, name })),
      canManage: Boolean(config.registryFile && config.password),
      managementDisabledReason: !config.password ? "请先设置连接器面板密码，登录后才能管理节点" : !config.registryFile ? "未配置节点状态存储" : ""
    };
  }
  const webProxy = createProxyServer({ target: config.webTarget, changeOrigin: true, xfwd: true, ws: true });
  const loginAttempts = new Map();
  const sockets = new Set();

  function nodeHeaders(node) {
    return node.legacyLocalAuth ? { authorization: `Bearer ${generateAuthToken(config.secretKey)}` } : { "x-app-key": node.accessKey };
  }

  function resolveRoute(pathname) {
    const match = /^\/(api|ws)\/nodes\/([^/]+)(\/.*)?$/.exec(pathname);
    if (match) {
      if (!NODE_ID_PATTERN.test(match[2])) return { error: 400 };
      const node = nodes.get(match[2]);
      if (!node) return { error: 404 };
      const path = `/${match[1]}${match[3] ?? ""}`;
      if (/^\/api\/(auth|connector|nodes)(\/|$)/.test(path)) return { error: 404 };
      return { node, path };
    }
    if (/^\/(api|ws)\/nodes(\/|$)/.test(pathname)) return { error: 404 };
    if (/^\/(api|ws)(\/|$)/.test(pathname)) {
      const node = nodes.get(registry.snapshot().defaultNodeId);
      return node ? { node, path: pathname } : { error: 503 };
    }
    return null;
  }

  function prepare(req, url, route) {
    url.searchParams.delete("token");
    req.url = `${route.path}${url.search}`;
    delete req.headers.cookie;
    delete req.headers.authorization;
    delete req.headers["x-app-key"];
    Object.assign(req.headers, nodeHeaders(route.node));
  }

  async function auth(req, res, pathname) {
    if (pathname === "/api/auth/verify" && req.method === "GET") {
      json(res, !config.password || hasSession(req, config.secretKey) ? 200 : 401, !config.password || hasSession(req, config.secretKey) ? { success: true } : { error: "未登录或令牌已过期" });
      return;
    }
    if (pathname === "/api/auth/logout" && req.method === "POST") {
      res.setHeader("set-cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${req.socket.encrypted || req.headers["x-forwarded-proto"] === "https" ? "; Secure" : ""}`);
      json(res, 200, { success: true });
      return;
    }
    if (pathname !== "/api/auth/login" || req.method !== "POST") { json(res, 404, { error: "接口不存在" }); return; }
    if (!config.password) { json(res, 403, { error: "未设置面板密码，无法登录" }); return; }
    const address = req.socket.remoteAddress;
    const now = Date.now();
    for (const [key, item] of loginAttempts) if (now - item.start > 60_000) loginAttempts.delete(key);
    const attempts = loginAttempts.get(address) ?? { start: now, count: 0 };
    if (attempts.count >= 10 || loginAttempts.size >= 10_000) { json(res, 429, { error: "登录尝试过多，请稍后重试" }); return; }
    const body = await readJson(req);
    if (typeof body?.password !== "string" || !sameSecret(body.password, config.password)) {
      attempts.count++;
      loginAttempts.set(address, attempts);
      json(res, 401, { error: "密码错误" });
      return;
    }
    loginAttempts.delete(address);
    const token = generateAuthToken(config.secretKey);
    res.setHeader("set-cookie", `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TOKEN_MAX_AGE_MS / 1000}${req.socket.encrypted || req.headers["x-forwarded-proto"] === "https" ? "; Secure" : ""}`);
    json(res, 200, { success: true, token });
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://connector.local");
    const path = url.pathname;
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !sameOrigin(req)) { json(res, 403, { error: "不允许跨站操作" }); return; }
    if (path === "/health" && req.method === "GET") { json(res, 200, { ok: true, role: "connector", protocolVersion: 1 }); return; }
    if (path.startsWith("/api/auth/")) { await auth(req, res, path); return; }
    const publicPath = /^\/(?:_nuxt|__nuxt_devtools)(?:\/|$)/.test(path) || path === "/login" || path === "/login/" || path === "/favicon.svg";
    if (config.password && !publicPath && !hasSession(req, config.secretKey)) {
      if (/^\/(api|ws)(\/|$)/.test(path)) json(res, 401, { error: "未登录或令牌已过期" });
      else { res.writeHead(302, { location: "/login" }); res.end(); }
      return;
    }
    if (path === "/api/connector/nodes" && req.method === "GET") {
      json(res, 200, publicRegistry());
      return;
    }
    const removal = /^\/api\/connector\/nodes\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})$/.exec(path);
    if ((path === "/api/connector/nodes" && req.method === "POST") || (removal && req.method === "DELETE")) {
      // Registry edits grant access to new network targets. They require a
      // logged-in administrator even when passwordless viewing is enabled.
      if (!config.password || !hasSession(req, config.secretKey)) { json(res, 403, { error: "请先设置连接器面板密码并登录，再管理节点" }); return; }
      if (req.method === "POST") {
        if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") { json(res, 415, { error: "请使用 JSON 提交节点配置" }); return; }
        const node = await registry.add(await readJson(req));
        json(res, 201, { ...publicRegistry(), node });
      } else {
        await registry.remove(removal[1]);
        json(res, 200, publicRegistry());
      }
      return;
    }
    const status = /^\/api\/connector\/nodes\/([^/]+)\/status$/.exec(path);
    if (status && req.method === "GET") {
      const node = nodes.get(status[1]);
      if (!node) { json(res, 404, { error: "后端节点不存在" }); return; }
      try {
        const response = await fetch(`${node.url}/api/node`, { headers: nodeHeaders(node), signal: AbortSignal.timeout(3000), redirect: "error" });
        let state;
        if (response.ok) {
          const info = await response.json();
          state = info.role === "backend" && info.protocolVersion === 1 ? "online" : "incompatible";
        } else {
          await response.body?.cancel();
          state = response.status === 401 || response.status === 403 ? "unauthorized" : response.status === 404 ? "incompatible" : "offline";
        }
        json(res, 200, { id: node.id, status: state });
      } catch { json(res, 200, { id: node.id, status: "offline" }); }
      return;
    }
    if (/^\/api\/connector(?:\/|$)/.test(path)) { json(res, 404, { error: "接口不存在" }); return; }
    const route = resolveRoute(path);
    if (route?.error) { json(res, route.error, { error: route.error === 503 ? "尚未添加后端节点，请在节点管理中添加" : "后端节点或路由不存在" }); return; }
    if (route) prepare(req, url, route);
    try { await (route ? route.node.proxy : webProxy).web(req, res); }
    catch { json(res, 502, { error: route ? "后端节点暂时无法连接，请检查节点服务与网络" : "前端服务暂时无法连接", ...(route ? { nodeId: route.node.id } : {}) }); }
  }

  const server = createServer((req, res) => { handle(req, res).catch((error) => json(res, error.status ?? 500, { error: error.status ? error.message : "连接器请求失败" })); });
  // Node's default five-minute request limit is too short for large uploads.
  server.requestTimeout = 0;
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    if (!sameOrigin(req) || (config.password && !hasSession(req, config.secretKey))) { socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); return; }
    const url = new URL(req.url ?? "/", "http://connector.local");
    const route = resolveRoute(url.pathname);
    if (route?.error || (route && !route.path.startsWith("/ws/"))) { socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); return; }
    if (route) prepare(req, url, route);
    if (route) {
      route.node.sockets.add(socket);
      socket.once("close", () => route.node.sockets.delete(socket));
    }
    (route ? route.node.proxy : webProxy).ws(req, socket, {}, head).catch(() => socket.destroy());
  });
  server.destroyConnections = () => { for (const socket of sockets) socket.destroy(); };
  server.nodeRegistry = registry;
  return server;
}
