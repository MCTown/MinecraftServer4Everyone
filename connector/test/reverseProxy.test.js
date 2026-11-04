import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { test } from "node:test";
import { createProxyServer } from "httpxy";
import { WebSocket, WebSocketServer } from "ws";
import { createConnector } from "../server.js";

async function listen(t, server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.destroyConnections?.();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function setup(t) {
  const directory = await mkdtemp("/tmp/opencode/connector-proxy-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const upstream = createServer((req, res) => {
    if (req.headers["x-app-key"] !== "node-key") { res.writeHead(401).end(); return; }
    res.end(JSON.stringify({ role: "backend", protocolVersion: 1 }));
  });
  const sockets = new WebSocketServer({ noServer: true });
  upstream.on("upgrade", (req, socket, head) => {
    if (req.headers["x-app-key"] !== "node-key") { socket.destroy(); return; }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      ws.send("ready");
      ws.on("message", (message) => ws.send(message));
    });
  });
  t.after(() => { for (const ws of sockets.clients) ws.terminate(); sockets.close(); });
  const target = await listen(t, upstream);
  const connector = createConnector({ nodes: [], defaultNodeId: "", password: "panel-password", secretKey: "panel-secret", registryFile: `${directory}/nodes.json`, webTarget: target });
  const internal = await listen(t, connector);
  // Match a reverse proxy that replaces Host with the internal upstream.
  const proxy = createProxyServer({ target: internal, changeOrigin: true, xfwd: true, ws: true });
  const gateway = createServer((req, res) => proxy.web(req, res).catch(() => { res.writeHead(502); res.end(); }));
  const connections = new Set();
  gateway.on("connection", (socket) => { connections.add(socket); socket.once("close", () => connections.delete(socket)); });
  gateway.destroyConnections = () => { for (const socket of connections) socket.destroy(); };
  gateway.on("upgrade", (req, socket, head) => proxy.ws(req, socket, {}, head).catch(() => socket.destroy()));
  return { origin: await listen(t, gateway), target };
}

test("rewritten Host needs no public-origin configuration for login, node CRUD or WebSocket", { timeout: 20_000 }, async (t) => {
  const { origin, target } = await setup(t);
  // No Fetch Metadata, as on browser WebSocket handshakes / older proxies.
  const headers = { origin: "https://external-panel.example:8443", "content-type": "application/json", "x-forwarded-proto": "https" };
  const login = await fetch(`${origin}/api/auth/login`, { method: "POST", headers, body: JSON.stringify({ password: "panel-password" }) });
  assert.equal(login.status, 200, await login.clone().text());
  headers.cookie = login.headers.get("set-cookie").split(";")[0];
  assert.match(login.headers.get("set-cookie"), /HttpOnly/);
  assert.match(login.headers.get("set-cookie"), /; Secure/);
  const added = await fetch(`${origin}/api/connector/nodes`, { method: "POST", headers, body: JSON.stringify({ name: "Proxied backend", url: target, accessKey: "node-key" }) });
  assert.equal(added.status, 201);
  const { node } = await added.json();
  assert.equal((await (await fetch(`${origin}/api/connector/nodes/${node.id}/status`, { headers })).json()).status, "online");
  const ws = new WebSocket(`${origin.replace("http:", "ws:")}/ws/nodes/${node.id}/console/test`, { headers });
  t.after(() => ws.terminate());
  assert.equal((await once(ws, "message"))[0].toString(), "ready");
  const echo = once(ws, "message");
  ws.send("command");
  assert.equal((await echo)[0].toString(), "command");
  const closed = once(ws, "close");
  assert.equal((await fetch(`${origin}/api/connector/nodes/${node.id}`, { method: "DELETE", headers })).status, 200);
  await closed;
  const logout = await fetch(`${origin}/api/auth/logout`, { method: "POST", headers });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
});

test("Origin and Fetch Metadata do not filter requests, but HTTP and WebSocket still require authentication", { timeout: 20_000 }, async (t) => {
  const { origin, target } = await setup(t);
  const headers = { origin: "https://other.example", "sec-fetch-site": "cross-site", "content-type": "application/json" };
  for (const method of ["POST", "DELETE"]) {
    assert.equal((await fetch(`${origin}/api/connector/nodes${method === "DELETE" ? "/missing" : ""}`, { method, headers })).status, 401);
  }
  const denied = new WebSocket(`${origin.replace("http:", "ws:")}/ws/nodes/missing/console/test`, { headers });
  denied.on("error", () => {});
  t.after(() => denied.terminate());
  const [, response] = await once(denied, "unexpected-response");
  assert.equal(response.statusCode, 401);
  denied.terminate();

  const wrongPassword = await fetch(`${origin}/api/auth/login`, { method: "POST", headers, body: '{"password":"wrong"}' });
  assert.equal(wrongPassword.status, 401);
  const login = await fetch(`${origin}/api/auth/login`, { method: "POST", headers, body: '{"password":"panel-password"}' });
  assert.equal(login.status, 200);
  headers.cookie = login.headers.get("set-cookie").split(";")[0];
  for (const source of ["https://other.example", "null", "not-an-origin"]) {
    assert.equal((await fetch(`${origin}/api/nodes/missing/start`, { method: "POST", headers: { ...headers, origin: source } })).status, 404, "source headers must not replace routing or auth checks");
  }
  const added = await fetch(`${origin}/api/connector/nodes`, { method: "POST", headers, body: JSON.stringify({ name: "Other origin", url: target, accessKey: "node-key" }) });
  assert.equal(added.status, 201);
  assert.equal(added.headers.get("access-control-allow-origin"), null, "removing source checks does not enable CORS");
  const { node } = await added.json();
  const ws = new WebSocket(`${origin.replace("http:", "ws:")}/ws/nodes/${node.id}/console/test`, { headers });
  t.after(() => ws.terminate());
  assert.equal((await once(ws, "message"))[0].toString(), "ready");
  const closed = once(ws, "close");
  ws.close();
  await closed;
  assert.equal((await fetch(`${origin}/api/connector/nodes/${node.id}`, { method: "DELETE", headers })).status, 200);
});
