import { access, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createId } from "../../utils/id.js";
import { fetchDispatcher } from "../../services/proxySupport.js";
import { javaProxyArgs, proxyEnv } from "../../services/proxySupport.js";
import type { MrpackFile, MrpackSlotInfo } from "../../services/fileService.js";
import { fetch } from "undici";
import { booleanInput, isAbortError, objectSchema, requireConfirmation, stringInput, stringProperty, type AgentTool, type AgentToolContext, type AgentToolInfo } from "../toolKit.js";
import type { AgentDownloadProgress } from "../../types.js";

export const deployMrpackServerToolInfo: AgentToolInfo = {
  name: "deploy_mrpack_server_from_server_slot",
  description: "将当前服务端槽位中的 Modrinth .mrpack 转换为可执行 Minecraft 服务端：读取 modrinth.index.json，仅下载 server required 文件并校验哈希，合并 overrides，按包内 Loader 依赖下载/安装服务端启动文件，写入 eula 与服务端配置。不会启动服务端。",
  category: "整合包部署",
  controllable: false
};

export const inspectMrpackServerToolInfo: AgentToolInfo = {
  name: "inspect_mrpack_server_slot",
  description: "读取当前服务端槽位中的 Modrinth .mrpack 清单，返回 Minecraft、Loader、服务端文件与 overrides 摘要，不会下载、写入或启动服务端。",
  category: "整合包部署",
  controllable: false
};

function loaderInfo(info: MrpackSlotInfo) {
  const dependencies = info.dependencies;
  const loader = Object.keys(dependencies).find((key) => ["fabric-loader", "quilt-loader", "neoforge", "forge"].includes(key.toLowerCase()));
  if (!loader) return { type: "vanilla" as const, version: "" };
  const type = loader.toLowerCase().split("-")[0];
  return { type: type === "fabric" || type === "quilt" || type === "neoforge" || type === "forge" ? type : "vanilla", version: dependencies[loader] ?? "" };
}

function safeFilePath(file: MrpackFile) {
  const normalized = file.path.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..") || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`mrpack 文件路径不安全：${file.path}`);
  }
  return normalized;
}

function fileIsServerIncluded(file: MrpackFile) {
  return file.env.server === "required" || file.env.server === "optional";
}

async function pathExists(target: string) {
  return access(target).then(() => true).catch(() => false);
}

function serverPath(filePath: string) {
  const normalized = filePath.replaceAll("\\", "/");
  return normalized.startsWith("server/") ? normalized.slice("server/".length) : normalized;
}

async function resolveLoaderInstallerUrl(ctx: AgentToolContext, info: MrpackSlotInfo, loader: ReturnType<typeof loaderInfo>) {
  const minecraft = encodeURIComponent(info.minecraftVersion);
  const loaderVersion = encodeURIComponent(loader.version);
  if (loader.type === "fabric") {
    const versions = await fetchJson(ctx, "https://meta.fabricmc.net/v2/versions/installer");
    const list = Array.isArray(versions) ? versions : [];
    const stable = list.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).stable === true) as Record<string, unknown> | undefined;
    const first = list.find((item) => item && typeof item === "object") as Record<string, unknown> | undefined;
    const installerVersion = typeof stable?.version === "string" ? stable.version : typeof first?.version === "string" ? first.version : "1.0.1";
    return `https://meta.fabricmc.net/v2/versions/loader/${minecraft}/${loaderVersion}/${encodeURIComponent(installerVersion)}/server/jar`;
  }
  if (loader.type === "quilt") {
    const versions = await fetchJson(ctx, "https://meta.quiltmc.org/v3/versions/installer");
    const list = Array.isArray(versions) ? versions : [];
    const first = list.find((item) => item && typeof item === "object") as Record<string, unknown> | undefined;
    const installerVersion = typeof first?.version === "string" ? first.version : "0.9.1";
    return `https://meta.quiltmc.org/v3/versions/loader/${minecraft}/${loaderVersion}/${encodeURIComponent(installerVersion)}/server/jar`;
  }
  if (loader.type === "neoforge") {
    return `https://maven.neoforged.net/releases/net/neoforged/neoforge/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`;
  }
  if (loader.type === "forge") {
    const coordinate = `${info.minecraftVersion}-${loader.version}`;
    return `https://maven.minecraftforge.net/net/minecraftforge/forge/${encodeURIComponent(coordinate)}/forge-${encodeURIComponent(coordinate)}-installer.jar`;
  }
  return "";
}

