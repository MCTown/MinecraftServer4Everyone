import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import extractZip from "extract-zip";
import { fetch } from "undici";
import { appConfig } from "../../config.js";
import { fetchDispatcher, proxyEnv } from "../../services/proxySupport.js";
import { objectSchema, requireConfirmation, type AgentTool, type AgentToolContext, type AgentToolInfo } from "../toolKit.js";
import { spawn } from "node:child_process";

const windowsPythonVersion = "3.12.10";
const windowsPythonArchiveUrl = `https://www.python.org/ftp/python/${windowsPythonVersion}/python-${windowsPythonVersion}-embed-amd64.zip`;
const getPipUrl = "https://bootstrap.pypa.io/get-pip.py";
let builtinPythonInstallPromise: Promise<string> | null = null;

export const configureBuiltinPythonToolInfo: AgentToolInfo = {
  name: "configure_builtin_python_environment",
  description: "配置 workspace/python 的内置 Python，并安装 pip 与 MCDReforged。Windows 会下载 embeddable Python；Linux 会用系统 python3 创建 venv。最终验证必须使用工作区 Python，不直接使用系统 Python。",
  category: "Python 环境",
  controllable: false
};

function pythonExecutable() {
  return process.platform === "win32"
    ? path.join(appConfig.pythonDir, "python.exe")
    : path.join(appConfig.pythonDir, "bin", "python3");
}

async function exists(filePath: string) {
  return access(filePath).then(() => true).catch(() => false);
}

