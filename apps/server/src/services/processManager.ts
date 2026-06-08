import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import path from "node:path";
import { access, chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import type { ServerRecord } from "../types.js";
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

  constructor(
    private readonly serverService: ServerService,
    private readonly consoleLogService: ConsoleLogService,
    private readonly promptService: PromptService,
    private readonly javaService: JavaService
  ) {}

  getActiveServerId() {
    return this.running?.serverId ?? null;
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

  private async collectSystemProcesses(): Promise<SystemProcess[]> {
    if (process.platform === "win32") {
      const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
      const result = await this.runBufferedProcess(windowsPowerShell(), ["-NoProfile", "-Command", script]).catch(() => null);
      if (!result?.stdout.trim()) return [];
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
        return [];
      }
    }

    const result = await this.runBufferedProcess("ps", ["-eo", "pid=,ppid=,comm=,args="]).catch(() => null);
    if (!result?.stdout.trim()) return [];
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

  private async findActiveServerProcesses(server: ServerRecord, trustedRootPid: number | null = null) {
    const processes = await this.collectSystemProcesses();
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
        const bundledScript = await this.findStartupScript(server, server.directory) ?? await this.findStartupScript(server, minecraftDirectory);
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
          if (rootJarExists) {
            generatedWorkingDirectory = server.directory;
            generatedArgs = javaArgs;
          } else if (nestedJarExists) {
            generatedWorkingDirectory = minecraftDirectory;
            generatedArgs = jarFile
              ? [...memoryArgs, ...proxyArgs, "-jar", path.basename(jarFile), ...startArgs]
              : [...memoryArgs, ...proxyArgs, ...startArgs];
          } else {
            throw new Error(`Cannot find jar file: ${jarFile}. Checked ${rootJarPath} and ${nestedJarPath}`);
          }
        } else if (!launch && startArgs.length === 0) {
          throw new Error("Cannot start server: jarFile is empty and startArgs is empty");
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

        this.running = { serverId, child, rootPid };
        void this.writeProcessMetadata(server, {
          rootPid,
          pids: rootPid ? [rootPid] : [],
          workingDirectory: cwd,
          command,
          args,
          scriptName: name,
          startedAt: new Date().toISOString()
        });
        child.stdout.on("data", (chunk: Buffer) => this.consoleLogService.append(serverId, "stdout", chunk.toString("utf8")));
        child.stderr.on("data", (chunk: Buffer) => this.consoleLogService.append(serverId, "stderr", chunk.toString("utf8")));
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