function forgeArgsPath(info: MrpackSlotInfo, loader: ReturnType<typeof loaderInfo>) {
  if (loader.type === "forge") {
    return path.join("libraries", "net", "minecraftforge", "forge", `${info.minecraftVersion}-${loader.version}`, process.platform === "win32" ? "win_args.txt" : "unix_args.txt");
  }
  if (loader.type === "neoforge") {
    return path.join("libraries", "net", "neoforged", "neoforge", loader.version, process.platform === "win32" ? "win_args.txt" : "unix_args.txt");
  }
  return "";
}

async function downloadFile(ctx: AgentToolContext, url: string, destinationPath: string, hashes: Record<string, string>, fileSize: number | null, label: string) {
  const downloadId = createId("download");
  const emit = (progress: Omit<AgentDownloadProgress, "id" | "url" | "fileName" | "destinationPath">) => {
    ctx.progress?.({ id: downloadId, url, fileName: path.basename(destinationPath), destinationPath, ...progress });
  };
  emit({ loadedBytes: 0, totalBytes: fileSize, percent: 0, status: "starting" });
  try {
    const saved = await ctx.fileService.downloadVerifiedIntoServer(ctx.serverId, url, destinationPath, {
      expectedHashes: hashes,
      expectedSize: fileSize,
      signal: ctx.signal,
      proxyUrl: ctx.downloadProxyUrl?.(),
      onProgress: (progress) => emit({ ...progress, status: progress.percent >= 100 ? "completed" : "downloading" })
    });
    return saved;
  } catch (error) {
    emit({ loadedBytes: 0, totalBytes: fileSize, percent: 0, status: isAbortError(error) ? "cancelled" : "failed", error: error instanceof Error ? error.message : String(error) });
    throw new Error(`${label} 下载失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function fetchBinary(ctx: AgentToolContext, url: string) {
  const response = await fetch(url, { headers: { "user-agent": "MinecraftServerAgent/0.1" }, signal: ctx.signal, dispatcher: fetchDispatcher(ctx.downloadProxyUrl?.()) });
  if (!response.ok || !response.body) throw new Error(`Loader 下载失败：HTTP ${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}

async function fetchJson(ctx: AgentToolContext, url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { "user-agent": "MinecraftServerAgent/0.1" }, signal: ctx.signal, dispatcher: fetchDispatcher(ctx.downloadProxyUrl?.()) });
  const text = await response.text();
  if (!response.ok) throw new Error(`Minecraft 元数据请求失败：HTTP ${response.status} ${response.statusText}`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Minecraft 元数据不是有效 JSON");
  }
}

async function downloadVanillaServer(ctx: AgentToolContext, info: MrpackSlotInfo) {
  const manifest = await fetchJson(ctx, "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json") as Record<string, unknown>;
  const versions = Array.isArray(manifest.versions) ? manifest.versions : [];
  const version = versions.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).id === info.minecraftVersion) as Record<string, unknown> | undefined;
  const metadataUrl = typeof version?.url === "string" ? version.url : "";
  if (!metadataUrl) throw new Error(`Mojang 未找到 Minecraft ${info.minecraftVersion} 的版本元数据`);
  const metadata = await fetchJson(ctx, metadataUrl) as Record<string, unknown>;
  const server = metadata.downloads && typeof metadata.downloads === "object" && !Array.isArray(metadata.downloads)
    ? (metadata.downloads as Record<string, unknown>).server
    : null;
  if (!server || typeof server !== "object" || Array.isArray(server)) throw new Error(`Minecraft ${info.minecraftVersion} 没有公开 server.jar 下载信息`);
  const serverRecord = server as Record<string, unknown>;
  const url = typeof serverRecord.url === "string" ? serverRecord.url : "";
  const sha1 = typeof serverRecord.sha1 === "string" ? serverRecord.sha1 : "";
  const size = typeof serverRecord.size === "number" ? serverRecord.size : null;
  if (!url || !sha1) throw new Error(`Minecraft ${info.minecraftVersion} 的 server.jar 缺少下载校验信息`);
  return downloadFile(ctx, url, "server/server.jar", { sha1 }, size, `Minecraft ${info.minecraftVersion} server.jar`);
}

