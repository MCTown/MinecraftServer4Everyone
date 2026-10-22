#!/usr/bin/env node
import http from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

const root = process.env.BENCH_RESULT_DIR;
const target = process.env.BENCH_UPSTREAM_URL?.replace(/\/$/, "");
if (!root || !target || !process.env.BENCH_MODEL_KEY) throw new Error("Missing benchmark proxy environment");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const save = (file, value) => appendFileSync(path.join(root, file), JSON.stringify(value) + "\n", { mode: 0o600 });

// Forward unchanged bytes; observe the upstream's usage instead of SDK-normalized counts.
const server = http.createServer(async (req, res) => {
  const id = randomUUID();
  const start = Date.now();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 600_000);
  const record = { id, startedAt: new Date(start).toISOString(), method: req.method, path: req.url };
  let disconnected = false;
  res.on("close", () => { if (!res.writableEnded) { disconnected = true; abort.abort(); } });
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    let payload;
    try { payload = JSON.parse(body.toString()); } catch { /* Non-model GETs have no JSON body. */ }
    if (payload) {
      record.model = payload.model;
      record.stream = payload.stream;
      record.bodySha256 = hash(body);
      record.messageCount = payload.messages?.length ?? payload.input?.length ?? null;
      record.toolNames = payload.tools?.map((t) => t.function?.name ?? t.name);
      record.reasoningEffort = payload.reasoning_effort ?? payload.reasoning?.effort ?? null;
      save("model-requests.jsonl", { id, startedAt: record.startedAt, request: payload });
    }
    const suffix = (req.url ?? "/").replace(/^\/v1(?=\/|$)/, "");
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (!["host", "connection", "content-length", "authorization", "accept-encoding"].includes(key) && value !== undefined) headers[key] = value;
    }
    headers.authorization = `Bearer ${process.env.BENCH_MODEL_KEY}`;
    headers["accept-encoding"] = "identity";
    const upstream = await fetch(target + suffix, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body, signal: abort.signal });
    record.status = upstream.status;
    record.headersAt = new Date().toISOString();
    res.statusCode = upstream.status;
    for (const name of ["content-type", "cache-control"]) if (upstream.headers.has(name)) res.setHeader(name, upstream.headers.get(name));
    res.flushHeaders();
    let buffer = "";
    let jsonBody = "";
    const decoder = new TextDecoder();
    const sse = upstream.headers.get("content-type")?.includes("text/event-stream");
    const observe = (text) => {
      try {
        const event = JSON.parse(text);
        const usage = event.usage ?? event.response?.usage;
        if (usage) { record.usage = usage; record.responseId = event.id ?? event.response?.id; }
      } catch { /* SSE comments and [DONE] are not JSON. */ }
    };
    if (upstream.body) for await (const chunk of upstream.body) {
      if (disconnected) break;
      if (!res.write(chunk)) await new Promise((resolve) => { res.once("drain", resolve); res.once("close", resolve); });
      const text = decoder.decode(chunk, { stream: true });
      if (sse) {
        buffer += text;
        const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? "";
        for (const line of lines) if (line.startsWith("data:")) observe(line.slice(5).trim());
      } else if (jsonBody.length < 20_000_000) jsonBody += text;
    }
    if (sse && buffer.startsWith("data:")) observe(buffer.slice(5).trim());
    if (!sse) observe(jsonBody);
    res.end();
  } catch (error) {
    record.error = String(error);
    if (!res.headersSent) { res.statusCode = 502; res.end(JSON.stringify({ error: "Benchmark upstream request failed" })); }
    else res.destroy();
  } finally {
    clearTimeout(timer);
    record.finishedAt = new Date().toISOString();
    record.durationMs = Date.now() - start;
    record.disconnected = disconnected;
    save("wire-usage.jsonl", record);
  }
});
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  writeFileSync(path.join(root, "proxy-ready.json"), JSON.stringify({ port, pid: process.pid }), { mode: 0o600 });
});
process.on("SIGTERM", () => { server.close(); setTimeout(() => process.exit(0), 1000).unref(); });
