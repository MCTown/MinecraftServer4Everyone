import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import extractZip from "extract-zip";
import { extract as extractTar } from "tar";
import { fetch } from "undici";
import { appConfig } from "../../config.js";
import { fetchDispatcher, proxyEnv } from "../../services/proxySupport.js";
import { objectSchema, requireConfirmation, stringArrayInput, type AgentTool, type AgentToolContext, type AgentToolInfo } from "../toolKit.js";
import { spawn } from "node:child_process";

const pythonVersion = "3.10.14";
const pythonBuildRelease = "20240726";
const windowsPythonArchiveUrl = `https://www.python.org/ftp/python/${pythonVersion}/python-${pythonVersion}-embed-amd64.zip`;
const linuxPythonArchiveUrl = (architecture: string) =>
  `https://github.com/astral-sh/python-build-standalone/releases/download/${pythonBuildRelease}/cpython-${pythonVersion}%2B${pythonBuildRelease}-${architecture}-unknown-linux-gnu-install_only.tar.gz`;
const getPipUrl = "https://bootstrap.pypa.io/get-pip.py";
let builtinPythonInstallPromise: Promise<string> | null = null;

export const configureBuiltinPythonToolInfo: AgentToolInfo = {
  name: "configure_builtin_python_environment",
  description: "配置 workspace/python 的内置 Python 3.10，并安装 pip 与 MCDReforged。Windows 和 Linux 都会下载独立运行时到工作区；不使用系统 Python、venv 或 ensurepip。",
  category: "Python 环境",
  controllable: false
};

export const installMcdrPluginDependenciesToolInfo: AgentToolInfo = {
  name: "install_mcdreforged_plugin_dependencies",
  description: "使用 workspace/python 内置 Python 的 pip 安装 MCDReforged 插件启动日志或 requirements 文件明确声明的 PyPI 依赖；不使用系统 Python。",
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

  ctx.consoleLog?.(`下载 get-pip.py：${getPipUrl}`);
  await downloadFile(getPipUrl, getPipPath, ctx);
  await runPython([getPipPath, "--no-warn-script-location"], appConfig.pythonDir, ctx);
  await runPython(["-m", "pip", "--version"], appConfig.pythonDir, ctx);
}

async function installWindowsPython(ctx: AgentToolContext) {
  const tempDir = path.join(appConfig.workspaceRoot, "_python_install");
  const archivePath = path.join(tempDir, `python-${pythonVersion}-embed-amd64.zip`);
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

async function installLinuxPython(ctx: AgentToolContext) {
  const architecture = process.arch === "x64"
    ? "x86_64"
    : process.arch === "arm64"
      ? "aarch64"
      : null;
  if (!architecture) throw new Error(`Linux 内置 Python 仅支持 x64 和 arm64，当前架构为：${process.arch}`);

  const tempDir = path.join(appConfig.workspaceRoot, "_python_install");
  const archivePath = path.join(tempDir, `cpython-${pythonVersion}-${architecture}.tar.gz`);
  const extractRoot = path.join(tempDir, "extract");
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(extractRoot, { recursive: true });
  ctx.consoleLog?.(`下载内置 Python ${pythonVersion}：${linuxPythonArchiveUrl(architecture)}`);
  await downloadFile(linuxPythonArchiveUrl(architecture), archivePath, ctx);
  await extractTar({ file: archivePath, cwd: extractRoot });

  const extractedPythonDir = path.join(extractRoot, "python");
  if (!(await exists(path.join(extractedPythonDir, "bin", "python3")))) {
    throw new Error("内置 Python 解压结果不完整，未找到 python/bin/python3");
  }
  await rm(appConfig.pythonDir, { recursive: true, force: true });
  await mkdir(appConfig.pythonDir, { recursive: true });
  for (const entry of await readdir(extractedPythonDir)) {
    await rename(path.join(extractedPythonDir, entry), path.join(appConfig.pythonDir, entry));
  }
  await rm(tempDir, { recursive: true, force: true });
  return { bootstrapPython: `python-build-standalone-${pythonVersion}-${architecture}` };
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

function validatePackageSpec(packageSpec: string) {
  const normalized = packageSpec.trim();
  if (!normalized || normalized.length > 200 || normalized.startsWith("-") || /[\s@/:\\]/.test(normalized)) {
    throw new Error(`不安全或无效的 Python 包声明：${packageSpec}`);
  }
  return normalized;
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
          ? `Agent 准备下载独立 Python ${pythonVersion} 到应用工作区 ${appConfig.pythonDir}，安装 pip 与 MCDReforged；不会使用或修改系统 Python。`
          : `Agent 准备下载独立 Python ${pythonVersion} 到应用工作区 ${appConfig.pythonDir}，安装 pip 与 MCDReforged；不会使用或修改系统 Python。`,
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

export function createInstallMcdrPluginDependenciesTool(ctx: AgentToolContext): AgentTool {
  return {
    definition: {
      type: "function",
      function: {
        name: installMcdrPluginDependenciesToolInfo.name,
        description: installMcdrPluginDependenciesToolInfo.description,
        parameters: objectSchema({
          packages: {
            type: "array",
            items: { type: "string" },
            description: "需要安装的 PyPI 包名或带版本约束的包声明，例如 [\"ruamel.yaml\", \"requests>=2.31\"]。仅填写日志或 requirements 明确指出的依赖。"
          }
        }, ["packages"])
      }
    },
    execute: async (input) => {
      const packages = [...new Set(stringArrayInput(input, "packages").map(validatePackageSpec))];
      if (packages.length === 0) throw new Error("至少提供一个从插件日志或 requirements 文件确认的 Python 依赖");
      if (!(await exists(pythonExecutable()))) {
        throw new Error("内置 Python 不存在。请先调用 configure_builtin_python_environment，禁止使用系统 Python 安装插件依赖。");
      }

      await requireConfirmation(ctx, {
        title: "安装 MCDReforged 插件依赖",
        description: `Agent 准备通过应用内置 Python 的 pip 从 PyPI 安装：${packages.join(", ")}。仅影响 workspace/python，不使用系统 Python。`,
        risk: "medium"
      });
      await ensurePip(ctx);
      const output = await runPython(["-m", "pip", "install", ...packages], appConfig.pythonDir, ctx);
      return JSON.stringify({
        pythonPath: pythonExecutable(),
        packages,
        output: output.trim() || "依赖安装完成",
        systemPythonUsed: false
      }, null, 2);
    }
  };
}