async function writeLoader(ctx: AgentToolContext, info: MrpackSlotInfo, loader: ReturnType<typeof loaderInfo>, javaPath: string, overwrite: boolean) {
  const server = await ctx.serverService.requireServer(ctx.serverId);
  if (loader.type === "vanilla") {
    const serverJar = path.join(server.directory, "server", "server.jar");
    const installedFiles = !overwrite && await pathExists(serverJar) ? [] : [await downloadVanillaServer(ctx, info)];
    await mkdir(path.dirname(serverJar), { recursive: true });
    await writeFile(path.join(server.directory, "server", "eula.txt"), "eula=true\n", "utf8");
    return { type: loader.type, version: loader.version, startArgs: "nogui", installedFiles, installerUrl: null };
  }

  const loaderUrl = await resolveLoaderInstallerUrl(ctx, info, loader);
  if (!loaderUrl) throw new Error(`无法解析 Loader 安装地址：${loader.type} ${loader.version}`);

  if (loader.type === "fabric" || loader.type === "quilt") {
    const jarPath = path.join("server", "server.jar");
    const target = path.join(server.directory, jarPath);
    if (!overwrite && await pathExists(target)) throw new Error(`目标文件已存在，拒绝覆盖：${jarPath}`);
    const blob = await fetchBinary(ctx, loaderUrl);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, blob, { flag: overwrite ? "w" : "wx" });
    await writeFile(path.join(server.directory, "server", "eula.txt"), "eula=true\n", "utf8");
    return { type: loader.type, version: loader.version, startArgs: "nogui", installedFiles: [jarPath], installerUrl: loaderUrl };
  }

  const installerPath = path.join("server", `${loader.type}-${info.minecraftVersion}-${loader.version}-installer.jar`);
  if (!overwrite && await pathExists(path.join(server.directory, installerPath))) {
    throw new Error(`Loader 安装器已存在，默认拒绝覆盖：${installerPath}`);
  }
  const installer = await ctx.fileService.downloadIntoServer(ctx.serverId, loaderUrl, installerPath, {
    signal: ctx.signal,
    proxyUrl: ctx.downloadProxyUrl?.()
  });
  const installRoot = path.join(server.directory, "server");
  await mkdir(installRoot, { recursive: true });
  const installerAbsolute = path.join(server.directory, installerPath);
  const java = javaPath || "java";
  const installFlag = loader.type === "forge" ? "-installServer" : "--installServer";
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(java, [
      ...javaProxyArgs(ctx.downloadProxyUrl?.()),
      "-jar",
      installerAbsolute,
      installFlag
    ], { cwd: installRoot, env: proxyEnv(ctx.downloadProxyUrl?.()), shell: false, windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); ctx.consoleLog?.(chunk.toString(), "stdout"); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); ctx.consoleLog?.(chunk.toString(), "stderr"); });
    const onAbort = () => {
      child.kill("SIGKILL");
      const error = new Error("Agent 操作已中断");
      error.name = "AbortError";
      reject(error);
    };
    ctx.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => {
      ctx.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("exit", (code) => {
      ctx.signal?.removeEventListener("abort", onAbort);
      code === 0 ? resolve() : reject(new Error(`${loader.type} installer 失败（${code ?? "unknown"}）：${output.slice(-2000)}`));
    });
  });
  const argsPath = forgeArgsPath(info, loader).replaceAll("\\", "/");
  if (!(await pathExists(path.join(installRoot, argsPath)))) throw new Error(`${loader.type} installer 未生成预期启动参数文件：${argsPath}`);
  await writeFile(path.join(installRoot, "eula.txt"), "eula=true\n", "utf8");
  return { type: loader.type, version: loader.version, startArgs: `@${argsPath} nogui`, installedFiles: [installer, `server/${argsPath}`], installerUrl: loaderUrl };
}

function summary(info: MrpackSlotInfo) {
  return {
    name: info.name,
    versionId: info.versionId,
    minecraftVersion: info.minecraftVersion,
    dependencies: info.dependencies,
    serverIncludedFileCount: info.files.filter(fileIsServerIncluded).length,
    serverRequiredFileCount: info.files.filter((file) => file.env.server === "required").length,
    serverOptionalFileCount: info.files.filter((file) => file.env.server === "optional").length,
    clientOnlyFileCount: info.files.filter((file) => file.env.server === "unsupported").length,
    overrideDirectories: info.overrideDirectories,
    slotFileName: info.slot.fileName
  };
}

