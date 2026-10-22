import { execFile } from "node:child_process";
import { open, readdir, readlink, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import net from "node:net";
import { parseDocument } from "yaml";
import { open as openZip } from "yauzl";
import { resolveWithin } from "../security/pathSandbox.js";
import type { ServerService } from "./serverService.js";
import type { ProcessManager } from "./processManager.js";
import { summarizeServerLogErrors } from "./serverErrorService.js";

type CheckStatus = "passed" | "failed" | "unknown";
function check(status: CheckStatus, evidence: unknown, detail?: string) { return { status, evidence, ...(detail ? { detail } : {}) }; }
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Bounded, sandboxed reads; never return secrets from config/command lines. */
async function readSmall(root: string, relative: string, limit = 128_000) {
  const file = await open(await resolveWithin(root, relative, { mustExist: true }), constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error(`${relative} 不是普通文件`);
    const size = info.size;
    if (size > limit) throw new Error(`${relative} 超过检查大小上限`);
    const buffer = Buffer.alloc(limit + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!chunk.bytesRead) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > limit) throw new Error(`${relative} 在检查时超过大小上限`);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await file.close(); }
}

function zipPluginId(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let done = false;
    let close = () => {};
    const finish = (error?: Error, id?: string) => {
      if (done) return;
      done = true; clearTimeout(timer); close();
      if (error) reject(error); else resolve(id!);
    };
    const timer = setTimeout(() => finish(new Error("插件元数据读取超时")), 2000);
    openZip(file, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error || !zip) { finish(error ?? new Error("无法读取插件归档")); return; }
      close = () => zip.close();
      if (done) { zip.close(); return; }
      let entries = 0;
      zip.on("error", (err) => finish(err));
      zip.on("end", () => finish(new Error("归档没有根目录 mcdreforged.plugin.json")));
      zip.on("entry", (entry) => {
        if (++entries > 4096) { finish(new Error("插件归档条目过多")); return; }
        if (entry.fileName !== "mcdreforged.plugin.json") { zip.readEntry(); return; }
        if (entry.uncompressedSize > 128_000) { finish(new Error("插件元数据过大")); return; }
        zip.openReadStream(entry, (err, stream) => {
          if (err || !stream) { finish(err ?? new Error("无法读取插件元数据")); return; }
          let text = "";
          stream.on("error", (e) => finish(e));
          stream.on("data", (data: Buffer) => { text += data.toString("utf8"); if (text.length > 128_000) { stream.destroy(); finish(new Error("插件元数据过大")); } });
          stream.on("end", () => {
            try {
              const id = (JSON.parse(text) as { id?: unknown }).id;
              if (typeof id !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(id)) throw new Error("无法识别插件 ID");
              finish(undefined, id);
            } catch (e) { finish(new Error(message(e))); }
          });
        });
      });
      zip.readEntry();
    });
  });
}

async function expectedPlugins(root: string, directories: unknown) {
  if (!Array.isArray(directories) || !directories.every((value) => typeof value === "string")) throw new Error("config.yml 未提供可识别的 plugin_directories");
  const expected: { path: string; id: string }[] = [];
  const unresolved: { path: string; reason: string }[] = [];
  const deadline = Date.now() + 5000;
  let scanned = 0;
  for (const dir of directories.slice(0, 16) as string[]) {
    let entries;
    try { entries = await readdir(await resolveWithin(root, dir, { mustExist: true }), { withFileTypes: true }); }
    catch (e) { unresolved.push({ path: dir, reason: message(e) }); continue; }
    if (entries.length > 200) unresolved.push({ path: dir, reason: "目录超过 200 条，只检查前 200 条" });
    for (const entry of entries.slice(0, 200)) {
      if (entry.name.startsWith(".") || entry.name.endsWith(".disabled") || entry.name === "__pycache__") continue;
      if (!entry.isDirectory() && !/\.(?:mcdr|pyz|py)$/i.test(entry.name)) continue;
      const relative = path.join(dir, entry.name);
      if (++scanned > 200 || Date.now() > deadline) { unresolved.push({ path: dir, reason: "插件检查数量/时间预算已用尽，未检查项保持 unknown" }); break; }
      try {
        const full = await resolveWithin(root, relative, { mustExist: true });
        const info = await stat(full);
        if (!info.isFile() && !info.isDirectory()) throw new Error("插件不是普通文件或目录");
        if (/\.py$/i.test(entry.name)) { unresolved.push({ path: relative, reason: "单文件插件元数据需执行 Python，只读检查不执行；不能用文件名猜 ID" }); continue; }
        const id = entry.isDirectory()
          ? (JSON.parse(await readSmall(root, path.join(relative, "mcdreforged.plugin.json"))) as { id: string }).id
          : await zipPluginId(full);
        if (typeof id !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(id)) throw new Error("无法识别插件 ID");
        expected.push({ path: relative, id });
      } catch (e) { unresolved.push({ path: relative, reason: message(e) }); }
    }
  }
  if (directories.length > 16) unresolved.push({ path: "plugin_directories", reason: "仅检查前 16 个目录" });
  return { expected, unresolved };
}

