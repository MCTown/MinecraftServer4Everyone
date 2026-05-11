import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { access, readdir, writeFile } from "node:fs/promises";
import type { ServerRecord } from "../types.js";
import { ConsoleLogService } from "./consoleLogService.js";
import { eventBus } from "./eventBus.js";
import { javaProxyArgs, proxyEnv } from "./proxySupport.js";
import { PromptService } from "./promptService.js";
import { ServerService } from "./serverService.js";

interface RunningProcess {
  serverId: string;
  child: ChildProcessWithoutNullStreams;
}

function splitArgs(input: string) {
  const matches = input.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  return matches.map((part) => part.replace(/^"|"$/g, ""));
}

function scriptSortScore(fileName: string) {
  const lower = fileName.toLowerCase();
  const names = ["run", "start", "server", "launch", "startserver", "server-start"];
  const extensions = process.platform === "win32" ? [".bat", ".cmd", ".ps1", ".sh"] : [".sh", ".bat", ".cmd", ".ps1"];
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

export class ProcessManager {
  private running: RunningProcess | null = null;
  private busy = false;

  constructor(
    private readonly serverService: ServerService,
    private readonly consoleLogService: ConsoleLogService,
    private readonly promptService: PromptService
  ) {}

  getActiveServerId() {
    return this.running?.serverId ?? null;
  }

  private async findBundledStartupScript(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const scripts = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => {
        const lower = name.toLowerCase();
        if (lower.startsWith("start-agent.")) return false;
        return /\.(bat|cmd|ps1|sh)$/.test(lower) && /(^|[-_])(run|start|launch|server)([-_]|\.|$)/.test(lower);
      })
      .sort((first, second) => scriptSortScore(first) - scriptSortScore(second));
    return scripts[0] ?? null;
  }

  private scriptCommand(scriptName: string) {
    const lower = scriptName.toLowerCase();
    if (process.platform === "win32") {
      if (lower.endsWith(".bat") || lower.endsWith(".cmd")) return { command: "cmd.exe", args: ["/d", "/s", "/c", scriptName] };
      if (lower.endsWith(".ps1")) return { command: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptName] };
      return { command: "sh", args: [scriptName] };
    }
    if (lower.endsWith(".sh")) return { command: "sh", args: [scriptName] };
    return { command: "sh", args: [scriptName] };
  }

  private async writeGeneratedStartupScript(server: ServerRecord, javaPath: string, args: string[]) {
    const scriptName = process.platform === "win32" ? "start-agent.bat" : "start-agent.sh";
    const commandLine = [quoteScriptArg(javaPath), ...args.map(quoteScriptArg)].join(" ");
    const content = process.platform === "win32"
      ? `@echo off\r\n${commandLine}\r\n`
      : `#!/bin/sh\n${commandLine}\n`;
    await writeFile(path.join(server.directory, scriptName), content, "utf8");
    return scriptName;
  }

  private async writeJvmArgs(server: ServerRecord, minMemory: string, maxMemory: string) {
    await writeFile(path.join(server.directory, "user_jvm_args.txt"), `-Xms${minMemory}\n-Xmx${maxMemory}\n`, "utf8").catch(() => undefined);
  }

  async start(serverId: string) {
    if (this.busy) throw new Error("Another process operation is in progress");
    if (this.running) {
      throw new Error(`Server ${this.running.serverId} is already running. Stop it before starting another server.`);
    }
    this.busy = true;
    try {
      const server = await this.serverService.requireServer(serverId);
      await this.serverService.setStatus(serverId, "starting");
      eventBus.emit("serverStatus", { serverId, status: "starting" });
      this.consoleLogService.clear(serverId);
      this.consoleLogService.append(serverId, "system", "正在启动服务端...\n");

      const javaPath = server.javaPath || "java";
      const memorySettings = this.promptService.getAgentSettings();
      const minMemory = memorySettings.memory || server.minMemory;
      const maxMemory = memorySettings.memory || server.maxMemory;
      await this.writeJvmArgs(server, minMemory, maxMemory);
      const proxyUrl = this.promptService.getAgentDownloadProxyUrl();
      const memoryArgs = [`-Xms${minMemory}`, `-Xmx${maxMemory}`];
      const proxyArgs = javaProxyArgs(proxyUrl);
      const jarFile = server.jarFile.trim();
      const startArgs = splitArgs(server.startArgs);
      const javaArgs = jarFile
        ? [...memoryArgs, ...proxyArgs, "-jar", jarFile, ...startArgs]
        : [...memoryArgs, ...proxyArgs, ...startArgs];
      let scriptName = await this.findBundledStartupScript(server.directory);
      let launch = scriptName ? this.scriptCommand(scriptName) : null;

      if (!scriptName && jarFile) {
        const jarPath = path.join(server.directory, jarFile);
        await access(jarPath).catch(() => {
          throw new Error(`Cannot find jar file: ${jarFile}`);
        });
      } else if (!scriptName && startArgs.length === 0) {
        throw new Error("Cannot start server: jarFile is empty and startArgs is empty");
      }

      if (!scriptName) {
        scriptName = await this.writeGeneratedStartupScript(server, javaPath, javaArgs);
        launch = this.scriptCommand(scriptName);
      }
      if (!launch) throw new Error("Cannot resolve startup command");

      let activeScriptName = scriptName;
      let fallbackStarted = activeScriptName.startsWith("start-agent.");
      const spawnServer = (command: string, args: string[], name: string) => {
        const child = spawn(command, args, {
          cwd: server.directory,
          env: proxyEnv(proxyUrl),
          shell: false,
          windowsHide: true
        });

        this.running = { serverId, child };
        child.stdout.on("data", (chunk: Buffer) => this.consoleLogService.append(serverId, "stdout", chunk.toString("utf8")));
        child.stderr.on("data", (chunk: Buffer) => this.consoleLogService.append(serverId, "stderr", chunk.toString("utf8")));
        child.on("error", async (error) => {
          this.consoleLogService.append(serverId, "system", `启动失败：${error.message}\n`);
          await this.markStopped(serverId, "crashed");
        });
        child.on("exit", async (code, signal) => {
          const wasStopping = (await this.serverService.getServer(serverId))?.status === "stopping";
          if (!wasStopping && !fallbackStarted && code !== 0 && signal === null) {
            fallbackStarted = true;
            const fallbackScript = await this.writeGeneratedStartupScript(server, javaPath, javaArgs);
            const fallbackLaunch = this.scriptCommand(fallbackScript);
            activeScriptName = fallbackScript;
            this.consoleLogService.append(serverId, "system", `服务端自带启动脚本 ${name} 启动失败，改用生成脚本：${fallbackScript}\n`);
            spawnServer(fallbackLaunch.command, fallbackLaunch.args, fallbackScript);
            return;
          }
          this.consoleLogService.append(serverId, "system", `服务端进程已退出，code=${code ?? "null"} signal=${signal ?? "null"}\n`);
          await this.markStopped(serverId, wasStopping || code === 0 ? "stopped" : "crashed");
        });
        return child;
      };

      spawnServer(launch.command, launch.args, activeScriptName);

      await this.serverService.setStatus(serverId, "running");
      eventBus.emit("serverStatus", { serverId, status: "running" });
      this.consoleLogService.append(serverId, "system", activeScriptName.startsWith("start-agent.")
        ? `未找到服务端自带启动脚本，已生成并执行：${activeScriptName}\n启动命令：${launch.command} ${launch.args.join(" ")}\n`
        : `使用服务端自带启动脚本：${activeScriptName}\n启动命令：${launch.command} ${launch.args.join(" ")}\n`);
      return { serverId, status: "running" as const };
    } catch (error) {
      await this.serverService.setStatus(serverId, "stopped").catch(() => undefined);
      eventBus.emit("serverStatus", { serverId, status: "stopped" });
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
    await this.serverService.setStatus(serverId, "stopping");
    eventBus.emit("serverStatus", { serverId, status: "stopping" });
    this.consoleLogService.append(serverId, "system", "正在发送 stop 指令...\n");
    running.child.stdin.write("stop\n");
    setTimeout(() => {
      if (this.running?.serverId === serverId) {
        this.consoleLogService.append(serverId, "system", "服务端未及时退出，仍可使用强制关闭。\n");
      }
    }, 20_000).unref();
    return { serverId, status: "stopping" as const };
  }

  async kill(serverId: string) {
    const running = this.running;
    if (!running || running.serverId !== serverId) {
      throw new Error("Server is not running");
    }
    await this.serverService.setStatus(serverId, "stopping");
    eventBus.emit("serverStatus", { serverId, status: "stopping" });
    this.consoleLogService.append(serverId, "system", "正在强制关闭服务端...\n");
    running.child.kill("SIGKILL");
    return { serverId, status: "stopping" as const };
  }

  async restart(serverId: string) {
    if (this.running?.serverId === serverId) {
      await this.kill(serverId);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } else if (this.running) {
      throw new Error(`Server ${this.running.serverId} is already running. Stop it before restarting another server.`);
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
    await Promise.all(servers.filter((server) => server.status !== "stopped").map((server) => this.serverService.setStatus(server.id, "stopped")));
  }

  private async markStopped(serverId: string, status: ServerRecord["status"]) {
    if (this.running?.serverId === serverId) {
      this.running = null;
    }
    await this.serverService.setStatus(serverId, status);
    eventBus.emit("serverStatus", { serverId, status });
  }
}