export function createDeployMrpackServerTool(ctx: AgentToolContext): AgentTool {
  return {
    definition: {
      type: "function",
      function: {
        name: deployMrpackServerToolInfo.name,
        description: deployMrpackServerToolInfo.description,
        parameters: objectSchema({ javaPath: stringProperty, overwrite: { type: "boolean" } })
      }
    },
    execute: async (input) => {
      const info = await ctx.fileService.inspectMrpackServerSlot(ctx.serverId);
      const includedFiles = info.files.filter(fileIsServerIncluded);
      const loader = loaderInfo(info);
      const javaPath = stringInput(input, "javaPath");
      const overwrite = booleanInput(input, "overwrite");
      const server = await ctx.serverService.requireServer(ctx.serverId);
      const destinationPaths = includedFiles.map((file) => path.join("server", serverPath(safeFilePath(file))));
      const conflicts = (await Promise.all(destinationPaths.map(async (target) => await pathExists(path.join(server.directory, target)) ? target : null))).filter((target): target is string => Boolean(target));
      if (conflicts.length > 0 && !overwrite) throw new Error(`目标文件已存在，默认拒绝覆盖：${conflicts.slice(0, 10).join(", ")}`);
      await requireConfirmation(ctx, {
        title: "部署 Modrinth mrpack 服务端",
        description: `Agent 准备将槽位中的 ${info.slot.fileName} 部署为 ${info.name || "Modrinth 整合包"}：下载并校验 ${includedFiles.length} 个服务端文件（required+optional），合并 overrides/server-overrides，并安装 ${loader.type} ${loader.version || ""}。${conflicts.length > 0 ? `将覆盖 ${conflicts.length} 个已有文件。` : ""}`,
        risk: "high"
      });
      const downloadedFiles: string[] = [];
      for (const [index, file] of includedFiles.entries()) {
        const relative = safeFilePath(file);
        const destination = path.join("server", serverPath(relative));
        if (!overwrite && await pathExists(path.join(server.directory, destination))) continue;
        let lastError: unknown = null;
        for (const url of file.downloads) {
          try {
            downloadedFiles.push(await downloadFile(ctx, url, destination, file.hashes, file.fileSize, `mrpack 文件 ${index + 1}/${includedFiles.length} ${relative}`));
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
            if (isAbortError(error)) throw error;
          }
        }
        if (lastError) throw lastError;
      }
      const overrides = await ctx.fileService.materializeMrpackOverrides(ctx.serverId, "server", overwrite);
      const configuredLoader = await writeLoader(ctx, info, loader, javaPath || (await ctx.javaService.executableForInstalledVersion(ctx.javaService.recommendVersion(info.minecraftVersion))) || "java", overwrite);
      await writeFile(path.join(server.directory, "server", "eula.txt"), "eula=true\n", "utf8");
      const updated = await ctx.serverService.updateServer(ctx.serverId, {
        javaPath: javaPath || null,
        javaVersion: ctx.javaService.recommendVersion(info.minecraftVersion),
        minMemory: "4G",
        maxMemory: "4G",
        jarFile: ["vanilla", "fabric", "quilt"].includes(configuredLoader.type) ? "server.jar" : "",
        startArgs: configuredLoader.startArgs,
        minecraftVersion: info.minecraftVersion,
        modpackName: info.name || info.versionId || "Modrinth mrpack",
        serverType: configuredLoader.type
      });
      return JSON.stringify({ ok: true, format: "mrpack", pack: summary(info), loader: configuredLoader, downloadedFiles, copiedOverrides: overrides.copiedOverrides, server: updated, nextSteps: ["检查 server/ 中的 eula.txt、server.properties 与启动文件", "如需 MCDReforged，使用 reference 模板的 config.yml 将工作目录指向 server/，再配置 startupCommand={python} -m mcdreforged", "先直启验证，确认服务端完成启动后再配置 MCDReforged"] }, null, 2);
    }
  };
}

export function createInspectMrpackServerTool(ctx: AgentToolContext): AgentTool {
  return {
    definition: {
      type: "function",
      function: {
        name: inspectMrpackServerToolInfo.name,
        description: inspectMrpackServerToolInfo.description,
        parameters: objectSchema({})
      }
    },
    execute: async () => {
      const info = await ctx.fileService.inspectMrpackServerSlot(ctx.serverId);
      return JSON.stringify({ ok: true, format: "mrpack", pack: summary(info), files: info.files.map((file) => ({ path: file.path, downloads: file.downloads.length, hashes: Object.keys(file.hashes), fileSize: file.fileSize, environment: file.env })) }, null, 2);
    }
  };
}
