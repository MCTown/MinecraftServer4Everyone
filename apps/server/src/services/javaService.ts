import { once } from "node:events";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import extractZip from "extract-zip";
import { fetch } from "undici";
import { appConfig } from "../config.js";
import { fetchDispatcher } from "./proxySupport.js";

export type JavaInstallTaskStatus = "pending" | "resolving" | "downloading" | "extracting" | "installing" | "cancelling" | "installed" | "failed" | "cancelled";
export type JavaDownloadSource = "auto-cn" | "tsinghua" | "cernet" | "official";

export interface JavaDownloadSourceOption {
  id: JavaDownloadSource;
  label: string;
  description: string;
}

export interface JavaInstall {
  version: string;
  name: string;
  path: string;
  available: boolean;
}

export interface JavaInstallTask {
  version: string;
  status: JavaInstallTaskStatus;
  source: JavaDownloadSource;
  sourceLabel: string;
  progress: number;
  downloadedBytes: number;
  totalBytes: number | null;
  message: string;
  path: string | null;
  error: string | null;
  startedAt: string;
  updatedAt: string;
}

export interface JavaVersionRecord {
  version: string;
  label: string;
  lts: boolean;
  installed: boolean;
  installPath: string | null;
  available: boolean;
  task: JavaInstallTask | null;
}

interface JavaReleaseInfo {
  versions: string[];
  ltsVersions: Set<string>;
}

interface JavaInstallResult {
  version: string;
  path: string;
  installed: boolean;
}

interface JavaInstallOptions {
  source?: string | null;
}

interface JavaInstallContext {
  version: string;
  source: JavaDownloadSource;
  controller: AbortController;
  archivePath: string | null;
  extractRoot: string | null;
}

interface JavaDownloadCandidate {
  source: JavaDownloadSource;
  label: string;
  url: string;
  archiveName: string;
}

interface AdoptiumReleaseInfo {
  available_releases?: number[];
  available_lts_releases?: number[];
}

interface AdoptiumAsset {
  binary?: {
    package?: {
      link?: string;
      name?: string;
    };
  };
}

class JavaInstallCancelledError extends Error {
  constructor(version: string) {
    super(`Java ${version} installation was cancelled`);
    this.name = "JavaInstallCancelledError";
  }
}

export class JavaService {
  private readonly fallbackVersions = ["8", "11", "16", "17", "21", "22", "23", "24", "25"];
  private readonly fallbackLtsVersions = new Set(["8", "11", "17", "21"]);
  private readonly defaultDownloadSource: JavaDownloadSource = "auto-cn";
  private readonly downloadSources: JavaDownloadSourceOption[] = [
    { id: "auto-cn", label: "国内高速（自动）", description: "优先使用清华、校园网联合镜像，失败后回退 Adoptium 官方源" },
    { id: "tsinghua", label: "清华镜像", description: "从清华大学 TUNA 的 Adoptium 镜像下载，失败后回退官方源" },
    { id: "cernet", label: "校园网联合镜像", description: "通过 mirrors.cernet.edu.cn 自动选择国内高校镜像，失败后回退官方源" },
    { id: "official", label: "Adoptium 官方", description: "从 Adoptium 官方发布地址下载" }
  ];
  private readonly installTasks = new Map<string, JavaInstallTask>();
  private readonly runningInstalls = new Map<string, Promise<JavaInstallResult>>();
  private readonly runningContexts = new Map<string, JavaInstallContext>();
  private releaseCache: { info: JavaReleaseInfo; expiresAt: number } | null = null;

  constructor(private readonly proxyUrl?: () => string | undefined) {}

