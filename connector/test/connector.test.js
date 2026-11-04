import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { createConnector } from "../server.js";
import { parseNodeConfig, loadConnectorConfig } from "../config.js";
import { generateAuthToken, verifyAuthToken } from "../auth.js";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

function cleanup(t, server) {
  t.after(async () => {
    server.destroyConnections?.();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
}

async function backend(t, id, accessKey) {
  let calls = 0;
  let firstChunk;
  const sockets = new WebSocketServer({ noServer: true });
  const server = createServer(async (req, res) => {
    calls++;
    if (req.headers["x-app-key"] !== accessKey) { res.writeHead(401).end(); return; }
    if (req.url === "/api/node") { res.end(JSON.stringify({ role: "backend", protocolVersion: 1 })); return; }
    let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; firstChunk?.(); }
    res.setHeader("set-cookie", "mcsa_token=backend-must-not-overwrite; Path=/");
    if (req.url.startsWith("/api/download")) {
      res.setHeader("content-disposition", 'attachment; filename="test.txt"');
      res.end(`file:${id}`);
    } else res.end(JSON.stringify({ id, url: req.url, method: req.method, key: req.headers["x-app-key"], cookie: req.headers.cookie ?? null, auth: req.headers.authorization ?? null, bytes }));
  });
  server.on("upgrade", (req, socket, head) => {
    if (req.headers["x-app-key"] !== accessKey) { socket.destroy(); return; }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ id, url: req.url, key: req.headers["x-app-key"], cookie: req.headers.cookie ?? null, auth: req.headers.authorization ?? null }));
      ws.on("message", (message) => ws.send(message));
    });
  });
  cleanup(t, server);
  t.after(() => { for (const client of sockets.clients) client.terminate(); sockets.close(); });
  return { url: await listen(server), get calls() { return calls; }, onChunk(fn) { firstChunk = fn; } };
}

test("registry validates targets, unique IDs, default and server-side credential references", () => {
  const node = { id: "one", name: "机器一", url: "http://127.0.0.1:8787", accessKey: "node-key" };
  assert.equal(parseNodeConfig({ nodes: [node] }).defaultNodeId, "one");
  assert.equal(parseNodeConfig({ nodes: [{ ...node, accessKey: undefined, accessKeyEnv: "NODE_KEY" }] }, { NODE_KEY: "from-env" }).nodes[0].accessKey, "from-env");
  for (const url of ["file:///etc/passwd", "http://user:pass@localhost", "https://localhost/api", "http://localhost/?token=x", "http://localhost/#x"]) {
    assert.throws(() => parseNodeConfig({ nodes: [{ ...node, url }] }));
  }
  assert.throws(() => parseNodeConfig({ nodes: [node, node] }));
  assert.throws(() => parseNodeConfig({ nodes: [{ ...node, id: "../bad" }] }));
  assert.throws(() => parseNodeConfig({ nodes: [{ ...node, accessKey: "" }] }));
  assert.throws(() => parseNodeConfig({ nodes: [node], defaultNodeId: "missing" }));
  assert.throws(() => loadConnectorConfig({ PROXY_API_TARGET: "http://remote.example" }));
  assert.equal(loadConnectorConfig({}).nodes[0].legacyLocalAuth, true);
});

test("session signatures reject corruption, wrong keys and malformed values", () => {
  const token = generateAuthToken("secret");
  assert.equal(verifyAuthToken(token, "secret"), true);
  for (const bad of [null, "", "a.b", `${token}.extra`, token.slice(1)]) assert.equal(verifyAuthToken(bad, "secret"), false);
  assert.equal(verifyAuthToken(token, "wrong"), false);
});

