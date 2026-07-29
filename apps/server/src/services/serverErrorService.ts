import type { ConsoleLogEntry, ServerErrorDigest, ServerErrorState, ServerRecord } from "../types.js";
import { ConsoleLogService } from "./consoleLogService.js";
import { eventBus } from "./eventBus.js";
import { ServerService } from "./serverService.js";

interface ErrorPattern {
  level: "error" | "fatal";
  pattern: RegExp;
}

// Ordered by severity: the first match wins for a given line.
const errorPatterns: ErrorPattern[] = [
  { level: "fatal", pattern: /^\s*(?:启动失败：|无法发送 stop 指令：)/ },
  { level: "fatal", pattern: /Exception in thread/i },
  { level: "fatal", pattern: /\b(?:FATAL|SEVERE)\b/ },
  { level: "fatal", pattern: /Could not reserve enough space for .*object heap/i },
  { level: "fatal", pattern: /(?:Unable to access|Invalid or corrupt) jarfile/i },
  { level: "fatal", pattern: /\bA problem occurred running the Server process\b/i },
  { level: "fatal", pattern: /\bcrash-reports?[/\\]/i },
  { level: "fatal", pattern: /\bUnsupportedClassVersionError\b/ },
  { level: "error", pattern: /^\s*Caused by:\s/ },
  { level: "error", pattern: /^\s*at\s+[\w$.]+\([^)]*\)\s*$/ },
  { level: "error", pattern: /\bjava\.[\w.$]*(?:Exception|Error)\b/ },
  { level: "error", pattern: /\b[\w.$]*(?:Exception|Error):\s/ },
  { level: "error", pattern: /\[ERROR\]|\/ERROR\]|\bERROR\b\s*[:\]]/ },
  { level: "error", pattern: /^\s*(?:Error|错误)[:：]\s*\S/ }
];

// Lines that look like errors but are routine noise on many modpacks.
const ignorePatterns: RegExp[] = [
  /\bERROR_?(?:NONE|OK)\b/i,
  /Advanced terminal features are not available/i,
  /^\s*\[Agent\]\s/
];

function normalizeLines(text: string) {
  return text.replace(/\r/g, "").split("\n").map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
}

function classifyLine(line: string) {
  if (ignorePatterns.some((pattern) => pattern.test(line))) return null;
  const match = errorPatterns.find((candidate) => candidate.pattern.test(line));
  return match ? match.level : null;
}

function isHigherLevel(next: ServerErrorState["level"], current: ServerErrorState["level"]) {
  if (next === "fatal") return current !== "fatal";
  return current === null;
}

function idleState(serverId: string): ServerErrorState {
  return { serverId, hasError: false, level: null, count: 0, latestText: "", firstAt: null, lastAt: null };
}

export class ServerErrorService {
  private states = new Map<string, ServerErrorState>();
  private seeded = new Set<string>();
  private readonly digestMaxChars = 12000;
  private readonly digestMaxLines = 220;
  private readonly contextLinesBefore = 2;
  private readonly contextLinesAfter = 6;

  constructor(
    private readonly serverService: ServerService,
    private readonly consoleLogService: ConsoleLogService
  ) {
    eventBus.on("console", (entry) => this.handleLogEntry(entry));
    eventBus.on("consoleClear", ({ serverId }) => this.reset(serverId));
    eventBus.on("serverStatus", ({ serverId, status }) => this.handleStatus(serverId, status));
  }

  getState(serverId: string): ServerErrorState {
    this.ensureSeeded(serverId);
    return this.states.get(serverId) ?? idleState(serverId);
  }

  async listStates() {
    const servers = await this.serverService.listServers();
    return servers.map((server) => this.stateForServer(server));
  }

  reset(serverId: string) {
    const previous = this.states.get(serverId);
    this.states.set(serverId, idleState(serverId));
    this.seeded.add(serverId);
    if (previous?.hasError) this.emitState(serverId);
  }

  forget(serverId: string) {
    this.states.delete(serverId);
    this.seeded.delete(serverId);
  }