function run(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => execFile(command, args, { timeout: 5000, maxBuffer: 2_000_000, windowsHide: true },
    (error, stdout) => error ? reject(error) : resolve(stdout)));
}

async function inspectListeners(pids: number[]) {
  if (!pids.length) throw new Error("没有已确认归属的进程 PID");
  if (process.platform === "win32") {
    const script = `Get-NetTCPConnection -State Listen | Where-Object { $_.OwningProcess -in @(${pids.join(",")}) } | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress`;
    const text = await run(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-Command", script]);
    const rows = text.trim() ? JSON.parse(text) : [];
    return (Array.isArray(rows) ? rows : [rows]).map((row: { LocalAddress: string; LocalPort: number; OwningProcess: number }) => ({ address: row.LocalAddress, port: row.LocalPort, pid: row.OwningProcess }));
  }
  if (process.platform !== "linux") throw new Error("当前平台不支持进程级监听检查");
  const output = await run("ss", ["-H", "-ltnp"]);
  return output.split("\n").flatMap((line) => {
    const ids = [...line.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
    const pid = ids.find((id) => pids.includes(id));
    if (!pid) return [];
    const local = line.trim().split(/\s+/)[3] ?? "";
    const match = local.match(/^(.*):(\d+)$/);
    return match ? [{ address: match[1]!.replace(/^\[|\]$/g, ""), port: Number(match[2]), pid }] : [];
  });
}

/** A local status request, not a login or game command. Only loopback targets. */
export function probeMinecraftStatus(port: number, timeoutMs = 2000) {
  return new Promise<{ version: unknown; protocol: unknown }>((resolve, reject) => {
    const vi = (value: number) => { const bytes = []; do { let b = value & 127; value >>>= 7; if (value) b |= 128; bytes.push(b); } while (value); return Buffer.from(bytes); };
    const host = Buffer.from("127.0.0.1"); const portBytes = Buffer.alloc(2); portBytes.writeUInt16BE(port);
    const handshake = Buffer.concat([vi(0), vi(767), vi(host.length), host, portBytes, vi(1)]);
    let data = Buffer.alloc(0); let settled = false;
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (error?: Error, value?: { version: unknown; protocol: unknown }) => {
      if (settled) return; settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error("Minecraft 状态协议未响应（可能关闭状态查询或仅监听 IPv6）；不等于游戏未运行")), timeoutMs);
    socket.on("error", (err) => finish(err));
    socket.on("end", () => finish(new Error("Minecraft 状态连接提前关闭")));
    socket.on("connect", () => socket.write(Buffer.concat([vi(handshake.length), handshake, Buffer.from([1, 0])])));
    socket.on("data", (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (data.length > 1_000_000) { finish(new Error("Minecraft 状态响应过大")); return; }
      let offset = 0;
      const read = () => { let value = 0; for (let i = 0; i < 5; i++) { if (offset >= data.length) return null; const b = data[offset++]!; value |= (b & 127) << (7 * i); if (!(b & 128)) return value >>> 0; } throw new Error("非法状态协议 VarInt"); };
      try {
        const length = read(); if (length === null || data.length - offset < length) return;
        const end = offset + length; const packet = read(); const jsonLength = read();
        if (packet !== 0 || jsonLength === null || offset + jsonLength !== end) throw new Error("非法 Minecraft 状态包");
        const response = JSON.parse(data.subarray(offset, end).toString("utf8")) as { version?: { name?: unknown; protocol?: unknown } };
        if (typeof response.version?.name !== "string" || typeof response.version.protocol !== "number") throw new Error("状态响应缺少 Minecraft version");
        finish(undefined, { version: response.version.name.slice(0, 160), protocol: response.version.protocol });
      } catch (e) { finish(new Error(message(e))); }
    });
  });
}

export async function inspectServerValidation(serverService: ServerService, manager: ProcessManager, serverId: string, options: { expectedPluginIds?: string[]; signal?: AbortSignal } = {}) {
  if (options.signal?.aborted) throw new Error("验收检查已取消");
  const server = await serverService.requireServer(serverId);
  const snapshot = manager.getConsoleSnapshot(serverId);
  // Limit model output and analysis work; incomplete evidence stays unknown.
  const captured = snapshot.entries.filter((entry) => entry.stream !== "system" && (!snapshot.launch || entry.createdAt >= snapshot.launch.startedAt));
  const streamTexts = ["stdout", "stderr"].map((stream) => captured.filter((entry) => entry.stream === stream).map((entry) => entry.text).join(""));
  const truncated = Boolean(snapshot.truncated) || streamTexts.some((value) => value.length > 1_000_000);
  const clean = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "").replace(/§[0-9a-fk-or]/gi, "");
  // stdout/stderr can arrive in partial chunks. Never concatenate a different
  // stream into the middle of a line and manufacture evidence.
  const text = clean(streamTexts.map((value) => value.slice(-1_000_000)).join("\n"));
  const currentLogs = Boolean(snapshot.launch);
  const evidenceLines = (pattern: RegExp) => text.split(/\r?\n/).filter((line) => pattern.test(line)).slice(-20).map((line) => line.slice(0, 1000));
  const ready = currentLogs ? evidenceLines(/(?:^|\]:?\s*|\[Server\]\s*)Done \([\d.]+s\)!/) : [];
  const logErrors = currentLogs ? summarizeServerLogErrors(text) : null;
  const runtime = await manager.inspectRuntime(serverId).then((value) => ({ value, error: null }), (error: unknown) => ({ value: null, error: message(error) }));
  const processes = runtime.value?.processes ?? [];
  const java = processes.filter((item) => /^(?:java|javaw)(?:\.exe)?$/i.test(item.name));
  const mcdr = processes.filter((item) => /(?:^|\s)-m\s+mcdreforged(?:\s|$)/.test(item.commandLine));
  const ownedJava = java.filter((item) => mcdr.some((parent) => {
    let pid = item.ppid; const visited = new Set<number>();
    while (!visited.has(pid)) { if (pid === parent.pid) return true; visited.add(pid); const next = processes.find((p) => p.pid === pid); if (!next) break; pid = next.ppid; }
    return false;
  }));
  const checks: Record<string, ReturnType<typeof check>> = {};
  checks.process = runtime.error ? check("unknown", null, runtime.error) : check(runtime.value?.owned ? "passed" : "unknown", {
    rootPid: snapshot.launch?.rootPid, processes: processes.map(({ pid, ppid, name }) => ({ pid, ppid, name })) }, runtime.value?.reason ?? undefined);
  checks.mcdrOwnsJava = check(ownedJava.length ? "passed" : "unknown", { mcdrPids: mcdr.map((p) => p.pid), javaPids: ownedJava.map((p) => p.pid) });
  checks.minecraftReady = check(ready.length && java.length && runtime.value?.owned && server.status === "running" ? "passed"
    : ["stopped", "crashed"].includes(server.status) ? "failed" : "unknown", { status: server.status, done: ready.slice(-1) }, "依据本次启动就绪及进程判断，不依据 ERROR/FATAL 数量");

  let properties: Record<string, string> = {};
  try {
    const content = await readSmall(server.directory, "server/server.properties");
    properties = Object.fromEntries(content.split(/\r?\n/).filter((line) => !/^\s*[#!]/.test(line)).flatMap((line) => {
      const m = line.match(/^\s*([\w.-]+)\s*[=:]\s*(.*?)\s*$/); return m ? [[m[1]!, m[2]!]] : [];
    }));
    const configuredPort = Number(properties["server-port"]);
    const complete = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort < 65536
      && properties["server-ip"] !== undefined && ["enable-rcon", "enable-query"].every((key) => ["true", "false"].includes(properties[key] ?? ""));
    checks.minecraftConfig = check(complete ? "passed" : "unknown", Object.fromEntries(["server-ip", "server-port", "enable-rcon", "enable-query", "enable-status"].map((key) => [key, properties[key] ?? null])), "只确认配置已读取且必要字段可识别，不代表满足任务约束或实际监听/功能可用");
  } catch (e) { checks.minecraftConfig = check("unknown", null, message(e)); }
  const listeners = await inspectListeners(java.map((p) => p.pid)).then((value) => ({ value, error: null }), (error: unknown) => ({ value: null, error: message(error) }));
  const port = Number(properties["server-port"] ?? "25565");
  const gameListener = listeners.value?.find((item) => item.port === port);
  checks.listeners = check(gameListener ? "passed" : "unknown", listeners.value, listeners.error ?? "只列当前实例 Java 的 TCP 监听；不将其他实例端口混入");
  const ipv4LoopbackListener = listeners.value?.find((item) => item.port === port && ["127.0.0.1", "0.0.0.0"].includes(item.address));
  if (ipv4LoopbackListener && Number.isInteger(port) && port > 0 && port < 65536 && properties["enable-status"] !== "false") {
    checks.minecraftStatus = await probeMinecraftStatus(port).then((value) => check("passed", value), (error: unknown) => check("unknown", null, message(error)));
  } else checks.minecraftStatus = check("unknown", null, "未确认当前实例游戏端口可通过 IPv4 环回访问，或状态查询已关闭；不探测其他实例端口");

  try {
    const doc = parseDocument(await readSmall(server.directory, "config.yml"));
    if (doc.errors.length) throw new Error("config.yml YAML 无法解析");
    const config = doc.toJS({ maxAliasCount: 20 }) as Record<string, unknown>;
    checks.mcdrConfig = check(config.working_directory === "server" && typeof config.start_command === "string" && !/\bmcdreforged\b/.test(config.start_command) && /\bmcdreforged\b/.test(server.startupCommand ?? "") ? "passed" : "unknown",
      { workingDirectory: config.working_directory, handler: config.handler, startupUsesMcdr: /\bmcdreforged\b/.test(server.startupCommand ?? ""), startCommandPresent: Boolean(config.start_command),
        rconEnabled: typeof config.rcon === "object" && config.rcon !== null && typeof (config.rcon as { enable?: unknown }).enable === "boolean"
          ? (config.rcon as { enable: boolean }).enable : null }, "不回显完整启动命令/密码；字段值不证明命令实际成功");
    const inventory = options.expectedPluginIds ? { expected: options.expectedPluginIds.map((id) => ({ id, path: "explicit input" })), unresolved: [] } : await expectedPlugins(server.directory, config.plugin_directories);
    const loaded = currentLogs ? [...text.matchAll(/(?:插件\s+|Plugin\s+)([a-z][a-z0-9_]*)@([\w.+-]+)\s+(?:已加载|loaded)/gi)].map((m) => ({ id: m[1]!, version: m[2]! })) : [];
    const failed = currentLogs ? evidenceLines(/(?:插件|plugin).*?(?:加载失败|failed to load)|(?:failed to load).*plugin/i) : [];
    const missing = inventory.expected.filter((item) => !loaded.some((actual) => actual.id === item.id));
    checks.plugins = check(currentLogs && !truncated && !failed.length && !missing.length && !inventory.unresolved.length ? "passed" : "unknown",
      { scope: options.expectedPluginIds ? "explicit IDs only" : "configured plugin directories", ...inventory, loaded: [...new Map(loaded.map((p) => [p.id, p])).values()], missing, failures: failed },
      "插件状态与游戏运行状态独立；缺少证据或历史失败行是 unknown（插件可能已热重载恢复），不自动判定当前失败或重启。插件目录仅是当前配置，不执行插件代码");
  } catch (e) { checks.mcdrConfig ??= check("unknown", null, message(e)); checks.plugins = check("unknown", null, message(e)); }
  const chat = currentLogs ? evidenceLines(/\[ChatHub\].*Registered as group/i) : [];
  checks.chathub = check(chat.length ? "passed" : "unknown", chat, "未捕获注册行不证明游戏故障");

  const memory: { pid: number; xms: string[]; xmx: string[]; unresolved: string[] }[] = [];
  for (const proc of java) {
    const item = { pid: proc.pid, xms: [...proc.commandLine.matchAll(/(?:^|\s)-Xms([^\s"']+)/g)].map((m) => m[1]!), xmx: [...proc.commandLine.matchAll(/(?:^|\s)-Xmx([^\s"']+)/g)].map((m) => m[1]!), unresolved: [] as string[] };
    const args = [...proc.commandLine.matchAll(/(?:^|\s)(?:"@([^"]+)"|'@([^']+)'|@"([^"]+)"|@'([^']+)'|@([^\s]+))/g)].slice(0, 8).map((m) => m.slice(1).find(Boolean)!);
    for (const arg of args) {
      try {
        if (process.platform !== "linux") throw new Error("平台无法可靠确定 Java 工作目录，未猜测参数文件路径");
        const cwd = await readlink(`/proc/${proc.pid}/cwd`);
        const relative = path.relative(server.directory, path.resolve(cwd, arg));
        const content = (await readSmall(server.directory, relative)).split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).join("\n");
        item.xms.push(...[...content.matchAll(/(?:^|\s)-Xms([^\s]+)/g)].map((m) => m[1]!));
        item.xmx.push(...[...content.matchAll(/(?:^|\s)-Xmx([^\s]+)/g)].map((m) => m[1]!));
      } catch (e) { item.unresolved.push(message(e)); }
    }
    memory.push(item);
  }
  checks.memory = check(memory.length && memory.every((item) => item.xms.length && item.xmx.length && !item.unresolved.length) ? "passed" : "unknown", memory, "实际进程命令/参数文件中的内存参数，不是 JVM 堆使用量或参数修改前的历史值");
  const changed = manager.getLaunchIdentity(serverId)?.launchId !== snapshot.launch?.launchId
    || (await serverService.requireServer(serverId)).status !== server.status;
  if (changed) for (const value of Object.values(checks)) { value.status = "unknown"; value.detail = "检查期间启动代次或运行状态改变，此快照不能用作完成证据"; }
  if (options.signal?.aborted) throw new Error("验收检查已取消");
  return { serverId, observedAt: new Date().toISOString(), launch: snapshot.launch, cursor: snapshot.cursor,
    consistent: !changed, logWindow: { currentLaunchOnly: currentLogs, truncated, source: "managed console stdout/stderr" },
    gameRunning: checks.minecraftReady!.status, checks,
    logAlerts: logErrors,
    guidance: "MCDR 插件一般不会影响游戏运行；日志报错不代表服务器没有正常运行，大型整合包报错很正常。分别报告游戏、插件与告警；不能仅凭 ERROR/FATAL 自动禁模组、停服或重启。passed 仅针对列出的检查项，不是所有游戏/插件功能已验证。" };
}
