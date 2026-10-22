import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { listAgentToolInfos } from "../src/agent/toolCatalog.js";
import { createAgentTools } from "../src/agent/tools.js";
import { createRunShellCommandTool } from "../src/agent/tools/shellTool.js";
import type { AgentToolContext } from "../src/agent/toolKit.js";

async function harness(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-shell-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const serverDirectory = path.join(root, "instance");
  const nestedDirectory = path.join(serverDirectory, "server with spaces");
  await mkdir(nestedDirectory, { recursive: true });
  const confirmations: string[] = [];
  const logs: { stream: string; text: string }[] = [];
  const controller = new AbortController();
  const ctx = {
    getServerId: () => "shell-test",
    serverService: { requireServer: async () => ({ directory: serverDirectory }) },
    signal: controller.signal,
    confirm: async (request: { description: string }) => { confirmations.push(request.description); },
    consoleLog: (text: string, stream: "stdout" | "stderr" | "system" = "system") => { logs.push({ text, stream }); }
  } as unknown as AgentToolContext;
  const tool = createRunShellCommandTool(ctx);
  const script = async (name: string, content: string) => {
    const target = path.join(serverDirectory, `${name}.cjs`);
    await writeFile(target, content);
    return `"${process.execPath}" "${target}"`;
  };
  return { root, serverDirectory, nestedDirectory, ctx, tool, controller, confirmations, logs, script };
}

test("shell is registered by default and appears in the Tools catalog", () => {
  const tools = createAgentTools({} as AgentToolContext);
  assert.equal(tools.filter((tool) => tool.definition.function.name === "run_shell_command").length, 1);
  assert.ok(listAgentToolInfos().some((tool) => tool.name === "run_shell_command"));
});

test("shell executes compound commands in the requested cwd and captures both output streams", async (t) => {
  const { tool, script, nestedDirectory, confirmations, logs } = await harness(t);
  const command = await script("inspect", `
    const fs = require('node:fs');
    console.log(JSON.stringify({ cwd: process.cwd(), input: fs.readFileSync('input.txt', 'utf8').trim(), arg: process.argv[2] }));
    console.error('诊断输出');
  `);
  const result = JSON.parse(await tool.execute({ command: `echo input > input.txt && ${command} "arg with spaces"`, cwd: "server with spaces" }));
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.outputTruncated, false);
  assert.deepEqual(JSON.parse(result.stdout), { cwd: nestedDirectory, input: "input", arg: "arg with spaces" });
  assert.match(result.stderr, /诊断输出/);
  assert.equal(confirmations.length, 1);
  assert.ok(confirmations[0]!.includes(nestedDirectory));
  assert.ok(confirmations[0]!.includes(command));
  assert.ok(logs.some((log) => log.stream === "stderr" && log.text.includes("诊断输出")));
});

test("shell supports pipelines and uses the server root by default", async (t) => {
  const { tool, script, serverDirectory } = await harness(t);
  const command = await script("pipe", `
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', text => { input += text; });
    process.stdin.on('end', () => console.log(input.trim().toUpperCase()));
  `);
  const result = JSON.parse(await tool.execute({ command: `echo hello | ${command}` }));
  assert.equal(result.stdout.trim(), "HELLO");
  assert.equal(result.cwd, serverDirectory);
});

test("shell applies the configured download proxy to commands", async (t) => {
  const { tool, script, ctx } = await harness(t);
  ctx.downloadProxyUrl = () => "http://127.0.0.1:12345";
  const command = await script("env", "console.log(JSON.stringify([process.env.HTTP_PROXY, process.env.https_proxy]))");
  const result = JSON.parse(await tool.execute({ command }));
  assert.deepEqual(JSON.parse(result.stdout), ["http://127.0.0.1:12345/", "http://127.0.0.1:12345/"]);
});

test("nonzero exits preserve stdout, stderr and exit code as a tool error", async (t) => {
  const { tool, script } = await harness(t);
  const command = await script("fail", "console.log('partial output'); console.error('failure detail'); process.exitCode = 7;");
  await assert.rejects(tool.execute({ command }), (error: Error) => {
    assert.match(error.message, /"exitCode": 7/);
    assert.match(error.message, /partial output/);
    assert.match(error.message, /failure detail/);
    assert.match(error.message, /"ok": false/);
    return true;
  });
});

test("large output is bounded in presentation while the durable job stream retains all text", async (t) => {
  const { tool, script, logs, ctx } = await harness(t);
  const chunks = { stdout: "", stderr: "" };
  ctx.jobOutput = (text, stream) => { chunks[stream] += text; };
  const command = await script("output", `
    process.stdout.write('x'.repeat(200000) + '最后输出');
    process.stderr.write('y'.repeat(200000) + '最后错误');
  `);
  const result = JSON.parse(await tool.execute({ command }));
  assert.equal(result.outputTruncated, true);
  assert.equal(result.stdout.length, 4000);
  assert.equal(result.stderr.length, 4000);
  assert.ok(result.stdout.endsWith("最后输出"));
  assert.ok(result.stderr.endsWith("最后错误"));
  assert.ok(logs.filter((log) => log.stream !== "system").reduce((sum, log) => sum + log.text.length, 0) <= 16000);
  assert.equal(chunks.stdout, "x".repeat(200000) + "最后输出");
  assert.equal(chunks.stderr, "y".repeat(200000) + "最后错误");
});

