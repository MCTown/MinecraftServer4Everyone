import path from "node:path";
import { spawn } from "node:child_process";
import { access, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { fetch } from "undici";
import { appConfig } from "../config.js";
import { createDownloadHttpsFileToServerTool } from "./tools/downloadHttpsFileTool.js";
import { createInstallJavaVersionTool } from "./tools/javaDownloadTool.js";
import { booleanInput, installableCapabilities, isAbortError, objectSchema, requireConfirmation, safeDownloadName, stringArrayInput, stringInput, stringProperty, type AgentCapabilityId, type AgentTool, type AgentToolContext } from "./toolKit.js";
import { createId } from "../utils/id.js";
import type { AgentDownloadProgress } from "../types.js";
import { fetchDispatcher, isJavaExecutable, javaProxyArgs, proxyEnv } from "../services/proxySupport.js";

export type { AgentCapabilityId, AgentTool } from "./toolKit.js";

const workflowSteps = [
  { id: "identify_modpack", label: "确认整合包" },
  { id: "prepare_server_slot", label: "获取服务端包到槽位" },
  { id: "extract_to_workspace", label: "解压到工作空间" },
  { id: "direct_run_test", label: "直启验证" },
  { id: "configure_mcdr", label: "配置 MCDReforged" },
  { id: "final_mcdr_test", label: "最终验证" }
] as const;

type WorkflowStepId = typeof workflowSteps[number]["id"];

function isWorkflowStepId(value: string): value is WorkflowStepId {
  return workflowSteps.some((step) => step.id === value);
}

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function isAgentCapabilityId(value: string): value is AgentCapabilityId {
  return value in installableCapabilities;
}

function capabilityList() {
  return Object.entries(installableCapabilities)
    .map(([id, capability]) => `- ${id}: ${capability.description} 新增工具：${capability.tools.join(", ")}`)
    .join("\n");
}

function optionalStringChanges(input: Record<string, unknown>, keys: string[]) {
  const changes: Record<string, string> = {};
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string") changes[key] = value;
  }
  return changes;
}

