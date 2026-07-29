import { once } from "node:events";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import extractZip from "extract-zip";
import { extract as extractTar } from "tar";
import { fetch } from "undici";
import { appConfig } from "../config.js";
import type { FileEntry, ServerSlotStatus } from "../types.js";
import { resolveWithin } from "../security/pathSandbox.js";
import { fetchDispatcher } from "./proxySupport.js";
import { ServerService } from "./serverService.js";

interface DownloadProgressUpdate {
  loadedBytes: number;
  totalBytes: number | null;
  percent: number;
}

interface DownloadOptions {
  signal?: AbortSignal;
  proxyUrl?: string;
  onProgress?: (progress: DownloadProgressUpdate) => void;
}

export interface VerifiedDownloadOptions extends DownloadOptions {
  expectedHashes?: Record<string, string>;
  expectedSize?: number | null;
}

interface ExtractOptions {
  onProgress?: (progress: { entriesExtracted: number; percent: number; currentEntry: string }) => void;
}

interface ReadTextOptions {
  maxChars?: number;
  offset?: number;
}

export interface CurseForgeManifestFile {
  projectId: string;
  fileId: string;
  required: boolean;
}

export interface CurseForgeManifestSlotInfo {
  slot: ServerSlotStatus;
  name: string;
  version: string;
  minecraftVersion: string;
  loaders: string[];
  files: CurseForgeManifestFile[];
  overridesPath: string | null;
}

export interface MrpackFileEnvironment {
  client: "required" | "optional" | "unsupported";
  server: "required" | "optional" | "unsupported";
}

export interface MrpackFile {
  path: string;
  downloads: string[];
  hashes: Record<string, string>;
  fileSize: number | null;
  env: MrpackFileEnvironment;
}

export interface MrpackSlotInfo {
  slot: ServerSlotStatus;
  formatVersion: number;
  name: string;
  versionId: string;
  minecraftVersion: string;
  dependencies: Record<string, string>;
  files: MrpackFile[];
  overrideDirectories: string[];
}

const textExtensions = new Set([
  ".bat",
  ".cfg",
  ".conf",
  ".csv",
  ".env",
  ".ini",
  ".json",
  ".list",
  ".log",
  ".md",
  ".mclog",
  ".properties",
  ".ps1",
  ".sh",
  ".toml",
  ".tsv",
  ".txt",
  ".xml",
  ".yaml",
  ".yml"
]);

function toRelative(base: string, target: string) {
  const relative = path.relative(base, target).replaceAll(path.sep, "/");
  return relative || ".";
}