  async listInstalled(): Promise<JavaInstall[]> {
    const entries = await readdir(appConfig.jdksDir, { withFileTypes: true }).catch(() => []);
    const result: JavaInstall[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith("_extract_")) continue;
      const dir = path.join(appConfig.jdksDir, entry.name);
      const executable = process.platform === "win32"
        ? path.join(dir, "bin", "java.exe")
        : path.join(dir, "bin", "java");
      const exists = await stat(executable).then(() => true).catch(() => false);
      result.push({ version: this.versionFromDirName(entry.name), name: entry.name, path: executable, available: exists });
    }
    return result.sort((a, b) => Number(a.version) - Number(b.version));
  }

  async getManagementState() {
    const [installed, releases] = await Promise.all([this.listInstalled(), this.getAvailableReleases()]);
    const installedByVersion = new Map(installed.filter((item) => item.available).map((item) => [item.version, item]));
    const versions: JavaVersionRecord[] = releases.versions.map((version) => {
      const installedItem = installedByVersion.get(version);
      return {
        version,
        label: `Java ${version}${releases.ltsVersions.has(version) ? " LTS" : ""}`,
        lts: releases.ltsVersions.has(version),
        installed: Boolean(installedItem),
        installPath: installedItem?.path ?? null,
        available: true,
        task: this.taskForVersion(version)
      };
    });

    for (const item of installed) {
      if (versions.some((version) => version.version === item.version)) continue;
      versions.push({
        version: item.version,
        label: `Java ${item.version}`,
        lts: releases.ltsVersions.has(item.version),
        installed: item.available,
        installPath: item.available ? item.path : null,
        available: false,
        task: this.taskForVersion(item.version)
      });
    }

    return { versions, installed, tasks: this.listTasks(), sources: this.downloadSources };
  }

  listDownloadSources() {
    return this.downloadSources.map((source) => ({ ...source }));
  }

  listTasks() {
    return [...this.installTasks.values()]
      .map((task) => ({ ...task }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async startInstall(version: string, options: JavaInstallOptions = {}) {
    const normalized = this.normalizeVersion(version);
    const runningTask = this.taskForVersion(normalized);
    if (runningTask && this.isTaskActive(runningTask)) return runningTask;
    const source = this.normalizeSource(options.source);

    const executable = this.executableForVersion(normalized);
    if (await stat(executable).then(() => true).catch(() => false)) {
      const task = this.createTask(normalized, {
        status: "installed",
        source,
        sourceLabel: this.sourceLabel(source),
        progress: 100,
        path: executable,
        message: `Java ${normalized} 已安装`
      });
      this.installTasks.set(normalized, task);
      return { ...task };
    }

    const task = this.createTask(normalized, { source, sourceLabel: this.sourceLabel(source) });
    this.installTasks.set(normalized, task);
    void this.installVersion(normalized, { source }).catch(() => undefined);
    return { ...task };
  }

  async installVersion(version: string, options: JavaInstallOptions = {}) {
    const normalized = this.normalizeVersion(version);
    const running = this.runningInstalls.get(normalized);
    if (running) return running;
    const source = this.normalizeSource(options.source);

    const existingTask = this.taskForVersion(normalized);
    const task = existingTask && this.isTaskActive(existingTask)
      ? existingTask
      : this.createTask(normalized, { source, sourceLabel: this.sourceLabel(source) });
    this.installTasks.set(normalized, task);
    const context: JavaInstallContext = { version: normalized, source: task.source, controller: new AbortController(), archivePath: null, extractRoot: null };
    this.runningContexts.set(normalized, context);

    const install = this.performInstall(normalized, task, context)
      .then((result) => {
        this.updateTask(normalized, {
          status: "installed",
          progress: 100,
          path: result.path,
          error: null,
          message: result.installed ? `Java ${normalized} 安装完成` : `Java ${normalized} 已安装`
        });
        return result;
      })
      .catch((error: unknown) => {
        if (error instanceof JavaInstallCancelledError) {
          this.updateTask(normalized, {
            status: "cancelled",
            progress: 0,
            downloadedBytes: 0,
            totalBytes: null,
            error: null,
            message: `Java ${normalized} 安装已取消`
          });
          throw error;
        }
        this.updateTask(normalized, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          message: `Java ${normalized} 安装失败`
        });
        throw error;
      })
      .finally(() => {
        this.runningInstalls.delete(normalized);
        this.runningContexts.delete(normalized);
      });

    this.runningInstalls.set(normalized, install);
    return install;
  }

  async cancelInstall(version: string) {
    const normalized = this.normalizeVersion(version);
    const context = this.runningContexts.get(normalized);
    const task = this.installTasks.get(normalized);
    if (!context || !task || !this.isTaskActive(task)) {
      const latest = this.taskForVersion(normalized);
      if (latest) return latest;
      throw new Error(`Java ${normalized} is not installing`);
    }

    this.updateTask(normalized, { status: "cancelling", message: `正在取消 Java ${normalized} 安装` });
    context.controller.abort(new JavaInstallCancelledError(normalized));
    return this.taskForVersion(normalized);
  }

  recommendVersion(minecraftVersion?: string | null) {
    if (!minecraftVersion) return "17";
    const [majorRaw, minorRaw, patchRaw] = minecraftVersion.split(".");
    const major = Number(majorRaw);
    const minor = Number(minorRaw);
    const patch = Number(patchRaw ?? 0);
    if (major !== 1) return "21";
    if (minor <= 16) return "8";
    if (minor === 17) return "16";
    if (minor >= 20 && patch >= 5) return "21";
    if (minor >= 21) return "21";
    return "17";
  }

  private async performInstall(normalized: string, task: JavaInstallTask, context: JavaInstallContext): Promise<JavaInstallResult> {
    if (process.platform !== "win32") {
      throw new Error("Automatic Java installation currently supports Windows zip packages only");
    }

    try {
      const targetDir = this.targetDirForVersion(normalized);
      const executable = this.executableForVersion(normalized);
      if (await stat(executable).then(() => true).catch(() => false)) {
        return { version: normalized, path: executable, installed: false };
      }

      await mkdir(appConfig.jdksDir, { recursive: true });
      this.ensureNotCancelled(context);
      this.updateTask(task.version, { status: "resolving", progress: 5, source: context.source, sourceLabel: this.sourceLabel(context.source), message: `正在查询 Java ${normalized} 下载源` });
      const candidates = await this.resolveDownloadCandidates(normalized, context);
      const archivePath = await this.downloadFromCandidates(candidates, task.version, context);

      const extractRoot = path.join(appConfig.jdksDir, `_extract_temurin_${normalized}`);
      context.extractRoot = extractRoot;
      this.ensureNotCancelled(context);
      this.updateTask(task.version, { status: "extracting", progress: 92, message: `正在解压 Java ${normalized}` });
      await rm(extractRoot, { recursive: true, force: true });
      await mkdir(extractRoot, { recursive: true });
      await extractZip(archivePath, { dir: extractRoot });
      this.ensureNotCancelled(context);
      const children = await readdir(extractRoot, { withFileTypes: true });
      const jdkDir = children.find((entry) => entry.isDirectory());
      if (!jdkDir) throw new Error("Downloaded Java archive did not contain a JDK directory");
      this.updateTask(task.version, { status: "installing", progress: 97, message: `正在写入 Java ${normalized}` });
      this.ensureNotCancelled(context);
      await rm(targetDir, { recursive: true, force: true });
      await rename(path.join(extractRoot, jdkDir.name), targetDir);
      await rm(extractRoot, { recursive: true, force: true });
      context.extractRoot = null;
      return { version: normalized, path: executable, installed: true };
    } catch (error) {
      if (this.isCancelledError(error, context)) {
        await this.cleanupContext(context);
        throw new JavaInstallCancelledError(normalized);
      }
      throw error;
    }
  }

  private async downloadFromCandidates(candidates: JavaDownloadCandidate[], version: string, context: JavaInstallContext): Promise<string> {
    let lastError: unknown;
    for (const candidate of candidates) {
      this.ensureNotCancelled(context);
      const archivePath = path.join(appConfig.jdksDir, path.basename(candidate.archiveName));
      context.archivePath = archivePath;
      this.updateTask(version, { source: candidate.source, sourceLabel: candidate.label, message: `正在使用 ${candidate.label} 下载 Java ${version}` });
      await rm(archivePath, { force: true });
      try {
        await this.downloadArchive(candidate, archivePath, version, context);
        return archivePath;
      } catch (error) {
        if (this.isCancelledError(error, context)) throw error;
        lastError = error;
        await rm(archivePath, { force: true });
        this.updateTask(version, { progress: 8, message: `${candidate.label} 下载失败，正在切换下载源` });
      }
    }

    if (!candidates.some((candidate) => candidate.source === "official")) {
      try {
        this.updateTask(version, { progress: 8, message: "国内下载源不可用，正在切换 Adoptium 官方源" });
        const official = await this.resolveOfficialDownload(version, context);
        return await this.downloadFromCandidates([official], version, context);
      } catch (error) {
        if (this.isCancelledError(error, context)) throw error;
        lastError = error;
      }
    }

    const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error");
    throw new Error(`Java ${version} 下载失败：${detail}`);
  }

  private async downloadArchive(candidate: JavaDownloadCandidate, archivePath: string, version: string, context: JavaInstallContext) {
    const download = await fetch(candidate.url, { signal: context.controller.signal, dispatcher: fetchDispatcher(this.proxyUrl?.()) });
    if (!download.ok || !download.body) {
      throw new Error(`${candidate.label} download failed: ${download.status}`);
    }
    const contentType = download.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
      throw new Error(`${candidate.label} returned a web page instead of a Java archive`);
    }

    const totalBytes = Number(download.headers.get("content-length")) || null;
    let downloadedBytes = 0;
    const output = createWriteStream(archivePath);
    this.updateTask(version, { status: "downloading", progress: 10, downloadedBytes, totalBytes, source: candidate.source, sourceLabel: candidate.label, message: `正在从 ${candidate.label} 下载 Java ${version}` });

    try {
      const reader = download.body.getReader();
      while (true) {
        this.ensureNotCancelled(context);
        const { done, value } = await reader.read();
        this.ensureNotCancelled(context);
        if (done) break;
        if (!value) continue;
        downloadedBytes += value.byteLength;
        await this.writeChunk(output, value);
        const progress = totalBytes ? Math.min(90, Math.floor(10 + (downloadedBytes / totalBytes) * 80)) : 10;
        this.updateTask(version, { progress, downloadedBytes, totalBytes, message: `正在从 ${candidate.label} 下载 Java ${version}` });
      }
      await this.finishStream(output);
    } catch (error) {
      output.destroy();
      if (this.isCancelledError(error, context)) throw new JavaInstallCancelledError(version);
      throw error;
    }
  }

  private async resolveDownloadCandidates(version: string, context: JavaInstallContext) {
    if (context.source === "official") return [await this.resolveOfficialDownload(version, context)];

    const mirrorSources: Array<Exclude<JavaDownloadSource, "auto-cn" | "official">> = context.source === "auto-cn" ? ["tsinghua", "cernet"] : [context.source];
    const candidates: JavaDownloadCandidate[] = [];
    let lastMirrorError: unknown;
    for (const source of mirrorSources) {
      try {
        candidates.push(await this.resolveMirrorDownload(source, version, context));
      } catch (error) {
        if (this.isCancelledError(error, context)) throw new JavaInstallCancelledError(version);
        lastMirrorError = error;
      }
    }

    if (candidates.length > 0) return candidates;
    if (lastMirrorError) this.updateTask(version, { progress: 8, message: "国内下载源查询失败，正在切换 Adoptium 官方源" });
    return [await this.resolveOfficialDownload(version, context)];
  }

  private async resolveMirrorDownload(source: Exclude<JavaDownloadSource, "auto-cn" | "official">, version: string, context: JavaInstallContext): Promise<JavaDownloadCandidate> {
    const directoryUrl = this.mirrorDirectoryUrl(source, version);
    const response = await fetch(directoryUrl, { signal: context.controller.signal, dispatcher: fetchDispatcher(this.proxyUrl?.()) });
    if (!response.ok) throw new Error(`${this.sourceLabel(source)} directory failed: ${response.status}`);
    const html = await response.text();
    const href = this.findMirrorArchiveHref(html, version);
    if (!href) throw new Error(`${this.sourceLabel(source)} has no Windows zip package for Java ${version}`);
    const url = new URL(href, directoryUrl).toString();
    const archiveName = path.basename(decodeURIComponent(new URL(url).pathname));
    return { source, label: this.sourceLabel(source), url, archiveName };
  }

  private async resolveOfficialDownload(version: string, context: JavaInstallContext): Promise<JavaDownloadCandidate> {
    const apiUrl = `https://api.adoptium.net/v3/assets/latest/${version}/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse`;
    try {
      const assets = await fetch(apiUrl, { signal: context.controller.signal, dispatcher: fetchDispatcher(this.proxyUrl?.()) }).then((response) => {
        if (!response.ok) throw new Error(`Adoptium API failed: ${response.status}`);
        return response.json() as Promise<AdoptiumAsset[]>;
      });
      const asset = assets[0]?.binary?.package;
      if (!asset?.link) throw new Error(`No Adoptium package found for Java ${version}`);
      return {
        source: "official",
        label: this.sourceLabel("official"),
        url: asset.link,
        archiveName: path.basename(asset.name ?? `temurin-${version}.zip`)
      };
    } catch (error) {
      if (this.isCancelledError(error, context)) throw new JavaInstallCancelledError(version);
      throw error;
    }
  }

  private mirrorDirectoryUrl(source: Exclude<JavaDownloadSource, "auto-cn" | "official">, version: string) {
    const baseUrl = source === "tsinghua"
      ? "https://mirrors.tuna.tsinghua.edu.cn/Adoptium"
      : "https://mirrors.cernet.edu.cn/Adoptium";
    return `${baseUrl}/${version}/jdk/x64/windows/`;
  }

  private findMirrorArchiveHref(html: string, version: string) {
    const hrefs = [...html.matchAll(/href=["']([^"']+\.zip)["']/gi)]
      .map((match) => match[1])
      .filter((href): href is string => Boolean(href));
    const normalizedVersion = version === "8" ? "8" : `${version}`;
    const candidates = hrefs.filter((href) => {
      const name = path.basename(href).toLowerCase();
      return name.includes(`openjdk${normalizedVersion}u-jdk_x64_windows_hotspot_`.toLowerCase())
        || name.includes(`openjdk${normalizedVersion}-jdk_x64_windows_hotspot_`.toLowerCase())
        || name.includes(`openjdk${normalizedVersion}u_jdk_x64_windows_hotspot_`.toLowerCase());
    });
    return (candidates.length > 0 ? candidates : hrefs).sort().at(-1) ?? null;
  }

  private async cleanupContext(context: JavaInstallContext) {
    if (context.archivePath) await rm(context.archivePath, { force: true }).catch(() => undefined);
    if (context.extractRoot) await rm(context.extractRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  private async writeChunk(output: WriteStream, chunk: Uint8Array) {
    if (!output.write(chunk)) await once(output, "drain");
  }

  private async finishStream(output: WriteStream) {
    const finished = once(output, "finish").then(() => undefined);
    const failed = once(output, "error").then(([error]) => {
      throw error instanceof Error ? error : new Error(String(error));
    });
    output.end();
    await Promise.race([finished, failed]);
  }

  private async getAvailableReleases(): Promise<JavaReleaseInfo> {
    if (this.releaseCache && Date.now() < this.releaseCache.expiresAt) return this.releaseCache.info;

    const fallback = { versions: this.fallbackVersions, ltsVersions: this.fallbackLtsVersions };
    try {
      const response = await fetch("https://api.adoptium.net/v3/info/available_releases", { dispatcher: fetchDispatcher(this.proxyUrl?.()) });
      if (!response.ok) return fallback;
      const data = await response.json() as AdoptiumReleaseInfo;
      const versions = [...new Set((data.available_releases ?? [])
        .filter((version) => Number.isInteger(version) && version > 0)
        .map((version) => String(version)))]
        .sort((a, b) => Number(a) - Number(b));
      if (versions.length === 0) return fallback;
      const ltsVersions = new Set((data.available_lts_releases ?? []).map((version) => String(version)));
      const info = { versions, ltsVersions };
      this.releaseCache = { info, expiresAt: Date.now() + 10 * 60 * 1000 };
      return info;
    } catch {
      return fallback;
    }
  }

  private normalizeVersion(version: string) {
    const normalized = version.trim();
    if (!/^[1-9]\d*$/.test(normalized)) {
      throw new Error("Java version must be a positive integer, for example 8, 17 or 21");
    }
    return normalized;
  }

  private normalizeSource(source?: string | null): JavaDownloadSource {
    const normalized = source?.trim() || this.defaultDownloadSource;
    if (this.downloadSources.some((item) => item.id === normalized)) return normalized as JavaDownloadSource;
    throw new Error(`Unsupported Java download source: ${normalized}`);
  }

  private sourceLabel(source: JavaDownloadSource) {
    return this.downloadSources.find((item) => item.id === source)?.label ?? source;
  }

  private ensureNotCancelled(context: JavaInstallContext) {
    if (context.controller.signal.aborted) throw new JavaInstallCancelledError(context.version);
  }

  private isCancelledError(error: unknown, context: JavaInstallContext) {
    return context.controller.signal.aborted || error instanceof JavaInstallCancelledError || (error instanceof Error && error.name === "AbortError");
  }

  private createTask(version: string, overrides: Partial<JavaInstallTask> = {}): JavaInstallTask {
    const now = new Date().toISOString();
    return {
      version,
      status: "pending",
      source: this.defaultDownloadSource,
      sourceLabel: this.downloadSources.find((source) => source.id === this.defaultDownloadSource)?.label ?? "国内高速（自动）",
      progress: 0,
      downloadedBytes: 0,
      totalBytes: null,
      message: `等待安装 Java ${version}`,
      path: null,
      error: null,
      startedAt: now,
      updatedAt: now,
      ...overrides
    };
  }

  private updateTask(version: string, changes: Partial<JavaInstallTask>) {
    const task = this.installTasks.get(version);
    if (!task) return;
    Object.assign(task, changes, { updatedAt: new Date().toISOString() });
  }

  private taskForVersion(version: string) {
    const task = this.installTasks.get(version);
    return task ? { ...task } : null;
  }

  private isTaskActive(task: JavaInstallTask) {
    return !["installed", "failed", "cancelled"].includes(task.status);
  }

  private targetDirForVersion(version: string) {
    return path.join(appConfig.jdksDir, `temurin-${version}`);
  }

  private executableForVersion(version: string) {
    const targetDir = this.targetDirForVersion(version);
    return process.platform === "win32"
      ? path.join(targetDir, "bin", "java.exe")
      : path.join(targetDir, "bin", "java");
  }

  private versionFromDirName(name: string) {
    return name.startsWith("temurin-") ? name.slice("temurin-".length) : name;
  }
}
