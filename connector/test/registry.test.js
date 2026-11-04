import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { NodeRegistry } from "../registry.js";
import { createConnector } from "../server.js";
import { generateAuthToken } from "../auth.js";
import { loadConnectorConfig } from "../config.js";

async function temporary(t) {
  const directory = await mkdtemp("/tmp/opencode/node-registry-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

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

const seed = { id: "local", name: "Local", url: "http://127.0.0.1:8787", accessKey: "ephemeral-launch-key" };
const added = { name: "远程节点", url: "http://10.0.0.12:8787", accessKey: "private-key-never-public" };

test("private overlay persists additions and removals without saving ephemeral seed credentials", async (t) => {
  const directory = await temporary(t);
  const config = { nodes: [seed], defaultNodeId: "local", registryFile: `${directory}/private/nodes.json` };
  const registry = new NodeRegistry(config);
  const node = await registry.add(added);
  assert.match(node.id, /^node_[a-f0-9]{32}$/);
  assert.deepEqual(Object.keys(node).sort(), ["id", "name"]);
  assert.equal(registry.snapshot().nodes.length, 2);
  const saved = await readFile(config.registryFile, "utf8");
  assert.ok(saved.includes(added.accessKey));
  assert.ok(!saved.includes(seed.accessKey));
  assert.equal((await stat(config.registryFile)).mode & 0o777, 0o600);
  assert.equal((await stat(`${directory}/private`)).mode & 0o777, 0o700);
  const restarted = new NodeRegistry({ ...config, nodes: [{ ...seed, accessKey: "fresh-launch-key", url: "http://127.0.0.1:8888" }] });
  assert.equal(restarted.snapshot().nodes[0].accessKey, "fresh-launch-key");
  assert.equal(restarted.snapshot().nodes[1].accessKey, added.accessKey);
  await restarted.remove("local");
  assert.equal(restarted.snapshot().defaultNodeId, node.id);
  const afterRemoval = new NodeRegistry(config);
  assert.deepEqual(afterRemoval.snapshot().nodes.map((entry) => entry.id), [node.id]);
  await afterRemoval.remove(node.id);
  assert.deepEqual(new NodeRegistry(config).snapshot(), { nodes: [], defaultNodeId: "" });
  const replacement = await afterRemoval.add(added);
  assert.notEqual(replacement.id, node.id, "re-added machines cannot inherit a deleted ID's outbox or drafts");
});

test("mutations serialize, reject duplicates, validate targets, and never overwrite corrupt state", async (t) => {
  const directory = await temporary(t);
  const config = { nodes: [], defaultNodeId: "", registryFile: `${directory}/nodes.json` };
  const registry = new NodeRegistry(config);
  const concurrent = await Promise.allSettled([registry.add(added), registry.add(added)]);
  assert.equal(concurrent.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(concurrent.find((item) => item.status === "rejected").reason.status, 409);
  await Promise.all([registry.add({ ...added, url: "http://10.0.0.13" }), registry.add({ ...added, url: "http://10.0.0.14" })]);
  assert.equal(new NodeRegistry(config).snapshot().nodes.length, 3);
  const original = await readFile(config.registryFile, "utf8");
  for (const input of [null, [], { ...added, accessKeyEnv: "STOLEN_ENV" }, { ...added, id: "local" }, { ...added, url: "file:///etc/passwd" }, { ...added, accessKey: "bad\r\nheader" }, { ...added, accessKey: "密钥" }, { ...added, name: "" }]) {
    await assert.rejects(registry.add(input), { status: 400 });
  }
  await assert.rejects(registry.remove("unknown"), { status: 404 });
  assert.equal(await readFile(config.registryFile, "utf8"), original);
  await writeFile(config.registryFile, "invalid-json");
  assert.throws(() => new NodeRegistry(config), /不会自动覆盖/);
  assert.equal(await readFile(config.registryFile, "utf8"), "invalid-json");
});

test("failed persistence leaves live routes unchanged and a later retry is possible", async (t) => {
  const directory = await temporary(t);
  const parent = `${directory}/not-a-directory`;
  await writeFile(parent, "keep-this-file");
  const config = { nodes: [seed], defaultNodeId: "local", registryFile: `${directory}/initially-missing/nodes.json` };
  const registry = new NodeRegistry(config);
  config.registryFile = `${parent}/nodes.json`;
  await assert.rejects(registry.add(added), { status: 503 });
  await assert.rejects(registry.remove(seed.id), { status: 503 });
  assert.equal(registry.snapshot().nodes.length, 1);
  assert.equal(await readFile(parent, "utf8"), "keep-this-file");
  config.registryFile = `${directory}/working/nodes.json`;
  await registry.add(added);
  assert.equal(registry.snapshot().nodes.length, 2);
});

test("standalone connector can start empty without a seed file; state and seed paths cannot overlap", () => {
  assert.deepEqual(loadConnectorConfig({ CONNECTOR_ONLY: "true" }).nodes, []);
  assert.throws(() => loadConnectorConfig({ CONNECTOR_NODES_FILE: "/same.json", CONNECTOR_STATE_FILE: "/same.json" }), /不能.*相同/);
});

test("authenticated node CRUD is immediate, private and durable, closes removed tunnels, and supports an empty registry", { timeout: 20_000 }, async (t) => {
  const directory = await temporary(t);
  let backendCalls = 0;
  const upstream = createServer((req, res) => {
    backendCalls++;
    if (req.headers["x-app-key"] !== added.accessKey) { res.writeHead(401).end(); return; }
    res.end(JSON.stringify(req.url === "/api/node" ? { role: "backend", protocolVersion: 1 } : { machine: "new-node" }));
  });
  const wss = new WebSocketServer({ noServer: true });
  t.after(() => { for (const client of wss.clients) client.terminate(); wss.close(); });
  upstream.on("upgrade", (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => ws.send("connected")));
  const upstreamUrl = await listen(t, upstream);
  const config = { nodes: [], defaultNodeId: "", password: "password", secretKey: "panel-secret", webTarget: upstreamUrl, registryFile: `${directory}/registry.json` };
  const connector = createConnector(config);
  const origin = await listen(t, connector);
  const token = generateAuthToken(config.secretKey);
  const headers = { cookie: `mcsa_token=${token}`, "content-type": "application/json" };
  const input = { ...added, url: upstreamUrl };
  const post = (value, custom = headers) => fetch(`${origin}/api/connector/nodes`, { method: "POST", headers: custom, body: JSON.stringify(value) });
  assert.equal((await post(input, { "content-type": "application/json" })).status, 401);
  assert.equal((await post(input, { ...headers, origin: "https://attacker.example" })).status, 403);
  assert.equal((await post(input, { ...headers, "content-type": "text/plain" })).status, 415);
  assert.equal((await fetch(`${origin}/api/servers`, { headers })).status, 503);
  const response = await post(input);
  assert.equal(response.status, 201);
  const text = await response.text();
  assert.ok(!text.includes(added.accessKey));
  assert.ok(!text.includes(upstreamUrl));
  const result = JSON.parse(text);
  assert.equal(result.canManage, true);
  const id = result.node.id;
  assert.equal(result.defaultNodeId, id);
  assert.equal((await post(input)).status, 409);
  const active = await fetch(`${origin}/api/nodes/${id}/servers`, { headers });
  assert.deepEqual(await active.json(), { machine: "new-node" });
  const socket = new WebSocket(`${origin.replace("http:", "ws:")}/ws/nodes/${id}/console/test?token=${token}`);
  socket.on("error", () => {});
  t.after(() => socket.terminate());
  await once(socket, "message");
  const closed = once(socket, "close");
  const callsBeforeRemove = backendCalls;
  const removed = await fetch(`${origin}/api/connector/nodes/${id}`, { method: "DELETE", headers });
  assert.equal(removed.status, 200);
  assert.deepEqual((await removed.json()).nodes, []);
  await closed;
  assert.equal(backendCalls, callsBeforeRemove, "removal never calls a backend stop/delete API");
  assert.equal((await fetch(`${origin}/api/nodes/${id}/servers`, { headers })).status, 404);
  assert.equal((await fetch(`${origin}/api/servers`, { headers })).status, 503);
  assert.equal((await fetch(`${origin}/api/connector/nodes/${id}`, { method: "DELETE", headers })).status, 404);
  assert.deepEqual(new NodeRegistry(config).snapshot().nodes, []);
  const another = await post(input);
  assert.equal(another.status, 201);
  const nextId = (await another.json()).node.id;
  assert.notEqual(nextId, id);
  const restarted = createConnector(config);
  const restartedOrigin = await listen(t, restarted);
  assert.equal((await fetch(`${restartedOrigin}/api/nodes/${nextId}/servers`, { headers })).status, 200);
});

test("passwordless viewing never grants node administration", async (t) => {
  const directory = await temporary(t);
  const connector = createConnector({ nodes: [], defaultNodeId: "", password: "", secretKey: "secret", webTarget: "http://127.0.0.1:1", registryFile: `${directory}/nodes.json` });
  const origin = await listen(t, connector);
  const response = await fetch(`${origin}/api/connector/nodes`);
  assert.equal((await response.json()).canManage, false);
  assert.equal((await fetch(`${origin}/api/connector/nodes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(added) })).status, 403);
});