function abortError() {
  const error = new Error("Agent 操作已中断");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

function isUnsafeArchiveEntry(entryPath: string) {
  const normalized = entryPath.replaceAll("\\", "/");
  return normalized.startsWith("/") || normalized.split("/").includes("..") || /^[a-zA-Z]:/.test(normalized);
}

function isTarGzFile(fileName: string) {
  const lower = fileName.toLowerCase();
  return lower.endsWith(".tar.gz") || lower.endsWith(".tgz");
}

function isZipFile(fileName: string) {
  return fileName.toLowerCase().endsWith(".zip");
}

function isMrpackFile(fileName: string) {
  return fileName.toLowerCase().endsWith(".mrpack");
}

function isSafeRelativeArchivePath(value: string) {
  const normalized = value.replaceAll("\\", "/");
  return Boolean(normalized)
    && !normalized.startsWith("/")
    && !normalized.split("/").includes("..")
    && !/^[a-zA-Z]:/.test(normalized);
}

function mrpackEnvironment(value: unknown): MrpackFileEnvironment {
  const environment = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const field = (key: "client" | "server") => {
    const current = environment[key];
    return current === "required" || current === "optional" || current === "unsupported"
      ? current
      : "required";
  };
  return { client: field("client"), server: field("server") };
}

function parseMrpackIndex(value: unknown, slot: ServerSlotStatus, overrideDirectories: string[]): MrpackSlotInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("服务端槽位中的 modrinth.index.json 不是有效对象");
  }
  const index = value as Record<string, unknown>;
  if (index.game !== "minecraft") throw new Error("modrinth.index.json 不是 Minecraft 整合包清单");
  const formatVersion = Number(index.formatVersion);
  if (!Number.isInteger(formatVersion) || formatVersion < 1) {
    throw new Error("modrinth.index.json 缺少或包含无效的 formatVersion");
  }
  const dependenciesValue = index.dependencies;
  if (!dependenciesValue || typeof dependenciesValue !== "object" || Array.isArray(dependenciesValue)) {
    throw new Error("modrinth.index.json 缺少 dependencies");
  }
  const dependencies = Object.fromEntries(
    Object.entries(dependenciesValue as Record<string, unknown>)
      .flatMap(([key, dependency]) => typeof dependency === "string" && dependency.trim() ? [[key, dependency.trim()]] : [])
  );
  const minecraftVersion = dependencies.minecraft || "";
  if (!minecraftVersion) throw new Error("modrinth.index.json dependencies 缺少 minecraft 版本");
  if (!Array.isArray(index.files)) throw new Error("modrinth.index.json 缺少 files 数组");

  const seenPaths = new Set<string>();
  const files: MrpackFile[] = [];
  for (const entry of index.files) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("modrinth.index.json 包含无效文件条目");
    }
    const file = entry as Record<string, unknown>;
    const relativePath = typeof file.path === "string" ? file.path.trim().replaceAll("\\", "/") : "";
    if (!isSafeRelativeArchivePath(relativePath)) {
      throw new Error(`modrinth.index.json 包含不安全文件路径：${relativePath || "(空)"}`);
    }
    const pathKey = relativePath.toLowerCase();
    if (seenPaths.has(pathKey)) throw new Error(`modrinth.index.json 包含重复文件路径：${relativePath}`);
    seenPaths.add(pathKey);

    const downloads = Array.isArray(file.downloads)
      ? file.downloads.filter((download): download is string => typeof download === "string" && download.trim().length > 0)
      : [];
    if (downloads.length === 0) throw new Error(`modrinth.index.json 文件 ${relativePath} 缺少 downloads`);
    for (const download of downloads) {
      let url: URL;
      try {
        url = new URL(download);
      } catch {
        throw new Error(`modrinth.index.json 文件 ${relativePath} 包含无效下载地址：${download}`);
      }
      if (url.protocol !== "https:") throw new Error(`modrinth.index.json 文件 ${relativePath} 只能使用 HTTPS 下载地址`);
    }

    const hashes = file.hashes && typeof file.hashes === "object" && !Array.isArray(file.hashes)
      ? Object.fromEntries(
        Object.entries(file.hashes as Record<string, unknown>)
          .flatMap(([algorithm, hash]) => typeof hash === "string" && /^[a-f0-9]+$/i.test(hash) ? [[algorithm.toLowerCase(), hash.toLowerCase()]] : [])
      )
      : {};
    if (!hashes.sha512 && !hashes.sha1) throw new Error(`modrinth.index.json 文件 ${relativePath} 缺少 sha512/sha1 哈希`);
    files.push({
      path: relativePath,
      downloads,
      hashes,
      fileSize: typeof file.fileSize === "number" && Number.isFinite(file.fileSize) ? file.fileSize : null,
      env: mrpackEnvironment(file.env)
    });
  }

  return {
    slot,
    formatVersion,
    name: typeof index.name === "string" ? index.name.trim() : "",
    versionId: typeof index.versionId === "string" ? index.versionId.trim() : "",
    minecraftVersion,
    dependencies,
    files,
    overrideDirectories
  };
}