test("invalid command, timeout and cwd inputs never request execution", async (t) => {
  const { tool, serverDirectory, confirmations } = await harness(t);
  for (const command of ["", "  ", "echo\0bad", 123, null]) {
    await assert.rejects(tool.execute({ command }), /command/);
  }
  for (const timeoutMs of [0, -1, 1.5, 600001, NaN, Infinity, "1000", null]) {
    await assert.rejects(tool.execute({ command: "echo invalid", timeoutMs }), /timeoutMs/);
  }
  for (const cwd of ["..", "../instance", serverDirectory, "C:\\Windows", "missing", 123, "bad\0path"]) {
    await assert.rejects(tool.execute({ command: "echo invalid", cwd }));
  }
  await writeFile(path.join(serverDirectory, "file.txt"), "not a directory");
  await assert.rejects(tool.execute({ command: "echo invalid", cwd: "file.txt" }), /目录/);
  assert.deepEqual(confirmations, []);
});

test("cwd cannot follow a symlink outside the current server", { skip: process.platform === "win32" }, async (t) => {
  const { root, tool, serverDirectory, confirmations } = await harness(t);
  await symlink(root, path.join(serverDirectory, "outside"));
  await assert.rejects(tool.execute({ command: "echo invalid", cwd: "outside" }), /outside/);
  assert.deepEqual(confirmations, []);
});

test("a cwd replaced while waiting for confirmation is revalidated", { skip: process.platform === "win32" }, async (t) => {
  const { root, tool, ctx, nestedDirectory } = await harness(t);
  ctx.confirm = async () => {
    await rm(nestedDirectory, { recursive: true });
    await symlink(root, nestedDirectory);
  };
  await assert.rejects(tool.execute({ command: "echo invalid", cwd: "server with spaces" }), /outside/);
});

test("rejection or cancellation while waiting for confirmation prevents execution", async (t) => {
  const { tool, ctx, controller, serverDirectory } = await harness(t);
  ctx.confirm = async () => { throw new Error("用户拒绝或未确认：执行 Shell 命令"); };
  await assert.rejects(tool.execute({ command: "echo unexpected > marker.txt" }), /用户拒绝/);
  ctx.confirm = async () => { controller.abort(); };
  await assert.rejects(tool.execute({ command: "echo unexpected > marker.txt" }), { name: "AbortError" });
  await assert.rejects(access(path.join(serverDirectory, "marker.txt")));
});

test("an already aborted run does not execute or request confirmation", async (t) => {
  const { tool, controller, confirmations } = await harness(t);
  controller.abort();
  await assert.rejects(tool.execute({ command: "echo unexpected" }), { name: "AbortError" });
  assert.deepEqual(confirmations, []);
});

test("shell commands are non-interactive and see EOF on stdin", { timeout: 5000 }, async (t) => {
  const { tool, script } = await harness(t);
  const command = await script("stdin", "process.stdin.resume(); process.stdin.on('end', () => console.log('EOF'));");
  const result = JSON.parse(await tool.execute({ command }));
  assert.equal(result.stdout.trim(), "EOF");
});

for (const mode of ["abort", "timeout"] as const) {
  test(`${mode} terminates the shell and nested foreground command`, { timeout: 8000 }, async (t) => {
    const { tool, script, ctx, controller, serverDirectory } = await harness(t);
    const command = await script("wait", `
      process.on('SIGTERM', () => {});
      setTimeout(() => require('node:fs').writeFileSync('late-marker.txt', 'still running'), ${mode === "abort" ? 400 : 1400});
      setInterval(() => {}, 1000);
      console.log('READY');
    `);
    if (mode === "abort") {
      ctx.consoleLog = (text, stream) => {
        if (stream === "stdout" && text.includes("READY")) controller.abort();
      };
    }
    const startedAt = Date.now();
    await assert.rejects(tool.execute({ command, timeoutMs: mode === "abort" ? 4000 : 700 }), (error: Error) => {
      if (mode === "abort") assert.equal(error.name, "AbortError");
      else {
        assert.match(error.message, /"timedOut": true/);
        assert.match(error.message, /超过 700 毫秒/);
      }
      return true;
    });
    assert.ok(Date.now() - startedAt < 5000);
    await delay(mode === "abort" ? 600 : 1600);
    await assert.rejects(readFile(path.join(serverDirectory, "late-marker.txt")), { code: "ENOENT" });
  });
}