  /**
   * Extracts the error-relevant slice of the console history and wraps it into a
   * ready-to-send analysis request for the Agent.
   */
  buildDigest(serverId: string): ServerErrorDigest {
    const entries = this.consoleLogService.list(serverId, 800);
    const lines: Array<{ text: string; level: ServerErrorState["level"] }> = [];
    for (const entry of entries) {
      for (const line of normalizeLines(entry.text)) {
        lines.push({ text: line, level: classifyLine(line) });
      }
    }

    const keep = new Set<number>();
    for (const [index, line] of lines.entries()) {
      if (!line.level) continue;
      const from = Math.max(0, index - this.contextLinesBefore);
      const to = Math.min(lines.length - 1, index + this.contextLinesAfter);
      for (let cursor = from; cursor <= to; cursor += 1) keep.add(cursor);
    }

    const state = this.getState(serverId);
    const selected = [...keep].sort((first, second) => first - second);
    const truncated = selected.length > this.digestMaxLines;
    const tail = truncated ? selected.slice(-this.digestMaxLines) : selected;

    let excerpt = "";
    let lastIndex = -1;
    for (const index of tail) {
      const line = lines[index];
      if (!line) continue;
      if (lastIndex >= 0 && index > lastIndex + 1) excerpt += "...\n";
      excerpt += `${line.text}\n`;
      lastIndex = index;
    }
    if (excerpt.length > this.digestMaxChars) {
      excerpt = `...（前部已截断）\n${excerpt.slice(-this.digestMaxChars)}`;
    }

    const errorLineCount = lines.filter((line) => line.level).length;
    return {
      serverId,
      hasError: state.hasError || errorLineCount > 0,
      level: state.level,
      errorLineCount,
      truncated: truncated || excerpt.length >= this.digestMaxChars,
      excerpt: excerpt.trimEnd(),
      prompt: this.buildPrompt(excerpt.trimEnd(), state)
    };
  }

  private buildPrompt(excerpt: string, state: ServerErrorState) {
    if (!excerpt) {
      return [
        "请分析当前服务端终端里的报错。",
        "终端里没有提取到明显的报错行，请先用工具查看服务端日志（logs/latest.log、crash-reports 目录）再给出结论。"
      ].join("\n");
    }
    // null drops the optional line; "" is a deliberate blank separator and must survive.
    const lines: Array<string | null> = [
      "请分析下面这段服务端终端输出中的报错，并给出可执行的修复方案。",
      state.level ? `当前检测到的最高严重级别：${state.level === "fatal" ? "致命" : "错误"}。` : null,
      "",
      "要求：",
      "1. 先用一句话说明根本原因；",
      "2. 再列出具体的修复步骤（涉及文件、配置项、Java 版本、内存或依赖时请写清楚）；",
      "3. 如果信息不足，说明还需要查看哪个文件，并直接用工具去读取确认；",
      "4. 不要重复粘贴整段日志。",
      "",
      "终端报错节选：",
      "```log",
      excerpt,
      "```"
    ];
    return lines.filter((line): line is string => line !== null).join("\n");
  }

  private stateForServer(server: ServerRecord) {
    const state = this.getState(server.id);
    if (state.hasError) return state;
    if (server.status === "crashed" || server.status === "orphaned") {
      return { ...state, hasError: true, level: state.level ?? "error" };
    }
    return state;
  }

  private ensureSeeded(serverId: string) {
    if (this.seeded.has(serverId)) return;
    this.seeded.add(serverId);
    this.states.set(serverId, idleState(serverId));
    let entries: ConsoleLogEntry[] = [];
    try {
      entries = this.consoleLogService.list(serverId, 800);
    } catch {
      return;
    }
    for (const entry of entries) this.applyEntry(entry, false);
  }

  private handleLogEntry(entry: ConsoleLogEntry) {
    this.ensureSeeded(entry.serverId);
    this.applyEntry(entry, true);
  }

  private applyEntry(entry: ConsoleLogEntry, notify: boolean) {
    const current = this.states.get(entry.serverId) ?? idleState(entry.serverId);
    let next = current;
    for (const line of normalizeLines(entry.text)) {
      const level = classifyLine(line);
      if (!level) continue;
      next = {
        serverId: entry.serverId,
        hasError: true,
        level: isHigherLevel(level, next.level) ? level : next.level,
        count: next.count + 1,
        latestText: line.slice(0, 400),
        firstAt: next.firstAt ?? entry.createdAt,
        lastAt: entry.createdAt
      };
    }
    if (next === current) return;
    const becameVisible = !current.hasError || current.level !== next.level;
    this.states.set(entry.serverId, next);
    if (notify && becameVisible) this.emitState(entry.serverId);
  }

  private handleStatus(serverId: string, status: ServerRecord["status"]) {
    if (status !== "crashed" && status !== "orphaned") return;
    this.ensureSeeded(serverId);
    const current = this.states.get(serverId) ?? idleState(serverId);
    if (current.hasError) return;
    this.states.set(serverId, {
      ...current,
      hasError: true,
      level: current.level ?? "error",
      latestText: current.latestText || (status === "crashed" ? "服务端异常退出" : "检测到疑似后台残留进程"),
      firstAt: current.firstAt ?? new Date().toISOString(),
      lastAt: new Date().toISOString()
    });
    this.emitState(serverId);
  }

  private emitState(serverId: string) {
    eventBus.emit("serverError", this.states.get(serverId) ?? idleState(serverId));
  }
}