test("connector isolates two live nodes over HTTP, uploads, downloads and WebSocket", { timeout: 20_000 }, async (t) => {
  const a = await backend(t, "a", "key-a");
  const b = await backend(t, "b", "key-b");
  const web = createServer((_req, res) => res.end("frontend"));
  cleanup(t, web);
  const webTarget = await listen(web);
  const config = { ...parseNodeConfig({ defaultNodeId: "a", nodes: [
    { id: "a", name: "节点 A", url: a.url, accessKey: "key-a" },
    { id: "b", name: "节点 B", url: b.url, accessKey: "key-b" },
    { id: "dead", name: "离线节点", url: "http://127.0.0.1:1", accessKey: "key-dead" }
  ] }), password: "panel-password", secretKey: "panel-secret", webTarget };
  const connector = createConnector(config);
  cleanup(t, connector);
  const origin = await listen(connector);
  const get = (path, options) => fetch(`${origin}${path}`, options);
  assert.equal((await get("/api/connector/nodes")).status, 401);
  assert.equal((await get("/api/nodes/a/servers")).status, 401);
  assert.equal((await get("/", { redirect: "manual" })).status, 302);
  assert.equal(await (await get("/login")).text(), "frontend");
  assert.equal((await (await get("/health")).json()).role, "connector");
  assert.equal((await get("/api/auth/login", { method: "POST", body: '{"password":"wrong"}' })).status, 401);
  const login = await get("/api/auth/login", { method: "POST", body: '{"password":"panel-password"}' });
  const token = (await login.json()).token;
  assert.match(login.headers.get("set-cookie"), /HttpOnly/);
  const headers = { cookie: `mcsa_token=${token}`, authorization: `Bearer ${token}`, "x-app-key": "attacker-supplied" };
  assert.equal((await get("/api/auth/verify", { headers })).status, 200);
  const registryText = await (await get("/api/connector/nodes", { headers })).text();
  assert.deepEqual(JSON.parse(registryText).nodes[0], { id: "a", name: "节点 A" });
  for (const secret of ["key-a", "key-b", a.url, b.url]) assert.equal(registryText.includes(secret), false);

  for (const id of ["a", "b"]) {
    const response = await get(`/api/nodes/${id}/servers/same-id?path=server%2Fconfig.yml&token=${token}`, { headers });
    const data = await response.json();
    assert.equal(data.id, id);
    assert.equal(data.key, `key-${id}`);
    assert.equal(data.cookie, null);
    assert.equal(data.auth, null);
    assert.equal(data.url, "/api/servers/same-id?path=server%2Fconfig.yml");
    assert.equal(response.headers.get("set-cookie"), null);
    const download = await get(`/api/nodes/${id}/download?path=a.txt`, { headers });
    assert.equal(await download.text(), `file:${id}`);
    assert.match(download.headers.get("content-disposition"), /attachment/);
    assert.equal((await (await get(`/api/connector/nodes/${id}/status`, { headers })).json()).status, "online");
  }
  assert.equal((await (await get("/api/servers", { headers })).json()).id, "a", "legacy routes only use configured default");
  assert.equal((await get("/api/nodes/missing/servers", { headers })).status, 404);
  assert.equal((await get("/api/nodes/a/auth/login", { headers })).status, 404);
  assert.equal((await get("/api/nodes/a/connector/nodes", { headers })).status, 404);
  assert.equal((await get("/api/nodes/dead/servers", { headers })).status, 502);
  assert.equal((await (await get("/api/connector/nodes/dead/status", { headers })).json()).status, "offline");
  assert.equal((await get("/api/nodes/a/start", { method: "POST", headers: { ...headers, origin: "https://evil.example" } })).status, 403);

  // An upstream must receive data BEFORE the browser finishes its upload.
  let received;
  const firstChunk = new Promise((resolve) => { received = resolve; });
  a.onChunk(received);
  const upload = request(`${origin}/api/nodes/a/upload`, { method: "POST", headers });
  const result = new Promise((resolve, reject) => {
    upload.on("response", async (res) => {
      const chunks = [];
      for await (const chunk of res) chunks.push(chunk);
      resolve(JSON.parse(Buffer.concat(chunks).toString()));
    });
    upload.on("error", reject);
  });
  upload.write(Buffer.alloc(256 * 1024, 65));
  await firstChunk;
  upload.end(Buffer.alloc(256 * 1024, 66));
  assert.equal((await result).bytes, 512 * 1024);
  const before = b.calls;
  await get("/api/nodes/b/start", { method: "POST", headers, body: "start" });
  assert.equal(b.calls, before + 1, "mutations execute exactly once");

  for (const id of ["a", "b"]) {
    const ws = new WebSocket(`${origin.replace("http:", "ws:")}/ws/nodes/${id}/console/same-id?token=${token}`);
    t.after(() => ws.terminate());
    const [message] = await once(ws, "message");
    assert.deepEqual(JSON.parse(message.toString()), { id, url: "/ws/console/same-id", key: `key-${id}`, cookie: null, auth: null });
    ws.send(`command:${id}`);
    const [echo] = await once(ws, "message");
    assert.equal(echo.toString(), `command:${id}`);
    ws.close();
    await once(ws, "close");
  }
  const ws = new WebSocket(`${origin.replace("http:", "ws:")}/ws/nodes/a/console/test`);
  ws.on("error", () => {});
  const [, response] = await once(ws, "unexpected-response");
  assert.equal(response.statusCode, 401);
  ws.terminate();
  const logout = await get("/api/auth/logout", { method: "POST", headers });
  assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
});