async function fetchJson(url: string, signal?: AbortSignal, proxyUrl?: string) {
  const response = await fetch(url, { headers: { "user-agent": "MinecraftServerAgent/0.1" }, signal, dispatcher: fetchDispatcher(proxyUrl) });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Response is not JSON: ${text.slice(0, 300)}`);
  }
}

function javaArgsFilePath(minecraftVersion: string, forgeVersion: string) {
  return path.join(
    "libraries",
    "net",
    "minecraftforge",
    "forge",
    `${minecraftVersion}-${forgeVersion}`,
    process.platform === "win32" ? "win_args.txt" : "unix_args.txt"
  );
}

async function pathExists(targetPath: string) {
  return access(targetPath).then(() => true).catch(() => false);
}

async function runProcess(executable: string, args: string[], cwd: string, signal?: AbortSignal, onOutput?: (stream: "stdout" | "stderr", text: string) => void, proxyUrl?: string) {
  return new Promise<string>((resolve, reject) => {
    const effectiveArgs = isJavaExecutable(executable) ? [...javaProxyArgs(proxyUrl), ...args] : args;
    const child = spawn(executable, effectiveArgs, { cwd, env: proxyEnv(proxyUrl), shell: false, windowsHide: true });
    const chunks: string[] = [];
    let settled = false;
    const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString("utf8");
      chunks.push(text);
      onOutput?.(stream, text);
      while (chunks.join("").length > 12000) chunks.shift();
    };
    const finish = (error: Error | null, output = chunks.join("")) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
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
      finish(new Error(`进程执行超过 10 分钟，已终止。最近输出：\n${chunks.join("").slice(-3000)}`));
    }, 600_000);
    timeout.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", (error) => finish(error));
    child.on("exit", (code, exitSignal) => {
      const output = chunks.join("");
      if (code === 0) finish(null, output);
      else finish(new Error(`进程退出失败，code=${code ?? "null"} signal=${exitSignal ?? "null"}。最近输出：\n${output.slice(-3000)}`));
    });
  });
}

async function removeMatchingMods(serverDirectory: string, patterns: string[]) {
  const modsDirectory = path.join(serverDirectory, "mods");
  const entries = await readdir(modsDirectory, { withFileTypes: true }).catch(() => []);
  const normalizedPatterns = patterns.map((pattern) => pattern.toLowerCase()).filter(Boolean);
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const lowerName = entry.name.toLowerCase();
    if (!normalizedPatterns.some((pattern) => lowerName.includes(pattern))) continue;
    await rm(path.join(modsDirectory, entry.name), { force: true });
    removed.push(entry.name);
  }
  return removed;
}

async function promoteNestedModpackContent(serverDirectory: string, installerPath: string) {
  const installerDirectory = path.dirname(installerPath);
  if (!installerDirectory || installerDirectory === ".") return null;

  const sourceDirectory = path.resolve(serverDirectory, installerDirectory);
  const relativeSource = path.relative(serverDirectory, sourceDirectory);
  if (relativeSource.startsWith("..") || path.isAbsolute(relativeSource)) {
    throw new Error("Installer directory is outside of the server sandbox");
  }

  const entries = await readdir(sourceDirectory, { withFileTypes: true }).catch(() => []);
  const names = new Set(entries.map((entry) => entry.name.toLowerCase()));
  const hasModpackMarkers = names.has("mods") && (
    names.has("manifest.json") ||
    names.has("minecraftinstance.json") ||
    names.has("vh-setup.bat") ||
    names.has("vh-setup-unix.sh")
  );
  if (!hasModpackMarkers) return null;

  const installerName = path.basename(installerPath).toLowerCase();
  const moved: string[] = [];
  const skipped: string[] = [];
  for (const entry of entries) {
    if (entry.name.toLowerCase() === installerName) continue;
    const source = path.join(sourceDirectory, entry.name);
    const destination = path.join(serverDirectory, entry.name);
    if (await pathExists(destination)) {
      skipped.push(entry.name);
      continue;
    }
    await rename(source, destination);
    moved.push(entry.name);
  }
  return { from: installerDirectory, moved, skipped };
}

async function ensureForgeServerTextFiles(serverDirectory: string, modpackName: string, minecraftVersion: string, minMemory: string, maxMemory: string) {
  const createdOrUpdated: string[] = [];
  await writeFile(path.join(serverDirectory, "eula.txt"), "eula=true\n", "utf8");
  createdOrUpdated.push("eula.txt");

  const serverPropertiesPath = path.join(serverDirectory, "server.properties");
  const existingProperties = await readFile(serverPropertiesPath, "utf8").catch(() => "");
  const properties = new Map<string, string>();
  for (const line of existingProperties.split(/\r?\n/)) {
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) continue;
    properties.set(line.slice(0, separatorIndex), line.slice(separatorIndex + 1));
  }
  properties.set("allow-flight", "true");
  if (!properties.has("motd")) properties.set("motd", modpackName || `Forge ${minecraftVersion}`);
  if (!properties.has("level-type")) properties.set("level-type", "default");
  await writeFile(serverPropertiesPath, [...properties.entries()].map(([key, value]) => `${key}=${value}`).join("\n") + "\n", "utf8");
  createdOrUpdated.push("server.properties");

  await writeFile(path.join(serverDirectory, "user_jvm_args.txt"), `${minMemory ? `-Xms${minMemory}\n` : ""}${maxMemory ? `-Xmx${maxMemory}\n` : ""}`, "utf8");
  createdOrUpdated.push("user_jvm_args.txt");
  return createdOrUpdated;
}

export function createAgentTools(ctx: AgentToolContext): AgentTool[] {
  const capabilityNames = Object.keys(installableCapabilities).join(", ");
  const tools: AgentTool[] = [
    {
      definition: {
        type: "function",
        function: {
          name: "update_agent_workflow_progress",
          description: "更新前端展示的整合包部署工作流进度。开始、完成或失败每个阶段时必须调用。",
          parameters: objectSchema({
            stepId: { type: "string", enum: workflowSteps.map((step) => step.id) },
            status: { type: "string", enum: ["pending", "running", "completed", "failed"] },
            progress: { type: "number" },
            detail: stringProperty,
            title: stringProperty
          }, ["stepId", "status"])
        }
      },
      execute: async (input) => {
        const stepId = stringInput(input, "stepId");
        if (!isWorkflowStepId(stepId)) throw new Error(`Unknown workflow step: ${stepId}`);
        const rawStatus = stringInput(input, "status");
        if (!["pending", "running", "completed", "failed"].includes(rawStatus)) throw new Error(`Unknown workflow status: ${rawStatus}`);
        const status = rawStatus as "pending" | "running" | "completed" | "failed";
        const progress = clampPercent(typeof input.progress === "number" ? input.progress : 0);
        const detail = stringInput(input, "detail");
        const stepIndex = workflowSteps.findIndex((step) => step.id === stepId);
        const steps = workflowSteps.map((step, index) => ({
          ...step,
          status: index < stepIndex ? "completed" as const : index === stepIndex ? status : "pending" as const,
          progress: index < stepIndex ? 100 : index === stepIndex ? progress : 0,
          detail: index === stepIndex ? detail : ""
        }));
        const isFinalComplete = status === "completed" && stepIndex === workflowSteps.length - 1;
        ctx.workflowProgress?.({
          title: stringInput(input, "title", "整合包服务端部署流程"),
          currentStepId: stepId,
          overallProgress: isFinalComplete ? 100 : clampPercent((stepIndex / workflowSteps.length) * 100 + progress / workflowSteps.length),
          status,
          steps
        });
        return `已更新工作流进度：${stepId} ${status} ${progress}%`;
      }
    },
    {
      definition: {
        type: "function",
        function: {
          name: "get_server_slot_status",
          description: "查看当前服务端的独立槽位状态。槽位用于保存玩家提供或 Agent 下载的原始服务端包，前端会展示该槽位是否被占用。",
          parameters: objectSchema({})
        }
      },
      execute: async () => {
        const status = await ctx.fileService.getServerSlotStatus(ctx.serverId);
        ctx.serverSlotStatus?.(status);
        return JSON.stringify(status, null, 2);
      }
    },
    {
      definition: {
        type: "function",
        function: {
          name: "save_upload_to_server_slot",
          description: "将玩家上传给 Agent 的临时文件保存到当前服务端的独立槽位。会清空当前服务端旧槽位内容，只保留这一个服务端包。",
          parameters: objectSchema({ uploadId: stringProperty }, ["uploadId"])
        }
      },
      execute: async (input) => {
        const upload = ctx.uploadService.requireSessionUpload(ctx.serverId, stringInput(input, "uploadId"));
        await requireConfirmation(ctx, {
          title: "保存上传文件到服务端槽位",
          description: `Agent 准备清空当前服务端旧槽位，并把上传文件 ${upload.originalName} 保存为当前服务端槽位内容。`,
          risk: "medium"
        });
        const status = await ctx.fileService.copyIntoServerSlot(ctx.serverId, upload.storedPath, upload.originalName);
        ctx.serverSlotStatus?.(status);
        return JSON.stringify(status, null, 2);
      }
    },
    {
      definition: {
        type: "function",
        function: {
          name: "download_https_file_to_server_slot",
          description: "从 HTTPS URL 下载服务端包到当前服务端的独立槽位。会清空当前服务端旧槽位内容，只保留下载结果；用于玩家给出服务端包下载链接时。",
          parameters: objectSchema({ url: stringProperty }, ["url"])
        }
      },
      execute: async (input) => {
        const url = stringInput(input, "url");
        const downloadId = createId("download");
        const fileName = safeDownloadName(url, "server-package.bin");
        const destinationPath = "server_slots/current";
        const emitProgress = (progress: Omit<AgentDownloadProgress, "id" | "url" | "fileName" | "destinationPath">) => {
          ctx.progress?.({ id: downloadId, url, fileName, destinationPath, ...progress });
        };
        await requireConfirmation(ctx, {
          title: "下载服务端包到槽位",
          description: `Agent 准备清空当前服务端旧槽位，并从 ${url} 下载服务端包到当前服务端槽位。`,
          risk: "high"
        });
        emitProgress({ loadedBytes: 0, totalBytes: null, percent: 0, status: "starting" });
        try {
          const status = await ctx.fileService.downloadIntoServerSlot(ctx.serverId, url, {
            signal: ctx.signal,
            proxyUrl: ctx.downloadProxyUrl?.(),
            onProgress: (progress) => emitProgress({ ...progress, status: progress.percent >= 100 ? "completed" : "downloading" })
          });
          ctx.serverSlotStatus?.(status);
          return JSON.stringify(status, null, 2);
        } catch (error) {
          emitProgress({
            loadedBytes: 0,
            totalBytes: null,
            percent: 0,
            status: isAbortError(error) ? "cancelled" : "failed",
            error: error instanceof Error ? error.message : String(error)
          });
          throw error;
        }
      }
    },
    {
      definition: {
        type: "function",
        function: {
          name: "extract_server_slot_to_workspace",
          description: "将服务端槽位中的 zip 服务端包解压到当前服务端工作目录。用于槽位保存完成后进入工作空间验证。",
          parameters: objectSchema({ destinationPath: stringProperty })
        }
      },
      execute: async (input) => {
        const destinationPath = stringInput(input, "destinationPath", ".");
        await requireConfirmation(ctx, {
          title: "解压服务端槽位到工作空间",
          description: `Agent 准备将服务端槽位中的 zip 解压到当前服务端目录 ${destinationPath}。`,
          risk: "medium"
        });
        const result = await ctx.fileService.extractServerSlotIntoServer(ctx.serverId, destinationPath, {
          onProgress: (progress) => ctx.workflowProgress?.({
            title: "整合包服务端部署流程",
            currentStepId: "extract_to_workspace",
            overallProgress: clampPercent(200 / 6 + progress.percent / 6),
            status: progress.percent >= 100 ? "completed" : "running",
            steps: workflowSteps.map((step, index) => ({
              ...step,
              status: index < 2 ? "completed" : index === 2 ? progress.percent >= 100 ? "completed" : "running" : "pending",
              progress: index < 2 ? 100 : index === 2 ? progress.percent : 0,
              detail: index === 2 ? `正在解压：${progress.currentEntry}` : ""
            }))
          })
        });
        return JSON.stringify(result, null, 2);
      }
    },
    {
      definition: {
        type: "function",
        function: {
          name: "install_agent_capability",
          description: `当当前工具集缺少完成任务所需的能力时，安装/启用一个内置受控能力包。只能安装已内置能力，不能执行任意系统命令或安装任意软件。当前可安装：${capabilityNames}。`,
          parameters: objectSchema({ capability: { type: "string", enum: Object.keys(installableCapabilities) } }, ["capability"])
        }
      },
      execute: async (input) => {
        const capability = stringInput(input, "capability");
        if (!isAgentCapabilityId(capability)) {
          return `未找到内置能力：${capability || "未指定"}\n可安装能力：\n${capabilityList()}`;
        }
        ctx.installCapability?.(capability);
        const installed = installableCapabilities[capability];
        return [
          `已安装并启用内置能力：${capability}（${installed.name}）`,
          installed.description,
          `新增工具：${installed.tools.join(", ")}`,
          "请在下一步直接调用新增工具继续完成任务。"
        ].join("\n");
      }
    },
    {
      definition: {
        type: "function",
        function: {
          name: "update_current_server_config",
          description: "更新当前服务端 Java 路径、内存、Jar、启动参数、Minecraft 版本和整合包名称。",
          parameters: objectSchema({
            javaPath: stringProperty,
            javaVersion: stringProperty,
            minMemory: stringProperty,
            maxMemory: stringProperty,
            jarFile: stringProperty,
            startArgs: stringProperty,
            minecraftVersion: stringProperty,
            modpackName: stringProperty
          })
        }
      },
      execute: async (input) => {
        const changes = optionalStringChanges(input, ["javaPath", "javaVersion", "minMemory", "maxMemory", "jarFile", "startArgs", "minecraftVersion", "modpackName"]);
        await requireConfirmation(ctx, {
          title: "修改当前服务端配置",
          description: `Agent 准备修改当前服务端配置：${JSON.stringify(changes)}`,
          risk: "medium"
        });
        const server = await ctx.serverService.updateServer(ctx.serverId, changes);
        return JSON.stringify(server, null, 2);
      }
    },
    {
      definition: {
        type: "function",
        function: {
          name: "list_server_files",
          description: "列出当前服务端目录内的文件和文件夹。只能访问服务端沙箱目录。",
          parameters: objectSchema({ path: stringProperty })
        }
      },
      execute: async (input) => JSON.stringify(await ctx.fileService.list(ctx.serverId, stringInput(input, "path", ".")), null, 2)
    },
    {
      definition: {
        type: "function",
        function: {
          name: "read_server_text_file",
          description: "读取当前服务端目录内的文本文件，包括配置、日志、CSV、TSV、脚本和常见数据文本。",
          parameters: objectSchema({ path: stringProperty }, ["path"])
        }
      },
      execute: async (input) => ctx.fileService.readText(ctx.serverId, stringInput(input, "path"))
    },
    {
      definition: {
        type: "function",
        function: {
          name: "write_server_text_file",
          description: "写入当前服务端目录内的文本配置或数据文件。",
          parameters: objectSchema({ path: stringProperty, content: stringProperty }, ["path", "content"])
        }
      },
      execute: async (input) => {
        const targetPath = stringInput(input, "path");
        await ctx.fileService.writeText(ctx.serverId, targetPath, stringInput(input, "content"));
        return `已写入 ${targetPath}`;
      }
    },
    {
      definition: {
        type: "function",
        function: {
          name: "initialize_server_template",
          description: "将内置 default 模板或从 D:\\Desktop\\1 (1) 导入的 reference 模板复制到当前服务端目录。",
          parameters: objectSchema({ template: { type: "string", enum: ["default", "reference"] } })
        }
      },
      execute: async (input) => {
        const template = stringInput(input, "template", "default");
        if (template === "reference") {
          await requireConfirmation(ctx, {
            title: "使用外部参考模板",
            description: "Agent 准备从应用工作区中的 reference 模板复制文件到当前服务端目录。该模板来源于固定外部路径 D:\\Desktop\\1 (1)。",
            risk: "medium"
          });
        }
        const templateDir = path.join(appConfig.templatesDir, template);
        for (const file of ["eula.txt", "server.properties", "user_jvm_args.txt", "README_AGENT.txt"]) {
          await ctx.fileService.copyIntoServer(ctx.serverId, path.join(templateDir, file), file).catch(() => undefined);
        }
        return `已根据 ${template} 模板初始化服务端目录。`;
      }
    },
    {
      definition: {
        type: "function",
        function: {
          name: "list_uploaded_files",
          description: "列出用户上传给当前 Agent 会话的临时文件，包括 uploadId、原文件名、大小和过期时间。部署整合包前应先检查是否已有上传文件。",
          parameters: objectSchema({})
        }
      },
      execute: async () => JSON.stringify(ctx.uploadService.list(ctx.serverId), null, 2)
    },
    {
      definition: {
        type: "function",
        function: {
          name: "move_upload_to_server",
          description: "将临时上传文件复制或解压到当前服务端目录。",
          parameters: objectSchema({ uploadId: stringProperty, destinationPath: stringProperty, extract: { type: "boolean" } }, ["uploadId"])
        }
      },
      execute: async (input) => {
        const upload = ctx.uploadService.requireSessionUpload(ctx.serverId, stringInput(input, "uploadId"));
        const destinationPath = stringInput(input, "destinationPath", ".");
        await requireConfirmation(ctx, {
          title: "移动上传文件到服务端目录",
          description: `Agent 准备将上传文件 ${upload.originalName} ${booleanInput(input, "extract") ? "解压" : "复制"}到 ${destinationPath}。`,
          risk: "medium"
        });
        if (booleanInput(input, "extract") && upload.originalName.toLowerCase().endsWith(".zip")) {
          await ctx.fileService.extractZipIntoServer(ctx.serverId, upload.storedPath, destinationPath);
          return `已解压 ${upload.originalName} 到 ${destinationPath}`;
        }
        await ctx.fileService.copyIntoServer(ctx.serverId, upload.storedPath, path.join(destinationPath, upload.originalName));
        return `已移动 ${upload.originalName} 到 ${destinationPath}`;
      }
    },
    {
      definition: {
        type: "function",
        function: {
          name: "check_java_environment",
          description: "根据 Minecraft 版本推荐 Java 版本，并列出 workspace/jdks 内已安装 Java。",
          parameters: objectSchema({ minecraftVersion: stringProperty })
        }
      },
      execute: async (input) => JSON.stringify({
        recommended: ctx.javaService.recommendVersion(stringInput(input, "minecraftVersion") || undefined),
        installed: await ctx.javaService.listInstalled()
      }, null, 2)
    },
    createInstallJavaVersionTool(ctx),
    {
      definition: {
        type: "function",
        function: {
          name: "start_current_server",
          description: "启动当前服务端。后端会强制保证同一时间只能运行一个服务端；启动时优先执行服务端自带 run/start/server/launch 脚本，缺失时才按当前配置生成 start-agent 脚本，并会按推荐内存写入 JVM 内存参数。",
          parameters: objectSchema({})
        }
      },
      execute: async () => JSON.stringify(await ctx.processManager.start(ctx.serverId))
    },
    {
      definition: {
        type: "function",
        function: {
          name: "stop_current_server",
          description: "向当前服务端发送 stop 指令。",
          parameters: objectSchema({})
        }
      },
      execute: async () => JSON.stringify(await ctx.processManager.stop(ctx.serverId))
    },
    {
      definition: {
        type: "function",
        function: {
          name: "search_modrinth_modpacks",
          description: "联网搜索 Modrinth 整合包项目，返回项目 slug、标题、描述、客户端/服务端支持情况和链接。用于根据用户输入确定整合包来源。",
          parameters: objectSchema({ query: stringProperty }, ["query"])
        }
      },
      execute: async (input) => {
        const query = stringInput(input, "query");
        const url = new URL("https://api.modrinth.com/v2/search");
        url.searchParams.set("query", query);
        url.searchParams.set("facets", JSON.stringify([["project_type:modpack"]]));
        url.searchParams.set("limit", "8");
        const data = await fetchJson(url.toString(), ctx.signal, ctx.downloadProxyUrl?.());
        return JSON.stringify(data, null, 2);
      }
    },
    {
      definition: {
        type: "function",
        function: {
          name: "list_modrinth_modpack_versions",
          description: "根据 Modrinth project_id 或 slug 列出整合包版本和可下载文件，用于寻找服务端包或 mrpack 文件。",
          parameters: objectSchema({ projectIdOrSlug: stringProperty }, ["projectIdOrSlug"])
        }
      },
      execute: async (input) => {
        const projectIdOrSlug = encodeURIComponent(stringInput(input, "projectIdOrSlug"));
        const data = await fetchJson(`https://api.modrinth.com/v2/project/${projectIdOrSlug}/version`, ctx.signal, ctx.downloadProxyUrl?.());
        return JSON.stringify(data, null, 2);
      }
    },
    {
      definition: {
        type: "function",
        function: {
          name: "fetch_https_resource_summary",
          description: "读取 HTTPS URL 的文本或 JSON 内容摘要，可用于检查 CurseForge/Modrinth 页面、manifest 或版本元数据。最多返回前 6000 字符。",
          parameters: objectSchema({ url: stringProperty }, ["url"])
        }
      },
      execute: async (input) => {
        const url = new URL(stringInput(input, "url"));
        if (url.protocol !== "https:") throw new Error("Only HTTPS URLs are allowed");
        const response = await fetch(url, { headers: { "user-agent": "MinecraftServerAgent/0.1" }, signal: ctx.signal, dispatcher: fetchDispatcher(ctx.downloadProxyUrl?.()) });
        const text = await response.text();
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 300)}`);
        return text.slice(0, 6000);
      }
    },
    createDownloadHttpsFileToServerTool(ctx),
    {
      definition: {
        type: "function",
        function: {
          name: "summarize_modpack_deployment_info",
          description: "整理整合包部署信息检查清单，用于在无法联网或信息不足时引导用户补充关键资料。",
          parameters: objectSchema({ modpackName: stringProperty, modpackVersion: stringProperty }, ["modpackName"])
        }
      },
      execute: async (input) => {
        const modpackName = stringInput(input, "modpackName");
        const modpackVersion = stringInput(input, "modpackVersion");
        return [
          `整合包：${modpackName}${modpackVersion ? ` ${modpackVersion}` : ""}`,
          "需要确认的信息：部署方式、Minecraft 版本、Loader 类型、Java 版本、服务端包下载来源、启动 Jar 或脚本、常见报错。",
          "如果已上传整合包文件，请先读取文件名和目录结构；如果没有，请向用户索要整合包来源或版本。",
          "Java 粗略规则：1.16 及以下通常 Java 8，1.17 通常 Java 16，1.18-1.20.4 通常 Java 17，1.20.5+ 通常 Java 21。"
        ].join("\n");
      }
    }
  ];

  if (ctx.installedCapabilities?.has("zip_extract")) {
    tools.push({
      definition: {
        type: "function",
        function: {
          name: "extract_server_zip",
          description: "解压当前服务端目录内已经存在的 .zip 文件到服务端目录内的指定位置。只能访问当前服务端沙箱目录。",
          parameters: objectSchema({ zipPath: stringProperty, destinationPath: stringProperty }, ["zipPath"])
        }
      },
      execute: async (input) => {
        const zipPath = stringInput(input, "zipPath");
        if (!zipPath.toLowerCase().endsWith(".zip")) throw new Error("Only .zip files can be extracted");
        const destinationPath = stringInput(input, "destinationPath", ".");
        const zip = await ctx.fileService.resolveDownload(ctx.serverId, zipPath);
        await requireConfirmation(ctx, {
          title: "解压服务端内 ZIP 文件",
          description: `Agent 准备将当前服务端目录内的 ${zip.fileName} 解压到 ${destinationPath}。`,
          risk: "medium"
        });
        await ctx.fileService.extractZipIntoServer(ctx.serverId, zip.absolutePath, destinationPath);
        return `已解压 ${zipPath} 到 ${destinationPath}`;
      }
    });
  }

  if (ctx.installedCapabilities?.has("forge_server_setup")) {
    tools.push({
      definition: {
        type: "function",
        function: {
          name: "setup_forge_server",
          description: "在当前服务端沙箱内运行 Forge installer -installServer，验证生成的 Forge args 文件，并写入当前服务端可启动配置。适用于 Forge 1.17+ 的 libraries/.../win_args.txt 或 unix_args.txt 启动方式。若 installer 位于已解压整合包子目录中，本工具会把 mods/config/defaultconfigs 等整合包内容提升到服务端根目录，并写入 eula.txt、server.properties、user_jvm_args.txt；minMemory/maxMemory 应优先使用上下文里的推荐内存，整合包有明确要求时可以调整但不能超过推荐内存，并向用户说明；成功后通常无需再初始化模板或重复写基础配置。",
          parameters: objectSchema({
            minecraftVersion: stringProperty,
            forgeVersion: stringProperty,
            installerPath: stringProperty,
            javaPath: stringProperty,
            minMemory: stringProperty,
            maxMemory: stringProperty,
            modpackName: stringProperty,
            removeClientSideModPatterns: { type: "array", items: stringProperty }
          }, ["minecraftVersion", "forgeVersion", "installerPath", "javaPath"])
        }
      },
      execute: async (input) => {
        const minecraftVersion = stringInput(input, "minecraftVersion");
        const forgeVersion = stringInput(input, "forgeVersion");
        const installerPath = stringInput(input, "installerPath");
        const javaPath = stringInput(input, "javaPath");
        const minMemory = stringInput(input, "minMemory", "1G");
        const maxMemory = stringInput(input, "maxMemory", "4G");
        const modpackName = stringInput(input, "modpackName");
        if (!installerPath.toLowerCase().endsWith(".jar")) throw new Error("Forge installer must be a .jar file");
        if (!minecraftVersion || !forgeVersion || !javaPath) {
          throw new Error("minecraftVersion、forgeVersion、javaPath 都必须提供");
        }

        const server = await ctx.serverService.requireServer(ctx.serverId);
        const installer = await ctx.fileService.resolveDownload(ctx.serverId, installerPath);
        await access(javaPath).catch(() => {
          throw new Error(`Java executable not found: ${javaPath}`);
        });
        const argsPath = javaArgsFilePath(minecraftVersion, forgeVersion);
        await requireConfirmation(ctx, {
          title: "运行 Forge 服务端安装器",
          description: `Agent 准备在当前服务端目录内运行 ${installer.fileName} -installServer，并将启动配置设置为 @${argsPath} nogui。`,
          risk: "high"
        });

        ctx.consoleLog?.(`运行 Forge installer：${javaPath} -jar ${installer.absolutePath} -installServer`);
        const output = await runProcess(
          javaPath,
          ["-jar", installer.absolutePath, "-installServer"],
          server.directory,
          ctx.signal,
          (stream, text) => ctx.consoleLog?.(text, stream),
          ctx.downloadProxyUrl?.()
        );
        const absoluteArgsPath = path.join(server.directory, argsPath);
        if (!(await pathExists(absoluteArgsPath))) {
          throw new Error(`Forge installer did not create expected args file: ${argsPath}\n最近输出：\n${output.slice(-3000)}`);
        }
        const promotedContent = await promoteNestedModpackContent(server.directory, installerPath);
        const configuredTextFiles = await ensureForgeServerTextFiles(server.directory, modpackName, minecraftVersion, minMemory, maxMemory);
        const removedMods = await removeMatchingMods(server.directory, stringArrayInput(input, "removeClientSideModPatterns"));
        const updated = await ctx.serverService.updateServer(ctx.serverId, {
          javaPath,
          javaVersion: ctx.javaService.recommendVersion(minecraftVersion),
          minMemory,
          maxMemory,
          jarFile: "",
          startArgs: `@${argsPath.replace(/\\/g, "/")} nogui`,
          minecraftVersion,
          modpackName: modpackName || `Forge ${minecraftVersion}-${forgeVersion}`,
          serverType: "forge"
        });
        return JSON.stringify({
          ok: true,
          argsPath,
          promotedContent,
          configuredTextFiles,
          removedClientSideMods: removedMods,
          outputTail: output.slice(-3000),
          server: updated
        }, null, 2);
      }
    });
  }

  return tools;
}
