import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import type { ConsoleLogEntry, ServerRecord } from "../types.js";
import { appConfig } from "../config.js";
import { ConsoleLogService } from "./consoleLogService.js";
import { eventBus } from "./eventBus.js";
import { javaProxyArgs, proxyEnv } from "./proxySupport.js";
import { JavaService } from "./javaService.js";
import { PromptService } from "./promptService.js";
import { ServerService } from "./serverService.js";

const PROCESS_METADATA_FILE = ".mc-agent-process.json";

interface RunningProcess {
  serverId: string;
  child: ChildProcessWithoutNullStreams;
  rootPid: number | null;
  launchId: string;
  startedAt: string;
  logs: ConsoleLogEntry[];
  logCharacters: number;
  logsTruncated: boolean;
}

interface SystemProcess {
  pid: number;
  ppid: number;
  name: string;
  commandLine: string;
}

interface ProcessMetadata {
  rootPid: number | null;
  pids: number[];
  workingDirectory: string;
  command: string;
  args: string[];
  scriptName: string;
  startedAt: string;
}

function splitArgs(input: string) {
  const matches = input.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  return matches.map((part) => part.replace(/^"|"$/g, ""));
}

function scriptSortScore(fileName: string) {
  const lower = fileName.toLowerCase();
  const names = ["run", "start", "server", "launch", "startserver", "server-start"];
  const extensions = process.platform === "win32" ? [".bat", ".cmd", ".ps1", ".sh"] : [".sh"];
  const base = lower.replace(/\.[^.]+$/, "");
  const nameIndex = names.includes(base) ? names.indexOf(base) : names.length;
  const extensionIndex = extensions.findIndex((extension) => lower.endsWith(extension));
  return nameIndex * 10 + (extensionIndex === -1 ? extensions.length : extensionIndex);
}

