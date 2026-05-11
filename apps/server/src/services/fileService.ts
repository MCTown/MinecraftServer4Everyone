import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import extractZip from "extract-zip";
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

interface ExtractOptions {
  onProgress?: (progress: { entriesExtracted: number; percent: number; currentEntry: string }) => void;
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

  async readText(serverId: string, userPath: string) {
    const base = await this.getBase(serverId);
    const target = await resolveWithin(base, userPath, { mustExist: true });
    const info = await stat(target);
    if (!info.isFile()) throw new Error("Target is not a file");
    if (!textExtensions.has(path.extname(target).toLowerCase())) {
      throw new Error("File type is not a supported text file");
    }
    return readFile(target, "utf8");
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
    if (!slot.fileName.toLowerCase().endsWith(".zip")) throw new Error("服务端槽位文件不是 zip，无法解压");
    const base = await this.getBase(serverId);
    const destination = await resolveWithin(base, destinationPath);
    await mkdir(destination, { recursive: true });
    let entriesExtracted = 0;
    await extractZip(slot.filePath, {
      dir: destination,
      onEntry: (entry) => {
        const entryPath = entry.fileName.replaceAll("\\", "/");
        if (entryPath.startsWith("/") || entryPath.includes("../") || /^[a-zA-Z]:/.test(entryPath)) {
          throw new Error(`Unsafe zip entry: ${entry.fileName}`);
        }
        entriesExtracted += 1;
        options.onProgress?.({ entriesExtracted, percent: Math.min(95, entriesExtracted), currentEntry: entry.fileName });
      }
    });
    options.onProgress?.({ entriesExtracted, percent: 100, currentEntry: "完成" });
    return { slot, destinationPath: toRelative(base, destination), entriesExtracted };
  }

  async extractZipIntoServer(serverId: string, zipPath: string, destinationPath = ".") {
    const base = await this.getBase(serverId);
    const destination = await resolveWithin(base, destinationPath);
    await mkdir(destination, { recursive: true });
    await extractZip(zipPath, {
      dir: destination,
      onEntry: (entry) => {
        const entryPath = entry.fileName.replaceAll("\\", "/");
        if (entryPath.startsWith("/") || entryPath.includes("../") || /^[a-zA-Z]:/.test(entryPath)) {
          throw new Error(`Unsafe zip entry: ${entry.fileName}`);
        }
      }
    });
  }
}
