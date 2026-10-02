import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { resolveWithin } from "../../security/pathSandbox.js";
import { proxyEnv } from "../../services/proxySupport.js";
import { objectSchema, requireConfirmation, stringInput, type AgentTool, type AgentToolContext, type AgentToolInfo } from "../toolKit.js";

const defaultTimeoutMs = 120_000;
const maxTimeoutMs = 600_000;
const outputLimit = 4_000;
const consoleOutputLimit = 16_000;

export const shellToolInfo: AgentToolInfo = {
  name: "run_shell_command",
  description: "在当前服务端工作目录执行 Shell 命令或脚本，支持管道、重定向，返回标准输出、标准错误和退出码。",
  category: "Shell 执行",
  controllable: false
};

function systemExecutable(name: string) {
  return path.join(process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows", "System32", name);
}

function shellExecutable() {
  return process.platform === "win32"
    ? process.env.ComSpec || process.env.COMSPEC || systemExecutable("cmd.exe")
    : "/bin/sh";
}

function abortError() {
  const error = new Error("Agent 操作已中断");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

async function terminateProcessTree(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try {
      // The shell leads its own process group, including pipelines and script children.
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
    }
    return;
  }
  await new Promise<void>((resolve) => {
    const killer = spawn(systemExecutable("taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true, stdio: "ignore", timeout: 4_000
    });
    killer.once("error", () => { child.kill("SIGKILL"); resolve(); });
    killer.once("close", (code) => {
      if (code !== 0) child.kill("SIGKILL");
      resolve();
    });
  });
}

function runShell(command: string, cwd: string, timeoutMs: number, ctx: AgentToolContext) {
  throwIfAborted(ctx.signal);
  const shell = shellExecutable();
  const startedAt = Date.now();
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, {
      cwd, shell, env: proxyEnv(ctx.downloadProxyUrl?.()),
      windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"]
    });
    const output = { stdout: "", stderr: "" };
    let outputTruncated = false;
    let consoleChars = 0;
    let timedOut = false;
    let settled = false;
    let failure: Error | undefined;
    let termination: Promise<void> | undefined;
    let cleanupTimeout: NodeJS.Timeout | undefined;

    const append = (stream: "stdout" | "stderr", text: string) => {
      const combined = output[stream] + text;
      outputTruncated ||= combined.length > outputLimit;
      output[stream] = combined.slice(-outputLimit);
      const remaining = consoleOutputLimit - consoleChars;
      if (remaining <= 0) return;
      ctx.consoleLog?.(text.slice(0, remaining), stream);
      consoleChars += text.length;
      if (consoleChars >= consoleOutputLimit) ctx.consoleLog?.("Shell 控制台输出已截断；工具结果仍保留 stdout/stderr 的最近输出。");
    };
    const finish = (code: number | null, exitSignal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(cleanupTimeout);
      ctx.signal?.removeEventListener("abort", onAbort);
      const result = JSON.stringify({
        ok: !failure && code === 0, cwd, shell, exitCode: code, signal: exitSignal,
        timedOut, durationMs: Date.now() - startedAt, ...output, outputTruncated
      }, null, 2);
      if (failure?.name === "AbortError") reject(failure);
      else if (failure || code !== 0) reject(new Error(`${failure?.message ?? "Shell 命令执行失败"}\n${result}`));
      else resolve(result);
    };
    const stop = (error: Error) => {
      if (settled || termination) return;
      failure = error;
      // Bound cleanup even if an independently detached descendant holds an output pipe.
      cleanupTimeout = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(child.exitCode, child.signalCode);
      }, 5_000);
      cleanupTimeout.unref();
      termination = terminateProcessTree(child).catch((killError: unknown) => {
        ctx.consoleLog?.(`Shell 进程清理失败：${killError instanceof Error ? killError.message : String(killError)}`);
      });
    };
    const onAbort = () => stop(abortError());
    const timeout = setTimeout(() => {
      timedOut = true;
      stop(new Error(`Shell 命令执行超过 ${timeoutMs} 毫秒，已终止`));
    }, timeoutMs);
    timeout.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text: string) => append("stdout", text));
    child.stderr.on("data", (text: string) => append("stderr", text));
    child.once("error", (error) => { failure ??= error; finish(null, null); });
    // Wait for close rather than exit so the last stdout/stderr chunks are included.
    child.once("close", (code, exitSignal) => {
      void (async () => { await termination; finish(code, exitSignal); })();
    });
    ctx.signal?.addEventListener("abort", onAbort, { once: true });
    if (ctx.signal?.aborted) onAbort();
  });
}

export function createRunShellCommandTool(ctx: AgentToolContext): AgentTool {
  return {
    definition: {
      type: "function",
      function: {
        name: shellToolInfo.name,
        description: `${shellToolInfo.description} 当前系统为 ${process.platform}，使用 ${process.platform === "win32" ? "cmd.exe" : "/bin/sh"}。cwd 是相对于当前服务端根目录的已有子目录，默认 .。命令为非交互执行，默认超时 120 秒、最长 10 分钟；每路输出保留最近 4000 字符，并实时写入控制台。沿用现有操作确认/自动确认设置。工作目录校验不是操作系统沙箱，命令以应用进程权限运行。服务端的持续运行仍使用 start_current_server。`,
        parameters: objectSchema({
          command: { type: "string", description: "要执行的完整 Shell 命令，支持管道、重定向和脚本。" },
          cwd: { type: "string", description: "相对当前服务端根目录的工作目录，例如 . 或 server；不得使用绝对路径或 ..。" },
          timeoutMs: { type: "integer", minimum: 1, maximum: maxTimeoutMs, description: "超时毫秒数，默认 120000，最大 600000。" }
        }, ["command"])
      }
    },
    execute: async (input) => {
      throwIfAborted(ctx.signal);
      const command = stringInput(input, "command");
      if (!command.trim() || command.includes("\0")) throw new Error("command 必须是非空且不含空字符的 Shell 命令");
      if (input.cwd !== undefined && typeof input.cwd !== "string") throw new Error("cwd 必须是相对目录字符串");
      const timeoutMs = input.timeoutMs === undefined ? defaultTimeoutMs : input.timeoutMs;
      if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maxTimeoutMs) {
        throw new Error(`timeoutMs 必须是 1 到 ${maxTimeoutMs} 之间的整数`);
      }
      const server = await ctx.serverService.requireServer(ctx.getServerId());
      const requestedCwd = stringInput(input, "cwd", ".");
      const cwd = await resolveWithin(server.directory, requestedCwd, { mustExist: true });
      if (!(await stat(cwd)).isDirectory()) throw new Error("cwd 必须是已存在的目录");
      throwIfAborted(ctx.signal);
      await requireConfirmation(ctx, {
        title: "执行 Shell 命令",
        description: `工作目录：${cwd}\n命令：\n${command}\n超时：${timeoutMs} 毫秒`,
        risk: "high"
      });
      throwIfAborted(ctx.signal);
      // Confirmation can stay open for minutes; recheck a directory changed in the meantime.
      const confirmedCwd = await resolveWithin(server.directory, requestedCwd, { mustExist: true });
      if (confirmedCwd !== cwd || !(await stat(confirmedCwd)).isDirectory()) throw new Error("Shell 工作目录已改变，请重新执行");
      ctx.consoleLog?.(`执行 Shell（cwd=${cwd}）：\n${command}`);
      return runShell(command, cwd, timeoutMs, ctx);
    }
  };
}
