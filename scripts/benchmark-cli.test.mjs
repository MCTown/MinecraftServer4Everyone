import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";

test("task-file submits exact task without placing server directory in argv", async () => {
  const folder = await mkdtemp("/tmp/opencode/benchmark-cli-test-");
  const task = "部署 /tmp/opencode/benchmark-suite-20261021/example/workspace/servers/server_example，保留原始内容。";
  const taskFile = path.join(folder, "task.txt");
  await writeFile(taskFile, task);
  let submitted;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    res.setHeader("Content-Type", "application/json");
    let reply = {};
    if (req.url === "/api/auth/login") res.setHeader("Set-Cookie", "session=test-only");
    else if (req.url.endsWith("/requests")) { submitted = JSON.parse(body); reply = { turnId: "turn_test" }; }
    else if (req.url.endsWith("/executions")) reply = [{ id: "turn_test", status: "completed", workflowScheduling: 2, deploymentRun: { version: 1, task } }];
    else if (req.url.endsWith("/executions/turn_test")) reply = { id: "turn_test", status: "completed", workflowScheduling: 2, deploymentRun: { version: 1, task }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), steps: [], toolCalls: [] };
    res.end(JSON.stringify(reply));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const proc = spawn(process.execPath, ["scripts/benchmark.mjs", "--base-url", `http://127.0.0.1:${server.address().port}`, "--server-id", "server_example", "--task-file", taskFile, "--json"], { cwd: path.resolve(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = "";
    proc.stdout.on("data", chunk => output += chunk);
    proc.stderr.on("data", chunk => errors += chunk);
    assert.ok(!proc.spawnargs.some(arg => arg.includes("/workspace/servers/")));
    const [code] = await once(proc, "exit");
    assert.equal(code, 0, errors);
    assert.equal(submitted.content, task);
    assert.equal(JSON.parse(output).status, "completed");
    assert.equal(JSON.parse(output).details.length, 1);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(folder, { recursive: true, force: true });
  }
});