function quoteScriptArg(value: string) {
  if (!value) return "\"\"";
  if (/^[^\s"]+$/.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
}

function replaceMemoryArgs(content: string, minMemory: string, maxMemory: string) {
  let next = content.replace(/-Xms\S+/gi, `-Xms${minMemory}`);
  next = next.replace(/-Xmx\S+/gi, `-Xmx${maxMemory}`);
  return next;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeForProcessMatch(value: string) {
  return path.resolve(value).toLowerCase().replaceAll("\\", "/");
}

function commandLineContainsPath(commandLine: string, targetPath: string) {
  if (!commandLine.trim()) return false;
  return commandLine.toLowerCase().replaceAll("\\", "/").includes(normalizeForProcessMatch(targetPath));
}

function normalizeJsonRows(value: unknown) {
  if (!value) return [] as unknown[];
  return Array.isArray(value) ? value : [value];
}

function processSummary(processes: SystemProcess[]) {
  return processes.map((item) => `${item.name || "process"}(${item.pid})`).join(", ");
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MINECRAFT_STARTUP_COMPLETE = /\bDone\s*\([^\r\n)]*\)!/;

function isAbortSignal(signal: AbortSignal | undefined) {
  return Boolean(signal?.aborted);
}

function windowsSystemExecutable(name: string) {
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  return path.join(systemRoot, "System32", name);
}

function windowsCommandProcessor() {
  return process.env.ComSpec || process.env.COMSPEC || windowsSystemExecutable("cmd.exe");
}

function windowsPowerShell() {
  return windowsSystemExecutable("WindowsPowerShell\\v1.0\\powershell.exe");
}

function windowsTaskkill() {
  return windowsSystemExecutable("taskkill.exe");
}

function pathKeyForEnv(env: NodeJS.ProcessEnv) {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? (process.platform === "win32" ? "Path" : "PATH");
}

function dedupeWindowsPathKeys(env: NodeJS.ProcessEnv, pathKey: string) {
  if (process.platform !== "win32") return;
  for (const key of Object.keys(env)) {
    if (key !== pathKey && key.toLowerCase() === "path") delete env[key];
  }
}

function spawnErrorDetails(error: Error, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const details = error as Error & { code?: string; syscall?: string; path?: string; spawnargs?: string[] };
  const pathKey = pathKeyForEnv(env);
  const envPath = env[pathKey] ?? "";
  return [
    `启动失败：${error.message}`,
    `命令：${command} ${args.join(" ")}`,
    `工作目录：${cwd}`,
    details.code ? `错误代码：${details.code}` : "",
    details.syscall ? `系统调用：${details.syscall}` : "",
    details.path ? `执行路径：${details.path}` : "",
    details.spawnargs?.length ? `参数：${details.spawnargs.join(" ")}` : "",
    process.platform === "win32" ? `ComSpec：${process.env.ComSpec || process.env.COMSPEC || ""}` : "",
    `${pathKey}：${envPath.slice(0, 1000)}`
  ].filter(Boolean).join("\n");
}

export class ProcessManager {
  private running: RunningProcess | null = null;
  private busy = false;
  private commandWaiters = new Set<string>();

  constructor(
    private readonly serverService: ServerService,
    private readonly consoleLogService: ConsoleLogService,
    private readonly promptService: PromptService,
    private readonly javaService: JavaService
  ) {}

  getActiveServerId() {
    return this.running?.serverId ?? null;
  }

  getLaunchIdentity(serverId: string) {
    const running = this.running?.serverId === serverId ? this.running : null;
    return running ? { launchId: running.launchId, startedAt: running.startedAt, rootPid: running.rootPid } : null;
  }

  /** Observational only; ancestry comes from the in-memory owned child, not
   * global pgrep or an unverified persisted PID that may have been reused. */
  async inspectRuntime(serverId: string) {
    const launch = this.getLaunchIdentity(serverId);
    if (!launch?.rootPid) return { launch, processes: [], owned: false, reason: "没有当前后端跟踪的启动进程，不能确认进程归属" };
    const processes = await this.collectSystemProcesses(true);
    if (this.getLaunchIdentity(serverId)?.launchId !== launch.launchId) throw new Error("检查期间服务端启动代次改变，请使用新快照");
    const root = processes.find((item) => item.pid === launch.rootPid);
    const descendants = this.descendantPids(launch.rootPid, processes);
    return { launch, owned: Boolean(root), processes: root ? processes.filter((item) => item.pid === root.pid || descendants.has(item.pid)) : [],
      reason: root ? null : "跟踪进程已不在系统进程列表中" };
  }

  getConsoleSnapshot(serverId: string) {
    // Presentation console also contains Shell output; it is not process evidence.
    const running = this.running?.serverId === serverId ? this.running : null;
    const entries = [...(running?.logs ?? [])];
    return { launch: this.getLaunchIdentity(serverId), cursor: entries.at(-1)?.id ?? null, entries, truncated: running?.logsTruncated ?? false };
  }

  private appendManagedOutput(running: RunningProcess, text: string, stream: "stdout" | "stderr") {
    const entry = this.consoleLogService.append(running.serverId, stream, text);
    if (!entry || this.running !== running) return;
    const retained = text.length > 128_000 ? { ...entry, text: entry.text.slice(-128_000) } : entry;
    running.logsTruncated ||= retained !== entry;
    running.logs.push(retained); running.logCharacters += retained.text.length;
    while (running.logs.length > 4000 || running.logCharacters > 2_000_000) {
      running.logCharacters -= running.logs.shift()!.text.length; running.logsTruncated = true;
    }
    eventBus.emit("managedConsole", { launchId: running.launchId, entry });
  }

  /** Subscribe before writing. Never re-send on timeout; matching output proves
   * an observation, not a protocol request-id correlation with this command. */
  async sendCommandAndWait(serverId: string, command: string, options: {
    responseType?: "players"; responseContains?: string; timeoutMs?: number; signal?: AbortSignal;
  }) {
    if (options.signal?.aborted) throw new Error("命令已取消，未发送");
    if (/[\r\n\0]/.test(command) || !command.trim()) throw new Error("只允许发送一条非空控制台命令");
    if (options.responseType === "players" && command.trim() !== "list") throw new Error("players 响应等待只用于 list 命令");
    const contains = options.responseContains?.trim();
    if (!options.responseType && (!contains || contains.length > 200)) throw new Error("等待响应需要 responseType=players 或 1-200 字符的 responseContains");
    if (options.responseType && contains) throw new Error("responseType 和 responseContains 不能同时设置");
    if (this.commandWaiters.has(serverId)) throw new Error("当前实例已有命令正在等待响应；本条命令未发送");
    const running = this.running;
    if (!running || running.serverId !== serverId) throw new Error("Server is not running; command not sent");
    const cursor = running.logs?.at(-1)?.id ?? null;
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.min(Math.max(options.timeoutMs!, 100), 60_000) : 10_000;
    const startedAt = Date.now();
    this.commandWaiters.add(serverId);
    return new Promise<{
      serverId: string; command: string; launchId: string; cursor: string | null; sent: boolean;
      status: "matched" | "timed_out" | "cancelled" | "interrupted" | "send_failed";
      elapsedMs: number; evidence?: { logId: string; text: string }; detail: string;
    }>((resolve) => {
      let settled = false;
      let sent = false;
      const buffers = new Map<string, string>();
      const finish = (status: "matched" | "timed_out" | "cancelled" | "interrupted" | "send_failed", detail: string,
        evidence?: { logId: string; text: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        eventBus.off("managedConsole", onConsole);
        eventBus.off("consoleClear", onClear);
        eventBus.off("serverStatus", onStatus);
        options.signal?.removeEventListener("abort", onAbort);
        this.commandWaiters.delete(serverId);
        resolve({ serverId, command, launchId: running.launchId, cursor, sent, status, elapsedMs: Date.now() - startedAt, evidence, detail });
      };
      const onConsole = ({ entry, launchId }: { entry: ConsoleLogEntry; launchId: string }) => {
        if (!sent || entry.serverId !== serverId || entry.stream === "system") return;
        if (this.running !== running || launchId !== running.launchId) { finish("interrupted", "启动代次改变；不要自动重发命令"); return; }
        const text = ((buffers.get(entry.stream) ?? "") + entry.text).replace(/\x1b\[[0-9;]*m/g, "");
        const line = text.split(/\r?\n/).find((value) => options.responseType === "players"
          ? /(?:^|\]:?\s*|\[Server\]\s*)There are \d+ of a max of \d+ players online\s*:/.test(value)
          : value.includes(contains!));
        if (line) finish("matched", "匹配到发送后当前实例的输出；控制台协议无请求 ID，不保证因果关联", { logId: entry.id, text: line.slice(0, 2000) });
        buffers.set(entry.stream, (text.split(/\r?\n/).at(-1) ?? "").slice(-8192));
      };
      const onClear = (event: { serverId: string }) => { if (event.serverId === serverId) finish("interrupted", "控制台已清空/重新启动；不要自动重发命令"); };
      const onStatus = (event: { serverId: string; status: ServerRecord["status"] }) => {
        if (event.serverId === serverId && (this.running !== running || event.status !== "running")) finish("interrupted", "服务端已退出或进入停止/重启状态；不要自动重发命令");
      };
      const onAbort = () => finish("cancelled", "已取消等待；已发送的命令不会撤销，不自动重发");
      const timeout = setTimeout(() => finish("timed_out", "等待响应超时不代表命令执行失败或服务端未运行；不要自动重发"), timeoutMs);
      eventBus.on("managedConsole", onConsole);
      eventBus.on("consoleClear", onClear);
      eventBus.on("serverStatus", onStatus);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) { onAbort(); return; }
      try {
        sent = true;
        this.sendCommand(serverId, command);
      } catch (error) {
        finish("send_failed", `发送未能确认（可能已部分写入），不要自动重发：${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  /**
   * Wait for Minecraft's explicit startup marker instead of making the Agent
   * guess with a fixed sleep. Process and timeout events are handled here so
   * callers cannot accidentally keep waiting after a failed launch.
   */
  async waitForStartup(serverId: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}) {
    const timeoutMs = Math.min(Math.max(Math.floor(options.timeoutMs ?? 180_000), 1_000), 600_000);
    const startedAt = Date.now();
    const server = await this.serverService.requireServer(serverId);
    if (isAbortSignal(options.signal)) throw new Error("等待服务端启动已取消");
    if (["stopped", "crashed", "orphaned"].includes(server.status)) {
      throw new Error(`服务端当前未运行，无法等待启动完成，状态：${server.status}`);
    }
    if (this.running && this.running.serverId !== serverId) {
      throw new Error(`另一个服务端正在运行：${this.running.serverId}`);
    }
    const existing = this.consoleLogService.listAll(serverId).find((entry) => MINECRAFT_STARTUP_COMPLETE.test(entry.text));
    if (existing) {
      return {
        serverId,
        ready: true as const,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        matchedLog: existing.text.trim()
      };
    }

    return new Promise<{ serverId: string; ready: true; elapsedMs: number; matchedLog: string }>((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | null, result?: { matchedLog: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        eventBus.off("console", onConsole);
        eventBus.off("serverStatus", onStatus);
        options.signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve({ serverId, ready: true, elapsedMs: Date.now() - startedAt, matchedLog: result!.matchedLog });
      };
      const onConsole = (entry: import("../types.js").ConsoleLogEntry) => {
        if (entry.serverId !== serverId) return;
        if (MINECRAFT_STARTUP_COMPLETE.test(entry.text)) finish(null, { matchedLog: entry.text.trim() });
      };
      const onStatus = (event: { serverId: string; status: ServerRecord["status"] }) => {
        if (event.serverId !== serverId || !["stopped", "crashed", "orphaned"].includes(event.status)) return;
        finish(new Error(`服务端在完成启动前已退出，当前状态：${event.status}`));
      };
      const onAbort = () => finish(new Error("等待服务端启动已取消"));
      const timeout = setTimeout(() => finish(new Error(`等待服务端启动超时（${timeoutMs}ms）。日志中未发现 Minecraft 的 Done (...)! 启动完成标记。`)), timeoutMs);
      eventBus.on("console", onConsole);
      eventBus.on("serverStatus", onStatus);
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Observe shutdown; never stop/kill a process or treat orphaned as success. */
  async waitForStopped(serverId: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}) {
    const rawTimeout = options.timeoutMs ?? 180_000;
    const timeoutMs = Number.isFinite(rawTimeout) ? Math.min(Math.max(Math.floor(rawTimeout), 1_000), 600_000) : 180_000;
    const startedAt = Date.now();
    return new Promise<{ serverId: string; stopped: true; status: "stopped" | "crashed"; elapsedMs: number }>((resolve, reject) => {
      let settled = false;
      let revision = 0;
      let lastStatus: ServerRecord["status"] | undefined;
      const diagnostic = () => {
        const rootPid = this.running?.serverId === serverId ? this.running.rootPid : null;
        const recentLogs = this.consoleLogService.listAll(serverId).slice(-5).map((entry) => entry.text.slice(-400)).join("\n");
        return `状态：${lastStatus ?? "未知"}；受跟踪根 PID：${rootPid ?? "无"}。不会自动强杀；检查停服日志及残留进程后再决定是否经高风险确认清理。${recentLogs ? `\n最近日志：\n${recentLogs}` : ""}`;
      };
      const finish = (error: Error | null, status?: "stopped" | "crashed") => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        eventBus.off("serverStatus", onStatus);
        options.signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve({ serverId, stopped: true, status: status!, elapsedMs: Date.now() - startedAt });
      };
      const check = async (server: ServerRecord, observedRevision: number) => {
        if (settled || revision !== observedRevision) return;
        lastStatus = server.status;
        if (server.status === "orphaned") {
          finish(new Error(`服务端存在后台残留进程，不能确认停服完成。${diagnostic()}`));
          return;
        }
        if (server.status !== "stopped" && server.status !== "crashed") return;
        // A database status or exited shell alone is insufficient: the existing
        // process-tree/metadata matcher must also find no associated processes.
        const remaining = await this.findActiveServerProcesses(server, null, true);
        if (settled || revision !== observedRevision) return;
        if (this.running?.serverId === serverId || remaining.length) {
          finish(new Error(`服务端仍有受跟踪或残留进程${remaining.length ? `：${processSummary(remaining)}` : ""}，不能确认停服完成。${diagnostic()}`));
          return;
        }
        finish(null, server.status);
      };
      const inspect = async (observedRevision: number, status?: ServerRecord["status"]) => {
        try {
          const server = await this.serverService.requireServer(serverId);
          await check(status ? { ...server, status } : server, observedRevision);
        } catch (error) {
          if (revision === observedRevision) finish(error instanceof Error ? error : new Error(String(error)));
        }
      };
      const onStatus = (event: { serverId: string; status: ServerRecord["status"] }) => {
        if (event.serverId !== serverId || settled) return;
        const observedRevision = ++revision;
        lastStatus = event.status;
        if (event.status === "starting" || event.status === "running") {
          finish(new Error(`等待停服期间服务端重新启动，不能确认原进程已停止。${diagnostic()}`));
          return;
        }
        void inspect(observedRevision, event.status);
      };
      const onAbort = () => finish(new Error("等待服务端停止已取消（仅取消等待，不改变进程状态）"));
      const timeout = setTimeout(() => finish(new Error(`等待服务端停止超时（${timeoutMs}ms）。${diagnostic()}`)), timeoutMs);
      // Subscribe before the initial async snapshot, avoiding an exit/subscribe
      // race. Revisions fence stale snapshots and in-flight process inspections.
      eventBus.on("serverStatus", onStatus);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      else void inspect(revision);
    });
  }

  /**
   * Serializes maintenance work (map mutations, rollbacks) against start/stop so a
   * server cannot boot while region files are being rewritten.
   */
  async runExclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("另一个进程操作正在进行中，请稍后重试");
    if (this.running) throw new Error(`服务端 ${this.running.serverId} 正在运行，无法执行需要独占的维护操作`);
    this.busy = true;
    try {
      return await action();
    } finally {
      this.busy = false;
    }
  }

  private async runBufferedProcess(command: string, args: string[], options: SpawnOptionsWithoutStdio = {}) {
    return new Promise<{ stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const child = spawn(command, args, { ...options, shell: false, windowsHide: true });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          code,
          signal
        });
      });
    });
  }

  private async collectSystemProcesses(requireInspection = false): Promise<SystemProcess[]> {
    if (process.platform === "win32") {
      const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
      const result = await this.runBufferedProcess(windowsPowerShell(), ["-NoProfile", "-Command", script]).catch(() => null);
      if (!result?.stdout.trim() || (requireInspection && result.code !== 0)) {
        if (requireInspection) throw new Error("无法读取系统进程列表，不能确认停服完成");
        return [];
      }
      try {
        const parsed = JSON.parse(result.stdout) as unknown;
        return normalizeJsonRows(parsed).map((row) => {
          const item = row as { ProcessId?: unknown; ParentProcessId?: unknown; Name?: unknown; CommandLine?: unknown };
          return {
            pid: Number(item.ProcessId ?? 0),
            ppid: Number(item.ParentProcessId ?? 0),
            name: typeof item.Name === "string" ? item.Name : "",
            commandLine: typeof item.CommandLine === "string" ? item.CommandLine : ""
          };
        }).filter((item) => item.pid > 0);
      } catch {
        if (requireInspection) throw new Error("无法解析系统进程列表，不能确认停服完成");
        return [];
      }
    }

    const result = await this.runBufferedProcess("ps", ["-eo", "pid=,ppid=,comm=,args="]).catch(() => null);
    if (!result?.stdout.trim() || (requireInspection && result.code !== 0)) {
      if (requireInspection) throw new Error("无法读取系统进程列表，不能确认停服完成");
      return [];
    }
    return result.stdout.split(/\r?\n/).map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
      if (!match) return null;
      return {
        pid: Number(match[1] ?? 0),
        ppid: Number(match[2] ?? 0),
        name: match[3] ?? "",
        commandLine: match[4] ?? ""
      };
    }).filter((item): item is SystemProcess => item !== null && item.pid > 0);
  }

  private descendantPids(rootPid: number, processes: SystemProcess[]) {
    const byParent = new Map<number, SystemProcess[]>();
    for (const item of processes) {
      const children = byParent.get(item.ppid) ?? [];
      children.push(item);
      byParent.set(item.ppid, children);
    }

    const descendants = new Set<number>();
    const visit = (pid: number) => {
      for (const child of byParent.get(pid) ?? []) {
        if (descendants.has(child.pid)) continue;
        descendants.add(child.pid);
        visit(child.pid);
      }
    };
    visit(rootPid);
    return descendants;
  }

  private metadataPath(server: ServerRecord) {
    return path.join(server.directory, PROCESS_METADATA_FILE);
  }

  private async readProcessMetadata(server: ServerRecord): Promise<ProcessMetadata | null> {
    const content = await readFile(this.metadataPath(server), "utf8").catch(() => null);
    if (!content) return null;
    try {
      const parsed = JSON.parse(content) as Partial<ProcessMetadata>;
      return {
        rootPid: typeof parsed.rootPid === "number" ? parsed.rootPid : null,
        pids: Array.isArray(parsed.pids) ? parsed.pids.filter((pid): pid is number => typeof pid === "number") : [],
        workingDirectory: typeof parsed.workingDirectory === "string" ? parsed.workingDirectory : server.directory,
        command: typeof parsed.command === "string" ? parsed.command : "",
        args: Array.isArray(parsed.args) ? parsed.args.filter((arg): arg is string => typeof arg === "string") : [],
        scriptName: typeof parsed.scriptName === "string" ? parsed.scriptName : "",
        startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : new Date(0).toISOString()
      };
    } catch {
      return null;
    }
  }

  private async writeProcessMetadata(server: ServerRecord, metadata: ProcessMetadata) {
    await mkdir(server.directory, { recursive: true });
    await writeFile(this.metadataPath(server), `${JSON.stringify(metadata, null, 2)}\n`, "utf8").catch(() => undefined);
  }

  private async clearProcessMetadata(server: ServerRecord) {
    await rm(this.metadataPath(server), { force: true }).catch(() => undefined);
  }

  private metadataNeedles(metadata: ProcessMetadata | null) {
    if (!metadata) return [];
    return [
      metadata.command,
      path.basename(metadata.command),
      metadata.scriptName,
      path.basename(metadata.scriptName),
      ...metadata.args
    ].filter((value) => value.trim()).map((value) => value.toLowerCase().replaceAll("\\", "/"));
  }

  private metadataMatchesProcess(processInfo: SystemProcess, metadata: ProcessMetadata | null) {
    const commandLine = processInfo.commandLine.toLowerCase().replaceAll("\\", "/");
    return this.metadataNeedles(metadata).some((needle) => commandLine.includes(needle));
  }

  async hasActiveServerProcesses(serverId: string) {
    const server = await this.serverService.requireServer(serverId);
    return (await this.findActiveServerProcesses(server)).length > 0;
  }

  private async findActiveServerProcesses(server: ServerRecord, trustedRootPid: number | null = null, requireInspection = false) {
    const processes = await this.collectSystemProcesses(requireInspection);
    const byPid = new Map(processes.map((item) => [item.pid, item]));
    const metadata = await this.readProcessMetadata(server);
    const candidatePids = new Set<number>();

    const addProcessTree = (rootPid: number, requireMetadataMatch: boolean) => {
      const root = byPid.get(rootPid);
      if (root && (!requireMetadataMatch || this.metadataMatchesProcess(root, metadata) || commandLineContainsPath(root.commandLine, server.directory))) {
        candidatePids.add(root.pid);
      }
      if (root || !requireMetadataMatch) {
        for (const pid of this.descendantPids(rootPid, processes)) candidatePids.add(pid);
      }
    };

    if (trustedRootPid && trustedRootPid > 0) addProcessTree(trustedRootPid, false);
    if (metadata?.rootPid && metadata.rootPid > 0) addProcessTree(metadata.rootPid, trustedRootPid !== metadata.rootPid);
    for (const pid of metadata?.pids ?? []) {
      if (pid > 0 && byPid.has(pid)) addProcessTree(pid, true);
    }

    for (const processInfo of processes) {
      if (processInfo.pid === process.pid) continue;
      if (commandLineContainsPath(processInfo.commandLine, server.directory) || commandLineContainsPath(processInfo.commandLine, path.join(server.directory, "server"))) {
        candidatePids.add(processInfo.pid);
      }
    }

    return [...candidatePids]
      .filter((pid) => pid !== process.pid)
      .map((pid) => byPid.get(pid))
      .filter((item): item is SystemProcess => Boolean(item));
  }

  private async killProcessTree(rootPid: number | null, extraPids: number[] = []) {
    const processes = await this.collectSystemProcesses();
    const targetPids = new Set(extraPids.filter((pid) => pid > 0 && pid !== process.pid));
    if (rootPid && rootPid > 0 && rootPid !== process.pid) {
      targetPids.add(rootPid);
      for (const pid of this.descendantPids(rootPid, processes)) {
        if (pid !== process.pid) targetPids.add(pid);
      }
    }

    if (process.platform === "win32") {
      for (const pid of targetPids) {
        await this.runBufferedProcess(windowsTaskkill(), ["/pid", String(pid), "/t", "/f"]).catch(() => undefined);
      }
      return;
    }

    if (rootPid && rootPid > 0) {
      try {
        process.kill(-rootPid, "SIGKILL");
      } catch {
        // Fall back to killing individual PIDs below.
      }
    }
    for (const pid of targetPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore already-exited processes.
      }
    }
  }

  private async setStatus(serverId: string, status: ServerRecord["status"]) {
    await this.serverService.setStatus(serverId, status);
    eventBus.emit("serverStatus", { serverId, status });
  }

  private async markOrphaned(server: ServerRecord, activeProcesses: SystemProcess[], rootPid: number | null, command: string, args: string[], workingDirectory: string, scriptName: string) {
    if (this.running?.serverId === server.id) {
      this.running = null;
    }
    await this.writeProcessMetadata(server, {
      rootPid,
      pids: activeProcesses.map((item) => item.pid),
      workingDirectory,
      command,
      args,
      scriptName,
      startedAt: new Date().toISOString()
    });
    this.consoleLogService.append(server.id, "system", `检测到后台残留进程仍在运行：${processSummary(activeProcesses)}。状态已标记为疑似残留，请使用强制结束清理。\n`);
    await this.setStatus(server.id, "orphaned");
  }

  private async findBundledStartupScript(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const scripts = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => {
        const lower = name.toLowerCase();
        if (lower.startsWith("start-agent.")) return false;
        if (lower.startsWith("start-custom.")) return false;
        const supportedScript = process.platform === "win32" ? /\.(bat|cmd|ps1|sh)$/.test(lower) : lower.endsWith(".sh");
        return supportedScript && /(^|[-_])(run|start|launch|server)([-_]|\.|$)/.test(lower);
      })
      .sort((first, second) => scriptSortScore(first) - scriptSortScore(second));
    return scripts[0] ?? null;
  }

  private async findStartupScript(server: ServerRecord, workingDirectory: string) {
    const scriptName = await this.findBundledStartupScript(workingDirectory);
    if (!scriptName) return null;
    return {
      displayName: path.relative(server.directory, path.join(workingDirectory, scriptName)).replaceAll(path.sep, "/") || scriptName,
      scriptName,
      workingDirectory
    };
  }

  private async bundledPythonExecutable() {
    const executable = this.bundledPythonPath();
    await access(executable).catch(() => {
      throw new Error(`内置 Python 不存在：${executable}。请先让 Agent 调用 configure_builtin_python_environment 安装并配置内置 Python/MCDReforged，不要直接使用系统 Python。`);
    });
    return executable;
  }

  private bundledPythonPath() {
    return process.platform === "win32"
      ? path.join(appConfig.pythonDir, "python.exe")
      : path.join(appConfig.pythonDir, "bin", "python3");
  }

  private async verifyBundledMcdreforged(pythonPath: string, proxyUrl?: string) {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(pythonPath, ["-c", "import mcdreforged"], {
        cwd: appConfig.pythonDir,
        env: proxyEnv(proxyUrl),
        shell: false,
        windowsHide: true
      });
      const chunks: string[] = [];
      let settled = false;
      const finish = (error: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new Error("内置 Python 检查 MCDReforged 超时。请让 Agent 调用 configure_builtin_python_environment 重新配置内置 Python/MCDReforged。"));
      }, 30_000);
      timeout.unref();
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
      child.on("error", (error) => finish(new Error(`内置 Python 无法启动：${error.message}。请让 Agent 调用 configure_builtin_python_environment 重新配置内置 Python/MCDReforged。`)));
      child.on("exit", (code, signal) => {
        if (code === 0) finish(null);
        else finish(new Error(`内置 Python 缺少 MCDReforged 或无法加载，code=${code ?? "null"} signal=${signal ?? "null"}。请让 Agent 调用 configure_builtin_python_environment 重新配置内置 Python/MCDReforged。最近输出：\n${chunks.join("").slice(-2000)}`));
      });
    });
  }

  private scriptCommand(scriptName: string) {
    const lower = scriptName.toLowerCase();
    if (process.platform === "win32") {
      if (lower.endsWith(".bat") || lower.endsWith(".cmd")) return { command: windowsCommandProcessor(), args: ["/d", "/s", "/c", scriptName] };
      if (lower.endsWith(".ps1")) return { command: windowsPowerShell(), args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptName] };
      return { command: "sh", args: [scriptName] };
    }
    if (lower.endsWith(".sh")) return { command: "sh", args: [scriptName] };
    throw new Error(`Unsupported startup script on Linux: ${scriptName}`);
  }

  private async writeStartupScript(filePath: string, content: string) {
    await writeFile(filePath, content, "utf8");
    if (process.platform !== "win32") await chmod(filePath, 0o755).catch(() => undefined);
  }

  private async writeGeneratedStartupScript(server: ServerRecord, javaPath: string, args: string[], workingDirectory = server.directory) {
    const scriptName = process.platform === "win32" ? "start-agent.bat" : "start-agent.sh";
    const commandLine = [quoteScriptArg(javaPath), ...args.map(quoteScriptArg)].join(" ");
    const content = process.platform === "win32"
      ? `@echo off\r\n${commandLine}\r\n`
      : `#!/bin/sh\n${commandLine}\n`;
    await mkdir(workingDirectory, { recursive: true });
    await this.writeStartupScript(path.join(workingDirectory, scriptName), content);
    return scriptName;
  }

  private async writeCustomStartupScript(server: ServerRecord, javaPath: string, startupCommand: string, minMemory: string, maxMemory: string) {
    const scriptName = process.platform === "win32" ? "start-custom.bat" : "start-custom.sh";
    const commandLine = replaceMemoryArgs(this.applyStartupCommandVariables(startupCommand, server, javaPath, minMemory, maxMemory), minMemory, maxMemory);
    const content = process.platform === "win32"
      ? `@echo off\r\n${commandLine}\r\n`
      : `#!/bin/sh\n${commandLine}\n`;
    await mkdir(server.directory, { recursive: true });
    await this.writeStartupScript(path.join(server.directory, scriptName), content);
    return scriptName;
  }

  private applyStartupCommandVariables(command: string, server: ServerRecord, javaPath: string, minMemory: string, maxMemory: string) {
    const javaHome = path.basename(path.dirname(javaPath)).toLowerCase() === "bin" ? path.dirname(path.dirname(javaPath)) : path.dirname(javaPath);
    const pythonPath = this.bundledPythonPath();
    const values: Record<string, string> = {
      java: quoteScriptArg(javaPath),
      javaHome: quoteScriptArg(javaHome),
      python: quoteScriptArg(pythonPath),
      pythonHome: quoteScriptArg(path.dirname(pythonPath)),
      workspace: quoteScriptArg(appConfig.workspaceRoot),
      serverDir: quoteScriptArg(server.directory),
      minecraftDir: quoteScriptArg(path.join(server.directory, "server")),
      minMemory,
      maxMemory,
      memory: maxMemory,
      jarFile: quoteScriptArg(server.jarFile),
      startArgs: server.startArgs
    };
    return Object.entries(values).reduce((next, [key, value]) => next.replace(new RegExp(`\\{${escapeRegExp(key)}\\}`, "g"), value), command);
  }

  private async writeJvmArgs(server: ServerRecord, minMemory: string, maxMemory: string) {
    const targetDirectories = [server.directory, path.join(server.directory, "server")];
    await Promise.all(targetDirectories.map(async (targetDirectory) => {
      await mkdir(targetDirectory, { recursive: true });
      await writeFile(path.join(targetDirectory, "user_jvm_args.txt"), `-Xms${minMemory}\n-Xmx${maxMemory}\n`, "utf8").catch(() => undefined);
    }));
  }

  private async syncStartupScriptMemory(workingDirectory: string, scriptName: string, minMemory: string, maxMemory: string) {
    const scriptPath = path.join(workingDirectory, scriptName);
    const content = await readFile(scriptPath, "utf8").catch(() => null);
    if (content === null) return;
    const next = replaceMemoryArgs(content, minMemory, maxMemory);
    if (next !== content) await writeFile(scriptPath, next, "utf8").catch(() => undefined);
  }

  private async resolveJavaPath(server: ServerRecord) {
    if (server.javaVersion) {
      const managedJavaPath = await this.javaService.executableForInstalledVersion(server.javaVersion);
      if (managedJavaPath) return managedJavaPath;
    }
    return server.javaPath || "java";
  }

  private processEnv(proxyUrl: string | undefined, javaPath: string) {
    const env = { ...proxyEnv(proxyUrl) };
    if (!javaPath || javaPath === "java") return env;
    const javaBin = path.dirname(javaPath);
    const javaHome = path.basename(javaBin).toLowerCase() === "bin" ? path.dirname(javaBin) : javaBin;
    const delimiter = process.platform === "win32" ? ";" : ":";
    env.JAVA_HOME = javaHome;
    const pathKey = pathKeyForEnv(env);
    const existingPath = env[pathKey]
      || process.env.PATH
      || process.env.Path
      || (process.platform === "win32" ? `${path.dirname(windowsSystemExecutable("cmd.exe"))};${path.dirname(path.dirname(windowsSystemExecutable("cmd.exe")))}` : "/usr/local/bin:/usr/bin:/bin");
    env[pathKey] = existingPath ? `${javaBin}${delimiter}${existingPath}` : javaBin;
    dedupeWindowsPathKeys(env, pathKey);
    return env;
  }

  async start(serverId: string) {
    if (this.busy) throw new Error("Another process operation is in progress");
    if (this.running) {
      throw new Error(`Server ${this.running.serverId} is already running. Stop it before starting another server.`);
    }
    this.busy = true;
    try {
      const server = await this.serverService.requireServer(serverId);
      const existingProcesses = await this.findActiveServerProcesses(server);
      if (existingProcesses.length > 0) {
        await this.markOrphaned(server, existingProcesses, null, "", [], server.directory, "");
        throw new Error(`检测到该服务端已有后台残留进程：${processSummary(existingProcesses)}。请先使用强制结束清理，避免重复启动。`);
      }
      if (server.status === "orphaned") {
        await this.clearProcessMetadata(server);
      }

      await this.setStatus(serverId, "starting");
      this.consoleLogService.clear(serverId);
      this.consoleLogService.append(serverId, "system", "正在启动服务端...\n");

      const javaPath = await this.resolveJavaPath(server);
      const minMemory = server.minMemory;
      const maxMemory = server.maxMemory;
      await this.writeJvmArgs(server, minMemory, maxMemory);
      const proxyUrl = this.promptService.getAgentDownloadProxyUrl();
      const memoryArgs = [`-Xms${minMemory}`, `-Xmx${maxMemory}`];
      const proxyArgs = javaProxyArgs(proxyUrl);
      const jarFile = server.jarFile.trim();
      const startArgs = splitArgs(server.startArgs);
      const javaArgs = jarFile
        ? [...memoryArgs, ...proxyArgs, "-jar", jarFile, ...startArgs]
        : [...memoryArgs, ...proxyArgs, ...startArgs];
      const minecraftDirectory = path.join(server.directory, "server");
      let workingDirectory = server.directory;
      let generatedWorkingDirectory = server.directory;
      let generatedArgs = javaArgs;
      let activeScriptName = "";
      let fallbackWorkingDirectory = server.directory;
      let fallbackArgs = javaArgs;
      let fallbackStarted = false;
      let launch: { command: string; args: string[] } | null = null;
      const startupCommand = server.startupCommand?.trim();

      if (startupCommand) {
        if (startupCommand.includes("{python}")) {
          const pythonPath = await this.bundledPythonExecutable();
          await this.verifyBundledMcdreforged(pythonPath, proxyUrl);
        }
        const customScript = await this.writeCustomStartupScript(server, javaPath, startupCommand, minMemory, maxMemory);
        activeScriptName = customScript;
        launch = this.scriptCommand(customScript);
      } else {
        // MCDR layout (config.yml + server/): prefer scripts under server/ so root run.sh
        // from a mistaken Forge install cannot bypass the intended Minecraft directory.
        const hasMcdrLayout = await access(path.join(server.directory, "config.yml")).then(() => true).catch(() => false)
          && await access(minecraftDirectory).then(() => true).catch(() => false);
        if (hasMcdrLayout) {
          generatedWorkingDirectory = minecraftDirectory;
          fallbackWorkingDirectory = minecraftDirectory;
          fallbackArgs = javaArgs;
        }
        const bundledScript = hasMcdrLayout
          ? await this.findStartupScript(server, minecraftDirectory) ?? await this.findStartupScript(server, server.directory)
          : await this.findStartupScript(server, server.directory) ?? await this.findStartupScript(server, minecraftDirectory);
        if (bundledScript) {
          await this.syncStartupScriptMemory(bundledScript.workingDirectory, bundledScript.scriptName, minMemory, maxMemory);
          activeScriptName = bundledScript.displayName;
          workingDirectory = bundledScript.workingDirectory;
          fallbackWorkingDirectory = bundledScript.workingDirectory;
          launch = this.scriptCommand(bundledScript.scriptName);
        }

        if (!launch && jarFile) {
          const rootJarPath = path.isAbsolute(jarFile) ? jarFile : path.join(server.directory, jarFile);
          const nestedJarPath = path.isAbsolute(jarFile) ? jarFile : path.join(minecraftDirectory, jarFile);
          const rootJarExists = await access(rootJarPath).then(() => true).catch(() => false);
          const nestedJarExists = await access(nestedJarPath).then(() => true).catch(() => false);
          if (nestedJarExists || (hasMcdrLayout && rootJarExists)) {
            // Prefer server/ under MCDR layout; if jar only exists at root, still use it as last resort.
            const useNested = nestedJarExists;
            generatedWorkingDirectory = useNested ? minecraftDirectory : server.directory;
            generatedArgs = useNested && jarFile
              ? [...memoryArgs, ...proxyArgs, "-jar", path.basename(jarFile), ...startArgs]
              : javaArgs;
            fallbackWorkingDirectory = generatedWorkingDirectory;
            fallbackArgs = generatedArgs;
          } else if (rootJarExists && !hasMcdrLayout) {
            generatedWorkingDirectory = server.directory;
            generatedArgs = javaArgs;
          } else {
            throw new Error(`Cannot find jar file: ${jarFile}. Checked ${rootJarPath} and ${nestedJarPath}`);
          }
        } else if (!launch && startArgs.length === 0) {
          throw new Error("Cannot start server: jarFile is empty and startArgs is empty");
        } else if (!launch && hasMcdrLayout && startArgs.length > 0) {
          // Forge @libraries/.../unix_args.txt style: args are relative to Minecraft dir (server/).
          generatedWorkingDirectory = minecraftDirectory;
          generatedArgs = javaArgs;
          fallbackWorkingDirectory = minecraftDirectory;
          fallbackArgs = javaArgs;
        }

        if (!launch) {
          const generatedScript = await this.writeGeneratedStartupScript(server, javaPath, generatedArgs, generatedWorkingDirectory);
          activeScriptName = path.relative(server.directory, path.join(generatedWorkingDirectory, generatedScript)).replaceAll(path.sep, "/") || generatedScript;
          workingDirectory = generatedWorkingDirectory;
          fallbackStarted = true;
          launch = this.scriptCommand(generatedScript);
        }
      }
      if (!launch) throw new Error("Cannot resolve startup command");

      const spawnServer = (command: string, args: string[], name: string, cwd: string) => {
        const child = spawn(command, args, {
          cwd,
          env: this.processEnv(proxyUrl, javaPath),
          shell: false,
          windowsHide: true,
          detached: process.platform !== "win32"
        });
        const rootPid = child.pid ?? null;

        const owned: RunningProcess = { serverId, child, rootPid, launchId: randomUUID(), startedAt: new Date().toISOString(), logs: [], logCharacters: 0, logsTruncated: false };
        this.running = owned;
        void this.writeProcessMetadata(server, {
          rootPid,
          pids: rootPid ? [rootPid] : [],
          workingDirectory: cwd,
          command,
          args,
          scriptName: name,
          startedAt: new Date().toISOString()
        });
         child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
         child.stdout.on("data", (text: string) => this.appendManagedOutput(owned, text, "stdout"));
         child.stderr.on("data", (text: string) => this.appendManagedOutput(owned, text, "stderr"));
         child.stdin.on("error", (error) => {
           this.consoleLogService.append(serverId, "system", `服务端输入通道错误：${error.message}\n`);
         });
         child.on("error", async (error) => {
          this.consoleLogService.append(serverId, "system", `${spawnErrorDetails(error, command, args, cwd, this.processEnv(proxyUrl, javaPath))}\n`);
          await this.markStopped(serverId, "crashed");
        });
        child.on("exit", async (code, signal) => {
          const wasStopping = (await this.serverService.getServer(serverId))?.status === "stopping";
          if (!wasStopping && !startupCommand && !fallbackStarted && code !== 0 && signal === null) {
            fallbackStarted = true;
            const fallbackScript = await this.writeGeneratedStartupScript(server, javaPath, fallbackArgs, fallbackWorkingDirectory);
            const fallbackLaunch = this.scriptCommand(fallbackScript);
            activeScriptName = path.relative(server.directory, path.join(fallbackWorkingDirectory, fallbackScript)).replaceAll(path.sep, "/") || fallbackScript;
            this.consoleLogService.append(serverId, "system", `服务端自带启动脚本 ${name} 启动失败，改用生成脚本：${activeScriptName}\n`);
            spawnServer(fallbackLaunch.command, fallbackLaunch.args, activeScriptName, fallbackWorkingDirectory);
            return;
          }
          this.consoleLogService.append(serverId, "system", `服务端直接进程已退出，code=${code ?? "null"} signal=${signal ?? "null"}\n`);
          const remainingProcesses = await this.findActiveServerProcesses(server, rootPid);
          if (remainingProcesses.length > 0) {
            await this.markOrphaned(server, remainingProcesses, rootPid, command, args, cwd, name);
            return;
          }
          await this.markStopped(serverId, wasStopping || code === 0 ? "stopped" : "crashed");
        });
        return child;
      };

      spawnServer(launch.command, launch.args, activeScriptName, workingDirectory);

      await this.setStatus(serverId, "running");
      this.consoleLogService.append(serverId, "system", startupCommand
        ? `使用统一启动指令：${startupCommand}\n工作目录：${workingDirectory}\n启动脚本：${activeScriptName}\n启动命令：${launch.command} ${launch.args.join(" ")}\n`
        : activeScriptName.endsWith("start-agent.bat") || activeScriptName.endsWith("start-agent.sh")
          ? `未找到服务端自带启动脚本，已生成并执行：${activeScriptName}\n工作目录：${workingDirectory}\n启动命令：${launch.command} ${launch.args.join(" ")}\n`
          : `使用服务端自带启动脚本：${activeScriptName}\n工作目录：${workingDirectory}\n启动命令：${launch.command} ${launch.args.join(" ")}\n`);
      return { serverId, status: "running" as const };
    } catch (error) {
      const server = await this.serverService.getServer(serverId).catch(() => null);
      if (server?.status !== "orphaned") await this.setStatus(serverId, "stopped").catch(() => undefined);
      throw error;
    } finally {
      this.busy = false;
    }
  }

  async stop(serverId: string) {
    if (this.busy) throw new Error("另一个进程操作正在进行中，请稍后重试");
    const running = this.running;
    if (!running || running.serverId !== serverId) {
      throw new Error("Server is not running");
    }
    await this.setStatus(serverId, "stopping");
    this.consoleLogService.append(serverId, "system", "正在发送 stop 指令...\n");
    try {
      if (running.child.stdin.writable) running.child.stdin.write("stop\n");
      else throw new Error("stdin is not writable");
    } catch (error) {
      this.consoleLogService.append(serverId, "system", `无法发送 stop 指令：${error instanceof Error ? error.message : String(error)}。可使用强制结束清理进程树。\n`);
    }
    setTimeout(() => {
      if (this.running?.serverId === serverId) {
        this.consoleLogService.append(serverId, "system", "服务端未及时退出，仍可使用强制关闭。\n");
      }
    }, 20_000).unref();
    return { serverId, status: "stopping" as const };
  }

  async kill(serverId: string) {
    if (this.busy) throw new Error("另一个进程操作正在进行中，请稍后重试");
    const server = await this.serverService.requireServer(serverId);
    const running = this.running;
    if (running && running.serverId !== serverId) {
      throw new Error("Another server is running");
    }

    await this.setStatus(serverId, "stopping");
    this.consoleLogService.append(serverId, "system", "正在强制关闭服务端进程树...\n");

    if (running) {
      const activeProcesses = await this.findActiveServerProcesses(server, running.rootPid);
      await this.killProcessTree(running.rootPid, activeProcesses.map((item) => item.pid));
      return { serverId, status: "stopping" as const };
    }

    const activeProcesses = await this.findActiveServerProcesses(server);
    if (activeProcesses.length === 0) {
      this.consoleLogService.append(serverId, "system", "未检测到后台残留进程，状态已恢复为已停止。\n");
      await this.markStopped(serverId, "stopped");
      return { serverId, status: "stopped" as const };
    }

    await this.killProcessTree(null, activeProcesses.map((item) => item.pid));
    await delay(1000);
    const remainingProcesses = await this.findActiveServerProcesses(server);
    if (remainingProcesses.length > 0) {
      await this.markOrphaned(server, remainingProcesses, null, "", [], server.directory, "");
      return { serverId, status: "orphaned" as const };
    }

    this.consoleLogService.append(serverId, "system", "后台残留进程已清理。\n");
    await this.markStopped(serverId, "stopped");
    return { serverId, status: "stopped" as const };
  }

  async restart(serverId: string) {
    if (this.running?.serverId === serverId) {
      await this.kill(serverId);
      await delay(1000);
    } else if (this.running) {
      throw new Error(`Server ${this.running.serverId} is already running. Stop it before restarting another server.`);
    } else {
      const server = await this.serverService.requireServer(serverId);
      if (server.status === "orphaned") {
        const result = await this.kill(serverId);
        if (result.status === "orphaned") throw new Error("后台残留进程仍在运行，无法重启");
        await delay(1000);
      }
    }
    return this.start(serverId);
  }

  sendCommand(serverId: string, command: string) {
    const running = this.running;
    if (!running || running.serverId !== serverId) {
      throw new Error("Server is not running");
    }
    if (running.child.stdin.destroyed || running.child.stdin.writableEnded) {
      throw new Error("Server input channel is closed");
    }
    running.child.stdin.write(`${command}\n`);
    this.consoleLogService.append(serverId, "system", `> ${command}\n`);
  }

  async resetStatuses() {
    const servers = await this.serverService.listServers();
    for (const server of servers) {
      const activeProcesses = await this.findActiveServerProcesses(server);
      if (activeProcesses.length > 0) {
        await this.writeProcessMetadata(server, {
          rootPid: null,
          pids: activeProcesses.map((item) => item.pid),
          workingDirectory: server.directory,
          command: "",
          args: [],
          scriptName: "",
          startedAt: new Date().toISOString()
        });
        this.consoleLogService.append(server.id, "system", `管理后端启动时检测到后台残留进程：${processSummary(activeProcesses)}。状态已标记为疑似残留，请确认或强制结束。\n`);
        await this.setStatus(server.id, "orphaned");
      } else if (server.status !== "stopped") {
        await this.clearProcessMetadata(server);
        await this.setStatus(server.id, "stopped");
      } else {
        await this.clearProcessMetadata(server);
      }
    }
  }

  private async markStopped(serverId: string, status: ServerRecord["status"]) {
    if (this.running?.serverId === serverId) {
      this.running = null;
    }
    const server = await this.serverService.getServer(serverId).catch(() => null);
    if (server && status !== "orphaned") await this.clearProcessMetadata(server);
    await this.setStatus(serverId, status);
  }
}
