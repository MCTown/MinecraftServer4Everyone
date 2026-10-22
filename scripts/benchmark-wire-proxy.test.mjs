import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

test("wire observer preserves JSON/SSE and does not expose Authorization", async () => {
  const root = await mkdtemp("/tmp/opencode/benchmark-wire-test-");
  const seen = [];
  const usage = { prompt_tokens: 3, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 19 } };
  const upstream = http.createServer(async (req, res) => {
    const parts = [];
    for await (const chunk of req) parts.push(chunk);
    const body = Buffer.concat(parts).toString();
    seen.push({ url: req.url, authorization: req.headers.authorization, body });
    if (JSON.parse(body).stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
      const line = `data: ${JSON.stringify({ usage })}\n\ndata: [DONE]\n\n`;
      res.write(line.slice(0, 22));
      res.end(line.slice(22));
    } else {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "hello" } }], usage }));
    }
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const proc = spawn(process.execPath, ["scripts/benchmark-wire-proxy.mjs"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, BENCH_RESULT_DIR: root, BENCH_UPSTREAM_URL: `http://127.0.0.1:${upstream.address().port}/api/v1`, BENCH_MODEL_KEY: "test-only-secret" },
    stdio: "ignore"
  });
  try {
    let ready;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { ready = JSON.parse(await readFile(path.join(root, "proxy-ready.json"))); break; } catch { await delay(20); }
    }
    assert.ok(ready);
    for (const stream of [false, true]) {
      const body = JSON.stringify({ model: "test-model", stream, messages: [{ role: "user", content: "ping" }] });
      const response = await fetch(`http://127.0.0.1:${ready.port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer local-observer" }, body });
      assert.equal(response.status, 200);
      const text = await response.text();
      if (stream) assert.ok(text.endsWith("data: [DONE]\n\n"));
      else assert.deepEqual(JSON.parse(text).usage, usage);
      assert.equal(seen.at(-1).url, "/api/v1/chat/completions");
      assert.equal(seen.at(-1).body, body);
      assert.equal(seen.at(-1).authorization, "Bearer test-only-secret");
    }
    const wireText = await readFile(path.join(root, "wire-usage.jsonl"), "utf8");
    const records = wireText.trim().split("\n").map(JSON.parse);
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((row) => row.usage), [usage, usage]);
    assert.ok(!wireText.includes("test-only-secret"));
    const requests = await readFile(path.join(root, "model-requests.jsonl"), "utf8");
    assert.ok(!requests.includes("test-only-secret"));
  } finally {
    if (proc.exitCode === null) { const exit = once(proc, "exit"); proc.kill("SIGTERM"); await exit; }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