async function downloadFile(url: string, destination: string, ctx: AgentToolContext) {
  const response = await fetch(url, { signal: ctx.signal, dispatcher: fetchDispatcher(ctx.downloadProxyUrl?.()) });
  if (!response.ok || !response.body) throw new Error(`下载失败：${url} HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

async function runCommand(command: string, args: string[], cwd: string, ctx: AgentToolContext, timeoutMessage: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: proxyEnv(ctx.downloadProxyUrl?.()), shell: false, windowsHide: true });
    const chunks: string[] = [];
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ctx.signal?.removeEventListener("abort", onAbort);
      const output = chunks.join("");
      if (error) reject(new Error(`${error.message}\n最近输出：\n${output.slice(-3000)}`));
      else resolve(output);
    };
    const onAbort = () => {
      child.kill("SIGKILL");
      const error = new Error("Agent 操作已中断");
      error.name = "AbortError";
      finish(error);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(timeoutMessage));
    }, 600_000);
    timeout.unref();
    ctx.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      chunks.push(text);
      ctx.consoleLog?.(text, "stdout");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      chunks.push(text);
      ctx.consoleLog?.(text, "stderr");
    });
    child.on("error", finish);
    child.on("exit", (code, signal) => {
      if (code === 0) finish(null);
      else finish(new Error(`命令失败：${command} ${args.join(" ")}，code=${code ?? "null"} signal=${signal ?? "null"}`));
    });
  });
}

async function enableImportSite() {
  const entries = await readdir(appConfig.pythonDir);
  const pthName = entries.find((entry) => /^python\d+\._pth$/i.test(entry));
  if (!pthName) throw new Error("未找到 Python embeddable ._pth 文件");
  const pthPath = path.join(appConfig.pythonDir, pthName);
  const content = await readFile(pthPath, "utf8");
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  if (lines.some((line) => line.trim() === "import site")) return;

  let replaced = false;
  const nextLines = lines.map((line) => {
    if (!replaced && /^\s*#\s*import site\s*$/i.test(line)) {
      replaced = true;
      return "import site";
    }
    return line;
  });
  const nextContent = replaced ? nextLines.join(eol).trimEnd() : `${content.trimEnd()}${eol}import site`;
  await writeFile(pthPath, `${nextContent}${eol}`, "utf8");
}

async function runPython(args: string[], cwd: string, ctx: AgentToolContext) {
  return runCommand(pythonExecutable(), args, cwd, ctx, "Python 环境配置超过 10 分钟，已终止");
}

async function ensurePip(ctx: AgentToolContext) {
  const getPipPath = path.join(appConfig.pythonDir, "get-pip.py");
  try {
    await runPython(["-m", "pip", "--version"], appConfig.pythonDir, ctx);
    return;
  } catch {
    ctx.consoleLog?.("内置 pip 不可用，正在安装 pip");
  }

  if (process.platform !== "win32") {
    await runPython(["-m", "ensurepip", "--upgrade"], appConfig.pythonDir, ctx).catch(() => undefined);
    try {
      await runPython(["-m", "pip", "--version"], appConfig.pythonDir, ctx);
      return;
    } catch {
      ctx.consoleLog?.("ensurepip 不可用，改用 get-pip.py 安装 pip");
    }
  }

  ctx.consoleLog?.(`下载 get-pip.py：${getPipUrl}`);
  await downloadFile(getPipUrl, getPipPath, ctx);
  await runPython([getPipPath, "--no-warn-script-location"], appConfig.pythonDir, ctx);
  await runPython(["-m", "pip", "--version"], appConfig.pythonDir, ctx);
}

async function installWindowsPython(ctx: AgentToolContext) {
  const tempDir = path.join(appConfig.workspaceRoot, "_python_install");
  const archivePath = path.join(tempDir, `python-${windowsPythonVersion}-embed-amd64.zip`);
  const extractRoot = path.join(tempDir, "extract");
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });
  await rm(archivePath, { force: true });
  await rm(extractRoot, { recursive: true, force: true });
  await mkdir(extractRoot, { recursive: true });
  ctx.consoleLog?.(`下载内置 Python：${windowsPythonArchiveUrl}`);
  await downloadFile(windowsPythonArchiveUrl, archivePath, ctx);
  await extractZip(archivePath, { dir: extractRoot });
  await rm(appConfig.pythonDir, { recursive: true, force: true });
  await mkdir(appConfig.pythonDir, { recursive: true });
  const entries = await readdir(extractRoot);
  for (const entry of entries) {
    await rename(path.join(extractRoot, entry), path.join(appConfig.pythonDir, entry));
  }
  await rm(tempDir, { recursive: true, force: true });
  await enableImportSite();
  return { bootstrapPython: "windows-embeddable" };
}

async function findLinuxSystemPython(ctx: AgentToolContext) {
  const candidates = ["python3.12", "python3.11", "python3.10", "python3"];
  const script = "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')";
  for (const candidate of candidates) {
    const output = await runCommand(candidate, ["-c", script], appConfig.workspaceRoot, ctx, `检查 ${candidate} 超时`).catch(() => "");
    const match = output.match(/(\d+)\.(\d+)/);
    const major = Number(match?.[1] ?? 0);
    const minor = Number(match?.[2] ?? 0);
    if (major === 3 && minor >= 10) return candidate;
  }
  throw new Error("Linux 自动配置工作区 Python 需要系统中可执行的 Python 3.10+（python3.10/python3.11/python3.12/python3）。请先安装 Python 和 venv 模块，例如 Debian/Ubuntu: apt install python3 python3-venv。");
}

async function installLinuxPython(ctx: AgentToolContext) {
  const systemPython = await findLinuxSystemPython(ctx);
  ctx.consoleLog?.(`使用 ${systemPython} 创建工作区 Python venv：${appConfig.pythonDir}`);
  await rm(appConfig.pythonDir, { recursive: true, force: true });
  await mkdir(appConfig.workspaceRoot, { recursive: true });
  try {
    await runCommand(systemPython, ["-m", "venv", appConfig.pythonDir], appConfig.workspaceRoot, ctx, "Linux Python venv 创建超过 10 分钟，已终止");
  } catch (error) {
    throw new Error(`创建 Linux 工作区 Python venv 失败。请确认已安装 venv 模块，例如 Debian/Ubuntu: apt install python3-venv。${error instanceof Error ? error.message : String(error)}`);
  }
  return { bootstrapPython: systemPython };
}

async function configureBuiltinPython(ctx: AgentToolContext) {
  await mkdir(appConfig.pythonDir, { recursive: true });
  const executable = pythonExecutable();
  let bootstrapPython = "existing-workspace-python";
  if (!(await exists(executable))) {
    if (process.platform === "win32") bootstrapPython = (await installWindowsPython(ctx)).bootstrapPython;
    else if (process.platform === "linux") bootstrapPython = (await installLinuxPython(ctx)).bootstrapPython;
    else throw new Error(`内置 Python 自动安装目前支持 Windows 和 Linux，当前平台不支持：${process.platform}`);
  }

  if (process.platform === "win32") await enableImportSite();
  await ensurePip(ctx);
  await runPython(["-m", "pip", "install", "--upgrade", "pip", "mcdreforged"], appConfig.pythonDir, ctx);
  const runtimePythonVersion = await runPython(["--version"], appConfig.pythonDir, ctx);
  const versionOutput = await runPython(["-c", "import mcdreforged; print(getattr(mcdreforged, '__version__', 'installed'))"], appConfig.pythonDir, ctx);
  return JSON.stringify({
    pythonVersion: runtimePythonVersion.trim(),
    pythonPath: executable,
    pythonDirectory: appConfig.pythonDir,
    mcdreforged: versionOutput.trim() || "installed",
    bootstrapPython,
    systemPythonUsed: false
  }, null, 2);
}

export function createConfigureBuiltinPythonTool(ctx: AgentToolContext): AgentTool {
  return {
    definition: {
      type: "function",
      function: {
        name: configureBuiltinPythonToolInfo.name,
        description: configureBuiltinPythonToolInfo.description,
        parameters: objectSchema({})
      }
    },
    execute: async () => {
      if (process.platform !== "win32" && process.platform !== "linux") throw new Error(`内置 Python 自动安装目前支持 Windows 和 Linux，当前平台不支持：${process.platform}`);
      await requireConfirmation(ctx, {
        title: "安装并配置内置 Python",
        description: process.platform === "win32"
          ? `Agent 准备下载 Python ${windowsPythonVersion} 到应用工作区 ${appConfig.pythonDir}，安装 pip 与 MCDReforged，并确保最终验证使用工作区 Python。`
          : `Agent 准备使用系统 python3 在应用工作区 ${appConfig.pythonDir} 创建 venv，安装 pip 与 MCDReforged，并确保最终验证使用工作区 Python。`,
        risk: "high"
      });

      if (builtinPythonInstallPromise) {
        ctx.consoleLog?.("内置 Python 正在由另一个 Agent 任务配置，等待完成。");
        return builtinPythonInstallPromise;
      }
      builtinPythonInstallPromise = configureBuiltinPython(ctx).finally(() => {
        builtinPythonInstallPromise = null;
      });
      return builtinPythonInstallPromise;
    }
  };
}
