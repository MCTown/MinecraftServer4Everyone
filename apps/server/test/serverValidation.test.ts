import assert from "node:assert/strict";
import { test } from "node:test";
import { cp, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { inspectServerValidation, probeMinecraftStatus } from "../src/services/serverValidation.js";
import { ProcessManager } from "../src/services/processManager.js";
import type { ServerService } from "../src/services/serverService.js";
import type { ServerRecord, ConsoleLogEntry } from "../src/types.js";
import { createAgentTools } from "../src/agent/tools.js";
import type { AgentToolContext } from "../src/agent/toolKit.js";
import { defaultSystemPrompt } from "../src/config.js";
import { compileDeploymentWorkflow, defaultDeploymentWorkflow, migrateDeploymentWorkflow } from "../src/services/deploymentWorkflow.js";

function zipOne(name: string, text: string) {
  const data = Buffer.from(text); const fileName = Buffer.from(name); let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(fileName.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(fileName.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + fileName.length, 12); end.writeUInt32LE(local.length + fileName.length + data.length, 16);
  return Buffer.concat([local, fileName, data, central, fileName, end]);
}

async function fixture() {
  const directory = await mkdtemp("/tmp/opencode/validation-test-");
  await mkdir(path.join(directory, "server")); await mkdir(path.join(directory, "plugins/example"), { recursive: true });
  await writeFile(path.join(directory, "plugins/example/mcdreforged.plugin.json"), JSON.stringify({ id: "example" }));
  await writeFile(path.join(directory, "plugins/renamed-archive.mcdr"), zipOne("mcdreforged.plugin.json", JSON.stringify({ id: "chathub" })));
  await writeFile(path.join(directory, "plugins/ignored.mcdr.disabled"), "ignored");
  await writeFile(path.join(directory, "config.yml"), "working_directory: server\nstart_command: java -jar server.jar\nhandler: forge_handler\nplugin_directories: [plugins]\nrcon:\n  enable: false\n  password: TOP_SECRET\n");
  await writeFile(path.join(directory, "server/server.properties"), "server-ip=127.0.0.1\nserver-port=25670\nenable-rcon=false\nenable-query=false\nenable-status=false\nrcon.password=TOP_SECRET\n");
  const server = { id: "validation-test", status: "running", directory, startupCommand: "{python} -m mcdreforged" } as ServerRecord;
  const service = { requireServer: async () => ({ ...server }) } as unknown as ServerService;
  let launch: { launchId: string; rootPid: number; startedAt: string } | null = { launchId: "test-launch", rootPid: 100, startedAt: "2026-10-21T14:00:00.000Z" };
  let entries: ConsoleLogEntry[] = [];
  const add = (text: string, createdAt = "2026-10-21T14:01:00.000Z", stream: ConsoleLogEntry["stream"] = "stdout") => entries.push({ id: String(entries.length), serverId: server.id, text, stream, createdAt });
  add("[MCDR] 插件 example@1.0.0 已加载\n[MCDR] 插件 chathub@3.0.0 已加载\n[ChatHub] Registered as group 42\n");
  add("[main/FATAL] Example optional integration failed\nCaused by: java.lang.ClassNotFoundException: optional.library\n");
  add("[Server thread/INFO] [minecraft/DedicatedServer]: Done (4.386s)! For help, type help\n");
  const manager = {
    getLaunchIdentity: () => launch,
    getConsoleSnapshot: () => ({ launch, cursor: entries.at(-1)?.id ?? null, entries }),
    inspectRuntime: async () => ({ launch, owned: true, reason: null, processes: [
      { pid: 100, ppid: 1, name: "sh", commandLine: "sh start.sh" },
      { pid: 101, ppid: 100, name: "python3", commandLine: "python3 -m mcdreforged --password TOP_SECRET" },
      { pid: 102, ppid: 101, name: "java", commandLine: "java -Xms3584M -Xmx3584M -Dpassword=TOP_SECRET -jar server.jar" }
    ] })
  } as unknown as ProcessManager;
  return { directory, server, manager, service, add, clear: () => { entries = []; }, setLaunch: (value: typeof launch) => { launch = value; },
    inspect: (options?: Parameters<typeof inspectServerValidation>[3]) => inspectServerValidation(service, manager, server.id, options),
    cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("summary separates ready gameplay and plugin loading from ERROR/FATAL observations without secret leakage", async () => {
  const h = await fixture();
  try {
    const result = await h.inspect();
    assert.equal(result.gameRunning, "passed"); assert.equal(result.checks.mcdrOwnsJava!.status, "passed");
    assert.ok(result.logAlerts!.count >= 2); assert.match(result.logAlerts!.interpretation, /不是运行状态/);
    assert.equal(result.checks.plugins!.status, "passed"); assert.equal(result.checks.chathub!.status, "passed");
    assert.equal(result.checks.memory!.status, "passed");
    assert.match(JSON.stringify(result.checks.plugins!.evidence), /renamed-archive\.mcdr/);
    assert.doesNotMatch(JSON.stringify(result), /TOP_SECRET/);
    assert.match(result.guidance, /不.*仅凭 ERROR\/FATAL/);
  } finally { await h.cleanup(); }
});

test("missing plugins, unreadable metadata and plugin failure logs cannot fail game readiness", async () => {
  const h = await fixture();
  try {
    await writeFile(path.join(h.directory, "plugins/unknown.py"), "raise Exception('do not run me')");
    await writeFile(path.join(h.directory, "plugins/broken.mcdr"), "not a zip");
    h.add("[MCDR] 插件 another 加载失败\n");
    const result = await h.inspect();
    assert.equal(result.gameRunning, "passed"); assert.equal(result.checks.plugins!.status, "unknown");
    assert.match(JSON.stringify(result.checks.plugins), /不执行/);
    assert.match(JSON.stringify(result.checks.plugins), /unknown\.py/);
    const scoped = await h.inspect({ expectedPluginIds: ["missing"] });
    assert.equal(scoped.checks.plugins!.status, "unknown"); assert.match(JSON.stringify(scoped.checks.plugins), /missing/);
  } finally { await h.cleanup(); }
});

test("stale ready/error/plugin evidence is excluded and no managed launch cannot report passed", async () => {
  const h = await fixture();
  try {
    h.clear(); h.add("Done (1.0s)!\n[MCDR] 插件 example@1 已加载\n[FATAL] old error\n", "2020-01-01T00:00:00Z");
    const current = await h.inspect();
    assert.equal(current.gameRunning, "unknown"); assert.equal(current.logAlerts!.count, 0);
    assert.equal(current.checks.plugins!.status, "unknown");
    h.setLaunch(null);
    const orphan = await h.inspect(); assert.equal(orphan.gameRunning, "unknown");
    assert.equal(orphan.logAlerts, null); assert.equal(orphan.checks.plugins!.status, "unknown");
  } finally { await h.cleanup(); }
});

test("a crash beats historical Done, while concurrent launch change invalidates the whole snapshot", async () => {
  const h = await fixture();
  try {
    h.server.status = "crashed"; assert.equal((await h.inspect()).gameRunning, "failed");
    h.server.status = "running";
    const original = h.manager.inspectRuntime;
    h.manager.inspectRuntime = async (...args) => {
      const result = await original(...args);
      h.setLaunch({ launchId: "new-launch", rootPid: 200, startedAt: "2026-10-22T00:00:00Z" }); return result;
    };
    const result = await h.inspect(); assert.equal(result.consistent, false); assert.equal(result.gameRunning, "unknown");
    assert.ok(Object.values(result.checks).every((value) => value.status === "unknown"));
  } finally { await h.cleanup(); }
});

test("invalid config or sandbox escapes remain unknown instead of silently passing", async () => {
  const h = await fixture();
  try {
    await writeFile(path.join(h.directory, "config.yml"), "plugin_directories: [\ninvalid: :\n");
    assert.equal((await h.inspect()).checks.plugins!.status, "unknown");
    await writeFile(path.join(h.directory, "server/server.properties"), "unrelated=value\n");
    assert.equal((await h.inspect()).checks.minecraftConfig!.status, "unknown", "empty/unrecognized config must not pass");
    if (process.platform !== "win32") {
      await rm(path.join(h.directory, "server/server.properties"));
      await symlink("/etc/passwd", path.join(h.directory, "server/server.properties"));
      const result = await h.inspect(); assert.equal(result.checks.minecraftConfig!.status, "unknown");
      assert.doesNotMatch(JSON.stringify(result), /root:x:/);
    }
  } finally { await h.cleanup(); }
});

test("all 13 bundled archive plugin IDs are inspected without executing plugins", async () => {
  const h = await fixture();
  try {
    await rm(path.join(h.directory, "plugins"), { recursive: true });
    await cp(new URL("../../../templates/reference/plugins", import.meta.url), path.join(h.directory, "plugins"), { recursive: true });
    const ids = ["beep", "carpetbotlist", "chathub", "color_me", "here", "mcdr_pycraft_bot", "minecraft_data_api", "mg_events", "online_player_api", "prime_backup", "quick_backup_multi", "stats_helper", "mcd_task"];
    h.clear();
    h.add(ids.map((id) => `[MCDR] 插件 ${id}@1.0.0 已加载`).join("\n") + "\nDone (1.0s)!\n");
    const result = await h.inspect();
    assert.equal(result.checks.plugins!.status, "passed");
    const inventory = result.checks.plugins!.evidence as { expected: { id: string }[]; unresolved: unknown[] };
    assert.deepEqual(inventory.expected.map((plugin) => plugin.id).sort(), ids.sort());
    assert.deepEqual(inventory.unresolved, []);
  } finally { await h.cleanup(); }
});

test("tool output stays valid JSON within the model cap even with unusually large alerts", async () => {
  const h = await fixture();
  try {
    h.add(Array.from({ length: 100 }, () => `[main/FATAL] ${'"\\'.repeat(1500)}\n`).join(""));
    const tool = createAgentTools({ getServerId: () => h.server.id, serverService: h.service, processManager: h.manager } as AgentToolContext)
      .find((item) => item.definition.function.name === "inspect_current_server_validation")!;
    const text = await tool.execute({}); assert.ok(text.length <= 11000);
    const output = JSON.parse(text);
    assert.equal(output.gameRunning, "passed"); assert.equal(output.outputTruncated, true);
    assert.equal(output.checks.plugins.status, "passed"); assert.ok(output.logAlerts.count >= 100);
    await assert.rejects(tool.execute({ expectedPluginIds: ["valid", 3] }));
  } finally { await h.cleanup(); }
});

test("known previous default final instructions upgrade but custom edits and snapshots survive", () => {
  const oldText = "不得将 MCDR 命令递归写入 config.yml 的 start_command；serverType 仅作标签。先 get_current_server_config，确保 config.yml 的 start_command 是从 server/ 工作目录启动服务端的非交互命令，再设置 startupCommand={python} -m mcdreforged。通过 start_current_server 启动 MCDReforged 后必须立即调用 wait_for_server_startup，阻塞等待控制台明确出现 Minecraft 的 Done (...)! 启动完成标记，禁止使用 sleep、固定时长等待或反复 Shell 轮询代替。启动完成后读取控制台与 logs/，确认 Minecraft 与每个已启用插件加载成功。插件缺 Python 依赖时，仅按日志或 requirements 精确声明的包和版本调用 install_mcdreforged_plugin_dependencies；停止残留、重启并复查。依赖失败、布局错误、未完成内置 Python/config.yml/startupCommand 或服务端未就绪时标记 failed，不得宣称完成；报告插件、依赖和具体原因。验证成功后汇报启动方式、内存、版本与结果。";
  const legacy = defaultDeploymentWorkflow(); const last = legacy.steps.find((item) => item.id === "final_mcdr_test")!;
  last.prompt = oldText;
  const saved = structuredClone(legacy);
  const migrated = migrateDeploymentWorkflow(legacy);
  assert.deepEqual(legacy, saved, "migration must not mutate in-flight snapshots");
  assert.match(migrated.steps.find((item) => item.id === "final_mcdr_test")!.prompt, /inspect_current_server_validation/);
  last.prompt += "\n用户自定义验收要求";
  assert.equal(migrateDeploymentWorkflow(legacy).steps.find((item) => item.id === "final_mcdr_test")!.prompt, last.prompt);
});

test("truncated logs, split output, absent Done and broken process inspection are handled conservatively", async () => {
  const h = await fixture();
  try {
    h.add("x".repeat(2_000_001) + "\n");
    const truncated = await h.inspect(); assert.equal(truncated.logWindow.truncated, true);
    assert.equal(truncated.checks.plugins!.status, "unknown");
    h.clear(); h.add("[Server thread/INFO] [minecraft/Server]: Done ("); h.add("4.386s)! For help\n");
    assert.equal((await h.inspect()).gameRunning, "passed");
    h.manager.inspectRuntime = async () => { throw new Error("process inspection unavailable"); };
    assert.equal((await h.inspect()).gameRunning, "unknown");
    const controller = new AbortController(); controller.abort();
    await assert.rejects(h.inspect({ signal: controller.signal }), /取消/);
  } finally { await h.cleanup(); }
});

test("runtime inspection scopes processes by owned root ancestry and omits unrelated servers", async () => {
  const manager = new ProcessManager({} as never, {} as never, {} as never, {} as never);
  const internals = manager as unknown as { running: object; collectSystemProcesses: () => Promise<unknown[]> };
  internals.running = { serverId: "x", rootPid: 100, launchId: "owned", startedAt: "now" };
  internals.collectSystemProcesses = async () => [
    { pid: 100, ppid: 1, name: "sh", commandLine: "sh owned" },
    { pid: 101, ppid: 100, name: "java", commandLine: "java owned" },
    { pid: 200, ppid: 1, name: "java", commandLine: "java other" }
  ];
  assert.deepEqual((await manager.inspectRuntime("x")).processes.map((p) => p.pid), [100, 101]);
  assert.equal((await manager.inspectRuntime("different")).owned, false);
});

test("local Minecraft status probe handles fragmented status and rejects malformed/closed responses", async () => {
  const vi = (value: number) => { const bytes = []; do { let b = value & 127; value >>>= 7; if (value) b |= 128; bytes.push(b); } while (value); return Buffer.from(bytes); };
  for (const valid of [true, false]) {
    const server = net.createServer((socket) => socket.once("data", () => {
      if (!valid) { socket.end(); return; }
      const json = Buffer.from(JSON.stringify({ version: { name: "1.21.1", protocol: 767 } }));
      const payload = Buffer.concat([vi(0), vi(json.length), json]); const packet = Buffer.concat([vi(payload.length), payload]);
      socket.write(packet.subarray(0, 3)); setImmediate(() => socket.end(packet.subarray(3)));
    }));
    server.listen(0, "127.0.0.1"); await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      const port = (server.address() as net.AddressInfo).port;
      if (valid) assert.deepEqual(await probeMinecraftStatus(port), { version: "1.21.1", protocol: 767 });
      else await assert.rejects(probeMinecraftStatus(port), /提前关闭/);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  }
});

test("validation tool is registered as read-only and prompts separate game, plugins and log severity", async () => {
  const tool = createAgentTools({} as AgentToolContext).find((item) => item.definition.function.name === "inspect_current_server_validation");
  assert.ok(tool); assert.match(tool.definition.function.description, /无文件写入/);
  await assert.rejects(tool.execute({ expectedPluginIds: ["../invalid"] }));
  for (const text of [defaultSystemPrompt, compileDeploymentWorkflow(defaultDeploymentWorkflow())]) {
    assert.match(text, /inspect_current_server_validation/); assert.match(text, /MCDR 插件一般不会影响游戏运行/);
    assert.match(text, /大型整合包报错很正常/); assert.match(text, /send_current_server_command/);
  }
});