function parseCurseForgeManifest(value: unknown, slot: ServerSlotStatus): CurseForgeManifestSlotInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("服务端槽位中的 manifest.json 不是有效对象");
  }
  const manifest = value as Record<string, unknown>;
  if (manifest.manifestType !== "minecraftModpack") {
    throw new Error("服务端槽位中的 manifest.json 不是 CurseForge Minecraft 整合包清单");
  }
  const minecraft = manifest.minecraft;
  if (!minecraft || typeof minecraft !== "object" || Array.isArray(minecraft)) {
    throw new Error("CurseForge manifest.json 缺少 minecraft 配置");
  }
  const minecraftConfig = minecraft as Record<string, unknown>;
  const minecraftVersion = typeof minecraftConfig.version === "string" ? minecraftConfig.version.trim() : "";
  if (!minecraftVersion) throw new Error("CurseForge manifest.json 缺少 Minecraft 版本");

  const loaders = Array.isArray(minecraftConfig.modLoaders)
    ? minecraftConfig.modLoaders.flatMap((loader) => {
      if (!loader || typeof loader !== "object" || Array.isArray(loader)) return [];
      const id = (loader as Record<string, unknown>).id;
      return typeof id === "string" && id.trim() ? [id.trim()] : [];
    })
    : [];
  if (loaders.length === 0) throw new Error("CurseForge manifest.json 缺少 Loader 配置");

  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("CurseForge manifest.json 不包含任何模组文件");
  }
  const seen = new Set<string>();
  const files: CurseForgeManifestFile[] = [];
  for (const entry of manifest.files) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("CurseForge manifest.json 包含无效的文件条目");
    }
    const file = entry as Record<string, unknown>;
    const projectId = String(file.projectID ?? "").trim();
    const fileId = String(file.fileID ?? "").trim();
    if (!/^\d+$/.test(projectId) || !/^\d+$/.test(fileId) || Number(projectId) <= 0 || Number(fileId) <= 0) {
      throw new Error("CurseForge manifest.json 包含无效的 projectID/fileID");
    }
    const key = `${projectId}:${fileId}`;
    if (seen.has(key)) throw new Error(`CurseForge manifest.json 包含重复文件：${key}`);
    seen.add(key);
    files.push({ projectId, fileId, required: file.required !== false });
  }

  const rawOverrides = typeof manifest.overrides === "string" ? manifest.overrides.trim().replaceAll("\\", "/") : "";
  if (rawOverrides && (rawOverrides.startsWith("/") || rawOverrides.split("/").includes("..") || /^[a-zA-Z]:/.test(rawOverrides))) {
    throw new Error("CurseForge manifest.json 包含不安全的 overrides 路径");
  }

  return {
    slot,
    name: typeof manifest.name === "string" ? manifest.name.trim() : "",
    version: typeof manifest.version === "string" ? manifest.version.trim() : "",
    minecraftVersion,
    loaders,
    files,
    overridesPath: rawOverrides || null
  };
}

function safeDownloadName(url: string, fallback: string) {
  try {
    const name = path.basename(new URL(url).pathname).replace(/[<>:"/\\|?*]/g, "_");
    return name || fallback;
  } catch {
    return fallback;
  }
}

async function writeChunk(output: NodeJS.WritableStream, chunk: Uint8Array) {
  if (!output.write(chunk)) await once(output, "drain");
}

async function finishStream(output: NodeJS.WritableStream) {
  const finished = once(output, "finish").then(() => undefined);
  const failed = once(output, "error").then(([error]) => {
    throw error instanceof Error ? error : new Error(String(error));
  });
  output.end();
  await Promise.race([finished, failed]);
}

export class FileService {
  constructor(private readonly serverService: ServerService) {}

  private async getBase(serverId: string) {
    const server = await this.serverService.requireServer(serverId);
    await mkdir(server.directory, { recursive: true });
    return server.directory;
  }

  private async getServerSlotBase(serverId: string) {
    await this.serverService.requireServer(serverId);
    await mkdir(appConfig.serverSlotsDir, { recursive: true });
    const directory = await resolveWithin(appConfig.serverSlotsDir, serverId);
    await mkdir(directory, { recursive: true });
    return directory;
  }

  async list(serverId: string, userPath?: string) {
    const base = await this.getBase(serverId);
    const target = await resolveWithin(base, userPath, { mustExist: true });
    const info = await stat(target);
    if (!info.isDirectory()) {
      throw new Error("Target is not a directory");
    }
    const entries = await readdir(target, { withFileTypes: true });
    const result: FileEntry[] = [];
    for (const entry of entries) {
      const fullPath = path.join(target, entry.name);
      const entryStat = await stat(fullPath);
      const type = entry.isDirectory() ? "directory" : "file";
      result.push({
        name: entry.name,
        path: toRelative(base, fullPath),
        type,
        size: entryStat.size,
        modifiedAt: entryStat.mtime.toISOString(),
        editable: type === "file" && textExtensions.has(path.extname(entry.name).toLowerCase())
      });
    }
    return result.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  }

  async readText(serverId: string, userPath: string, options: ReadTextOptions = {}) {
    const base = await this.getBase(serverId);
    const target = await resolveWithin(base, userPath, { mustExist: true });
    const info = await stat(target);
    if (!info.isFile()) throw new Error("Target is not a file");
    if (!textExtensions.has(path.extname(target).toLowerCase())) {
      throw new Error("File type is not a supported text file");
    }
    const content = await readFile(target, "utf8");
    const offset = Math.min(Math.max(options.offset ?? 0, 0), content.length);
    const maxChars = options.maxChars;
    if (!maxChars && offset === 0) return content;
    const end = maxChars ? Math.min(offset + maxChars, content.length) : content.length;
    const prefix = offset > 0 ? `...（已跳过前 ${offset} 字符）\n` : "";
    const suffix = end < content.length ? `\n\n...（文件共 ${content.length} 字符，后续还有 ${content.length - end} 字符未返回。）` : "";
    return `${prefix}${content.slice(offset, end)}${suffix}`;
  }

  async resolveDownload(serverId: string, userPath: string) {
    const base = await this.getBase(serverId);
    const target = await resolveWithin(base, userPath, { mustExist: true });
    const info = await stat(target);
    if (!info.isFile()) throw new Error("Target is not a file");
    return { absolutePath: target, fileName: path.basename(target), size: info.size };
  }

  async writeText(serverId: string, userPath: string, content: string) {
    const base = await this.getBase(serverId);
    const target = await resolveWithin(base, userPath);
    if (!textExtensions.has(path.extname(target).toLowerCase())) {
      throw new Error("File type is not a supported text file");
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }

  async createFolder(serverId: string, userPath: string) {
    const base = await this.getBase(serverId);
    const target = await resolveWithin(base, userPath);
    await mkdir(target, { recursive: true });
  }

  async remove(serverId: string, userPath: string) {
    const base = await this.getBase(serverId);
    const target = await resolveWithin(base, userPath, { mustExist: true });
    if (target === base) throw new Error("Cannot delete server root directory");
    await rm(target, { recursive: true, force: true });
  }

  async rename(serverId: string, userPath: string, newName: string) {
    if (!newName || newName.includes("/") || newName.includes("\\") || newName === "." || newName === "..") {
      throw new Error("Invalid target name");
    }
    const base = await this.getBase(serverId);
    const target = await resolveWithin(base, userPath, { mustExist: true });
    const destination = await resolveWithin(base, path.join(path.dirname(path.relative(base, target)), newName));
    await rename(target, destination);
  }

  async copyIntoServer(serverId: string, sourcePath: string, destinationPath: string) {
    const base = await this.getBase(serverId);
    const destination = await resolveWithin(base, destinationPath);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(sourcePath, destination);
  }

  async copyDirectoryIntoServer(serverId: string, sourcePath: string, destinationPath = ".", overwrite = false) {
    const base = await this.getBase(serverId);
    const destination = await resolveWithin(base, destinationPath);
    await mkdir(destination, { recursive: true });
    await cp(sourcePath, destination, {
      recursive: true,
      force: overwrite,
      errorOnExist: false
    });
    return toRelative(base, destination);
  }

  async saveStream(serverId: string, directoryPath: string, fileName: string, stream: NodeJS.ReadableStream) {
    const safeName = path.basename(fileName).replace(/[<>:"/\\|?*]/g, "_") || "upload.bin";
    const base = await this.getBase(serverId);
    const directory = await resolveWithin(base, directoryPath);
    await mkdir(directory, { recursive: true });
    const destination = await resolveWithin(base, path.join(path.relative(base, directory), safeName));
    await pipeline(stream, createWriteStream(destination));
    return toRelative(base, destination);
  }

  async downloadIntoServer(serverId: string, url: string, destinationPath: string, options: DownloadOptions = {}) {
    const { signal, onProgress, proxyUrl } = options;
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new Error("Only HTTPS downloads are allowed");
    const base = await this.getBase(serverId);
    const destination = await resolveWithin(base, destinationPath);
    await mkdir(path.dirname(destination), { recursive: true });
    const tempDestination = path.join(path.dirname(destination), `.${path.basename(destination)}.${Date.now()}.download`);
    let output: ReturnType<typeof createWriteStream> | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    try {
      throwIfAborted(signal);
      const response = await fetch(parsed, { headers: { "user-agent": "MinecraftServerAgent/0.1" }, signal, dispatcher: fetchDispatcher(proxyUrl) });
      if (!response.ok || !response.body) {
        throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
      }

      const totalBytes = Number(response.headers.get("content-length")) || null;
      let loadedBytes = 0;
      const report = (percentOverride?: number) => {
        const percent = typeof percentOverride === "number"
          ? percentOverride
          : totalBytes ? Math.min(99, Math.floor((loadedBytes / totalBytes) * 100)) : 0;
        onProgress?.({ loadedBytes, totalBytes, percent });
      };

      output = createWriteStream(tempDestination);
      reader = response.body.getReader();
      report();

      while (true) {
        throwIfAborted(signal);
        const { done, value } = await reader.read();
        throwIfAborted(signal);
        if (done) break;
        if (!value) continue;
        loadedBytes += value.byteLength;
        await writeChunk(output, value);
        report();
      }

      await finishStream(output);
      output = null;
      await rename(tempDestination, destination);
      report(100);
      return toRelative(base, destination);
    } catch (error) {
      output?.destroy();
      await reader?.cancel().catch(() => undefined);
      await rm(tempDestination, { force: true }).catch(() => undefined);
      if (signal?.aborted || error instanceof Error && error.name === "AbortError") throw abortError();
      throw error;
    }
  }

  async downloadVerifiedIntoServer(serverId: string, url: string, destinationPath: string, options: VerifiedDownloadOptions = {}) {
    const expectedHashes = Object.fromEntries(
      Object.entries(options.expectedHashes ?? {})
        .filter(([algorithm, value]) => /^(sha1|sha256|sha512)$/i.test(algorithm) && /^[a-f0-9]+$/i.test(value))
        .map(([algorithm, value]) => [algorithm.toLowerCase(), value.toLowerCase()])
    );
    if (Object.keys(expectedHashes).length === 0) throw new Error("缺少可验证的文件哈希");

    const { signal, onProgress, proxyUrl } = options;
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new Error("Only HTTPS downloads are allowed");
    const base = await this.getBase(serverId);
    const destination = await resolveWithin(base, destinationPath);
    await mkdir(path.dirname(destination), { recursive: true });
    const tempDestination = path.join(path.dirname(destination), `.${path.basename(destination)}.${Date.now()}.verified-download`);
    let output: ReturnType<typeof createWriteStream> | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const hashes = new Map(Object.keys(expectedHashes).map((algorithm) => [algorithm, createHash(algorithm)]));
    let loadedBytes = 0;

    try {
      throwIfAborted(signal);
      const response = await fetch(parsed, { headers: { "user-agent": "MinecraftServerAgent/0.1" }, signal, dispatcher: fetchDispatcher(proxyUrl) });
      if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
      const totalBytes = Number(response.headers.get("content-length")) || options.expectedSize || null;
      const report = (percentOverride?: number) => {
        const percent = typeof percentOverride === "number"
          ? percentOverride
          : totalBytes ? Math.min(99, Math.floor((loadedBytes / totalBytes) * 100)) : 0;
        onProgress?.({ loadedBytes, totalBytes, percent });
      };
      output = createWriteStream(tempDestination);
      reader = response.body.getReader();
      report();
      while (true) {
        throwIfAborted(signal);
        const { done, value } = await reader.read();
        throwIfAborted(signal);
        if (done) break;
        if (!value) continue;
        loadedBytes += value.byteLength;
        for (const hash of hashes.values()) hash.update(value);
        await writeChunk(output, value);
        report();
      }
      await finishStream(output);
      output = null;
      if (options.expectedSize !== null && options.expectedSize !== undefined && loadedBytes !== options.expectedSize) {
        throw new Error(`文件大小校验失败：期望 ${options.expectedSize} 字节，实际 ${loadedBytes} 字节`);
      }
      const mismatches = [...hashes.entries()]
        .filter(([algorithm, hash]) => hash.digest("hex") !== expectedHashes[algorithm])
        .map(([algorithm]) => algorithm);
      if (mismatches.length > 0) throw new Error(`文件哈希校验失败：${mismatches.join(", ")}`);
      await rename(tempDestination, destination);
      report(100);
      return toRelative(base, destination);
    } catch (error) {
      output?.destroy();
      await reader?.cancel().catch(() => undefined);
      await rm(tempDestination, { force: true }).catch(() => undefined);
      if (signal?.aborted || error instanceof Error && error.name === "AbortError") throw abortError();
      throw error;
    }
  }

  async getServerSlotStatus(serverId: string): Promise<ServerSlotStatus> {
    const slotDir = await this.getServerSlotBase(serverId);
    const entries = await readdir(slotDir, { withFileTypes: true }).catch(() => []);
    const file = entries.filter((entry) => entry.isFile()).sort((first, second) => first.name.localeCompare(second.name))[0];
    if (!file) {
      return { occupied: false, directory: slotDir, fileName: null, filePath: null, size: null, modifiedAt: null };
    }
    const filePath = path.join(slotDir, file.name);
    const info = await stat(filePath);
    return {
      occupied: true,
      directory: slotDir,
      fileName: file.name,
      filePath,
      size: info.size,
      modifiedAt: info.mtime.toISOString()
    };
  }

  async clearServerSlot(serverId: string) {
    const slotDir = await this.getServerSlotBase(serverId);
    await rm(slotDir, { recursive: true, force: true });
    await mkdir(slotDir, { recursive: true });
    return slotDir;
  }

  async copyIntoServerSlot(serverId: string, sourcePath: string, fileName: string) {
    const slotDir = await this.clearServerSlot(serverId);
    const safeName = path.basename(fileName).replace(/[<>:"/\\|?*]/g, "_") || "server-package.bin";
    const destination = path.join(slotDir, safeName);
    await copyFile(sourcePath, destination);
    return this.getServerSlotStatus(serverId);
  }

  async downloadIntoServerSlot(serverId: string, url: string, options: DownloadOptions = {}) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new Error("Only HTTPS downloads are allowed");
    const slotDir = await this.clearServerSlot(serverId);
    const fileName = safeDownloadName(url, "server-package.bin");
    const destination = path.join(slotDir, fileName);
    const tempDestination = path.join(slotDir, `.${fileName}.${Date.now()}.download`);
    const { signal, onProgress, proxyUrl } = options;
    let output: ReturnType<typeof createWriteStream> | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    try {
      throwIfAborted(signal);
      const response = await fetch(parsed, { headers: { "user-agent": "MinecraftServerAgent/0.1" }, signal, dispatcher: fetchDispatcher(proxyUrl) });
      if (!response.ok || !response.body) {
        throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
      }

      const totalBytes = Number(response.headers.get("content-length")) || null;
      let loadedBytes = 0;
      const report = (percentOverride?: number) => {
        const percent = typeof percentOverride === "number"
          ? percentOverride
          : totalBytes ? Math.min(99, Math.floor((loadedBytes / totalBytes) * 100)) : 0;
        onProgress?.({ loadedBytes, totalBytes, percent });
      };

      output = createWriteStream(tempDestination);
      reader = response.body.getReader();
      report();

      while (true) {
        throwIfAborted(signal);
        const { done, value } = await reader.read();
        throwIfAborted(signal);
        if (done) break;
        if (!value) continue;
        loadedBytes += value.byteLength;
        await writeChunk(output, value);
        report();
      }

      await finishStream(output);
      output = null;
      await rename(tempDestination, destination);
      report(100);
      return this.getServerSlotStatus(serverId);
    } catch (error) {
      output?.destroy();
      await reader?.cancel().catch(() => undefined);
      await rm(tempDestination, { force: true }).catch(() => undefined);
      if (signal?.aborted || error instanceof Error && error.name === "AbortError") throw abortError();
      throw error;
    }
  }

  async extractServerSlotIntoServer(serverId: string, destinationPath = ".", options: ExtractOptions = {}) {
    const slot = await this.getServerSlotStatus(serverId);
    if (!slot.filePath || !slot.fileName) throw new Error("服务端槽位为空");
    if (isMrpackFile(slot.fileName)) {
      throw new Error("服务端槽位是 Modrinth .mrpack，不能用 extract_server_slot_to_workspace 解压。请先调用 inspect_mrpack_server_slot，再调用 deploy_mrpack_server_from_server_slot。");
    }
    if (!isZipFile(slot.fileName) && !isTarGzFile(slot.fileName)) throw new Error("服务端槽位文件不是 zip/tar.gz/tgz，无法解压");
    const base = await this.getBase(serverId);
    const destination = await resolveWithin(base, destinationPath);
    let entriesExtracted = 0;
    await this.extractArchive(slot.filePath, slot.fileName, destination, (entryName) => {
      entriesExtracted += 1;
      options.onProgress?.({ entriesExtracted, percent: Math.min(95, entriesExtracted), currentEntry: entryName });
    });
    options.onProgress?.({ entriesExtracted, percent: 100, currentEntry: "完成" });
    return { slot, destinationPath: toRelative(base, destination), entriesExtracted };
  }

  async inspectCurseForgeManifestServerSlot(serverId: string): Promise<CurseForgeManifestSlotInfo> {
    return this.withStagedCurseForgeManifest(serverId, async ({ manifest }) => manifest);
  }

  async inspectMrpackServerSlot(serverId: string): Promise<MrpackSlotInfo> {
    return this.withStagedMrpack(serverId, async ({ info }) => info);
  }

  async materializeMrpackOverrides(serverId: string, destinationPath = "server", overwrite = false) {
    const base = await this.getBase(serverId);
    const destination = await resolveWithin(base, destinationPath);
    return this.withStagedMrpack(serverId, async ({ info, stagingDirectory }) => {
      const copiedOverrides: string[] = [];
      await mkdir(destination, { recursive: true });
      for (const directory of info.overrideDirectories) {
        if (directory !== "overrides" && directory !== "server-overrides") {
          throw new Error(`不支持的 mrpack overrides 目录：${directory}`);
        }
        const source = await resolveWithin(stagingDirectory, directory, { mustExist: true });
        const sourceInfo = await stat(source);
        if (!sourceInfo.isDirectory()) throw new Error(`mrpack overrides 路径不是目录：${directory}`);
        const entries = await readdir(source, { withFileTypes: true });
        for (const entry of entries) {
          const sourceEntry = path.join(source, entry.name);
          const targetEntry = await resolveWithin(base, path.join(destinationPath, entry.name));
          await this.copyTree(sourceEntry, targetEntry, overwrite);
          copiedOverrides.push(toRelative(base, targetEntry));
        }
      }
      return { info, copiedOverrides };
    });
  }

  private async copyTree(source: string, destination: string, overwrite: boolean) {
    const sourceInfo = await stat(source);
    const destinationInfo = await stat(destination).catch(() => null);
    if (!destinationInfo) {
      await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
      return;
    }
    if (!sourceInfo.isDirectory() || !destinationInfo.isDirectory()) {
      if (!overwrite) throw new Error(`目标文件已存在，拒绝覆盖：${destination}`);
      await cp(source, destination, { recursive: true, force: true });
      return;
    }
    const entries = await readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      await this.copyTree(path.join(source, entry.name), path.join(destination, entry.name), overwrite);
    }
  }

  async materializeCurseForgeManifestOverrides(serverId: string, destinationPath = "server") {
    const base = await this.getBase(serverId);
    const destination = await resolveWithin(base, destinationPath);
    return this.withStagedCurseForgeManifest(serverId, async ({ manifest, stagingDirectory }) => {
      if (!manifest.overridesPath) return { manifest, copiedOverrides: [] as string[] };
      const overridesDirectory = await resolveWithin(stagingDirectory, manifest.overridesPath, { mustExist: true });
      const overridesInfo = await stat(overridesDirectory);
      if (!overridesInfo.isDirectory()) throw new Error("CurseForge manifest.json 的 overrides 不是目录");
      await mkdir(destination, { recursive: true });
      const entries = await readdir(overridesDirectory, { withFileTypes: true });
      const copiedOverrides: string[] = [];
      for (const entry of entries) {
        const source = path.join(overridesDirectory, entry.name);
        const target = await resolveWithin(base, path.join(destinationPath, entry.name));
        await cp(source, target, { recursive: true, force: false, errorOnExist: true });
        copiedOverrides.push(toRelative(base, target));
      }
      return { manifest, copiedOverrides };
    });
  }

  async extractArchiveIntoServer(serverId: string, archivePath: string, archiveName: string, destinationPath = ".") {
    const base = await this.getBase(serverId);
    const destination = await resolveWithin(base, destinationPath);
    await this.extractArchive(archivePath, archiveName, destination);
  }

  async extractZipIntoServer(serverId: string, zipPath: string, destinationPath = ".") {
    const base = await this.getBase(serverId);
    const destination = await resolveWithin(base, destinationPath);
    await this.extractArchive(zipPath, path.basename(zipPath), destination);
  }

  private async extractArchive(archivePath: string, archiveName: string, destination: string, onEntry?: (entryName: string) => void) {
    await mkdir(destination, { recursive: true });
    if (isZipFile(archiveName)) {
      await this.extractZipArchive(archivePath, destination, onEntry);
      return;
    }
    if (isTarGzFile(archiveName)) {
      await this.extractTarGzArchive(archivePath, destination, onEntry);
      return;
    }
    throw new Error("Archive is not zip/tar.gz/tgz");
  }

  private async withStagedCurseForgeManifest<T>(serverId: string, callback: (data: { manifest: CurseForgeManifestSlotInfo; stagingDirectory: string }) => Promise<T>) {
    const slot = await this.getServerSlotStatus(serverId);
    if (!slot.filePath || !slot.fileName) throw new Error("服务端槽位为空");
    if (!isZipFile(slot.fileName)) throw new Error("CurseForge 清单整合包必须位于服务端槽位中的 .zip 文件");
    const stagingDirectory = path.join(path.dirname(slot.filePath), `.curseforge-manifest-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      await this.extractZipArchive(slot.filePath, stagingDirectory);
      const manifestPath = path.join(stagingDirectory, "manifest.json");
      const manifestText = await readFile(manifestPath, "utf8").catch(() => {
        throw new Error("服务端槽位 ZIP 根目录缺少 manifest.json，不能按 CurseForge 清单包安装");
      });
      let parsed: unknown;
      try {
        parsed = JSON.parse(manifestText);
      } catch {
        throw new Error("服务端槽位中的 manifest.json 不是有效 JSON");
      }
      const manifest = parseCurseForgeManifest(parsed, slot);
      return await callback({ manifest, stagingDirectory });
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true });
    }
  }

  private async withStagedMrpack<T>(serverId: string, callback: (data: { info: MrpackSlotInfo; index: unknown; stagingDirectory: string; overrideDirectories: string[] }) => Promise<T>) {
    const slot = await this.getServerSlotStatus(serverId);
    if (!slot.filePath || !slot.fileName) throw new Error("服务端槽位为空");
    if (!isMrpackFile(slot.fileName)) throw new Error("Modrinth 整合包必须位于服务端槽位中的 .mrpack 文件");
    const stagingDirectory = path.join(path.dirname(slot.filePath), `.mrpack-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      await this.extractZipArchive(slot.filePath, stagingDirectory);
      const indexPath = path.join(stagingDirectory, "modrinth.index.json");
      const indexText = await readFile(indexPath, "utf8").catch(() => {
        throw new Error("服务端槽位 .mrpack 根目录缺少 modrinth.index.json");
      });
      let parsed: unknown;
      try {
        parsed = JSON.parse(indexText);
      } catch {
        throw new Error("服务端槽位中的 modrinth.index.json 不是有效 JSON");
      }
      // Modrinth mrpack: overrides/ (client+server) and server-overrides/ (server only).
      // Copy whole trees so root files like overrides/options.txt are not dropped.
      const overrideDirectories: string[] = [];
      for (const directory of ["overrides", "server-overrides"]) {
        const source = path.join(stagingDirectory, directory);
        const sourceInfo = await stat(source).catch(() => null);
        if (sourceInfo?.isDirectory()) overrideDirectories.push(directory);
      }
      const info = parseMrpackIndex(parsed, slot, overrideDirectories);
      return await callback({ info, index: parsed, stagingDirectory, overrideDirectories });
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true });
    }
  }

  private async extractZipArchive(zipPath: string, destination: string, onEntry?: (entryName: string) => void) {
    await extractZip(zipPath, {
      dir: destination,
      onEntry: (entry) => {
        if (isUnsafeArchiveEntry(entry.fileName)) {
          throw new Error(`Unsafe zip entry: ${entry.fileName}`);
        }
        onEntry?.(entry.fileName);
      }
    });
  }

  private async extractTarGzArchive(archivePath: string, destination: string, onEntry?: (entryName: string) => void) {
    await extractTar({
      file: archivePath,
      cwd: destination,
      gzip: true,
      preservePaths: false,
      filter: (entryPath) => {
        if (isUnsafeArchiveEntry(entryPath)) throw new Error(`Unsafe tar entry: ${entryPath}`);
        return true;
      },
      onReadEntry: (entry) => onEntry?.(entry.path)
    });
  }
}
