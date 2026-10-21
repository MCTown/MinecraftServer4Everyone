import path from "node:path";
import { createAskUserTool } from "./tools/askUserTool.js";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { fetch } from "undici";
import { appConfig } from "../config.js";
import { createDownloadHttpsFileToServerTool } from "./tools/downloadHttpsFileTool.js";
import { createInstallJavaVersionTool } from "./tools/javaDownloadTool.js";
import { createConfigureBuiltinPythonTool, createInstallMcdrPluginDependenciesTool } from "./tools/pythonRuntimeTool.js";
import { createWebSearchTool } from "./tools/webSearchTool.js";
import { createFetchWebPageTool } from "./tools/fetchWebPageTool.js";
import { createRunShellCommandTool } from "./tools/shellTool.js";
import { createDeployMrpackServerTool, createInspectMrpackServerTool } from "./tools/mrpackDeploymentTool.js";
import { resolveForgeFamilyInstaller, type ForgeFamilyLoader } from "./tools/forgeFamilyInstaller.js";
import { createDisableClientOnlyServerModsTool, createDisableServerModsTool, createInspectClientOnlyServerModsTool } from "./tools/clientOnlyModsTool.js";
import { createGlobalAgentTools } from "./tools/globalTools.js";
import { booleanInput, installableCapabilities, isAbortError, objectSchema, requireConfirmation, safeDownloadName, stringArrayInput, stringInput, stringProperty, type AgentCapabilityId, type AgentTool, type AgentToolContext } from "./toolKit.js";
import { createId } from "../utils/id.js";
import type { AgentDownloadProgress } from "../types.js";
import type { CurseForgeManifestSlotInfo } from "../services/fileService.js";
import { fetchDispatcher, isJavaExecutable, javaProxyArgs, proxyEnv } from "../services/proxySupport.js";
import { defaultDeploymentWorkflow } from "../services/deploymentWorkflow.js";
import { buildWorkflowProgress } from "./workflowProgress.js";

export type { AgentCapabilityId, AgentTool } from "./toolKit.js";

const agentReadTextMaxChars = 120000;

function emitWorkflowProgress(ctx: AgentToolContext, stepId: string, status: "pending" | "running" | "completed" | "failed", progress: number, detail: string, title = "整合包服务端部署流程") {
  const workflow = ctx.getDeploymentWorkflow?.() ?? defaultDeploymentWorkflow();
  // Existing-file repair tools may run outside a deployment, or a custom stage.
  if (!workflow.steps.some((step) => step.id === stepId && step.enabled)) return;
  ctx.workflowProgress?.(buildWorkflowProgress(workflow, ctx.getWorkflowProgress?.(), { stepId, status, progress, detail, title }));
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

function parsePositiveInteger(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed));
  }
  return 0;
}

function optionalStringChanges(input: Record<string, unknown>, keys: string[]) {
  const changes: Record<string, string> = {};
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string") changes[key] = value;
  }
  return changes;
}

async function fetchJson(url: string, signal?: AbortSignal, proxyUrl?: string, headers: Record<string, string> = {}) {
  const response = await fetch(url, { headers: { "user-agent": "MinecraftServerAgent/0.1", ...headers }, signal, dispatcher: fetchDispatcher(proxyUrl) });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Response is not JSON: ${text.slice(0, 300)}`);
  }
}

type JsonRecord = Record<string, unknown>;

interface ServerPackageCandidate {
  provider: "curseforge" | "modrinth";
  projectId: string;
  projectSlug?: string;
  projectName: string;
  versionId?: string;
  versionName?: string;
  versionNumber?: string;
  fileId?: string;
  fileName: string;
  downloadUrl: string;
  gameVersions: string[];
  loaders: string[];
  releaseType?: string;
  isServerCandidate: boolean;
  reason: string;
}

interface ModJarCandidate {
  provider: "curseforge" | "modrinth";
  projectId: string;
  projectSlug?: string;
  projectName: string;
  versionId?: string;
  versionName?: string;
  versionNumber?: string;
  fileId?: string;
  fileName: string;
  downloadUrl: string;
  gameVersions: string[];
  loaders: string[];
  releaseType?: string;
  primary: boolean;
  reason: string;
}

const curseForgeApiKeyUrl = "https://console.curseforge.com/?#/api-keys";
const modrinthPatUrl = "https://modrinth.com/settings/pats";

function emitToolConfigRequired(ctx: AgentToolContext, requirement: { key: "curseForgeApiKey" | "modrinthApiKey"; label: string; toolName?: string; helpUrl: string; message: string }) {
  ctx.toolConfigRequired?.(requirement);
}

function requireCurseForgeApiKey(ctx: AgentToolContext, toolName?: string) {
  const key = (ctx.getCurseForgeApiKey?.() || appConfig.curseForgeApiKey).trim();
  if (!key) {
    const message = `CurseForge API Key 未配置。请点击 Tools 卡片或设置中的配置按钮填写 API Key。申请/管理地址：${curseForgeApiKeyUrl}。`;
    emitToolConfigRequired(ctx, { key: "curseForgeApiKey", label: "CurseForge API Key", toolName, helpUrl: curseForgeApiKeyUrl, message });
    throw new Error(message);
  }
  return key;
}

function optionalModrinthHeaders(ctx: AgentToolContext): Record<string, string> {
  const token = (ctx.getModrinthApiKey?.() || appConfig.modrinthApiKey).trim();
  return token ? { Authorization: token } : {};
}

function stringField(value: unknown) {
  return typeof value === "string" ? value : "";
}

function numberField(value: unknown) {
  return typeof value === "number" ? value : Number(value) || 0;
}

function stringArrayField(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function recordArrayField(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is JsonRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function matchesWanted(value: string, wanted: string) {
  return !wanted || value.toLowerCase() === wanted.toLowerCase();
}

function fileServerScore(fileName: string, fileType?: unknown) {
  const lower = fileName.toLowerCase();
  let score = 0;
  if (lower.endsWith(".zip")) score += 40;
  if (/server[-_ ]?pack|server[-_ ]?files|serverfiles|server/.test(lower)) score += 70;
  if (/client|launcher|shader|resourcepack|resource[-_ ]?pack/.test(lower)) score -= 80;
  if (typeof fileType === "number" && fileType === 2) score += 100;
  return score;
}

function forgeCdnUrl(fileId: string | number, fileName: string) {
  const id = String(fileId);
  if (id.length <= 3) return "";
  return `https://mediafilez.forgecdn.net/files/${id.slice(0, -3)}/${id.slice(-3)}/${encodeURIComponent(fileName)}`;
}

function normalizeCurseForgeDownloadUrl(value: string, fileId: string | number, fileName: string) {
  if (value) return value.replace(/ /g, "%20");
  return forgeCdnUrl(fileId, fileName);
}

function pickBestCandidate(candidates: ServerPackageCandidate[], allowFallback: boolean) {
  const serverCandidates = candidates.filter((candidate) => candidate.isServerCandidate);
  if (serverCandidates.length > 0) return serverCandidates[0];
  return allowFallback ? candidates[0] : undefined;
}

function candidateSummary(candidates: ServerPackageCandidate[]) {
  return candidates.map((candidate) => ({
    provider: candidate.provider,
    projectId: candidate.projectId,
    projectSlug: candidate.projectSlug,
    projectName: candidate.projectName,
    versionId: candidate.versionId,
    versionName: candidate.versionName,
    versionNumber: candidate.versionNumber,
    fileId: candidate.fileId,
    fileName: candidate.fileName,
    gameVersions: candidate.gameVersions,
    loaders: candidate.loaders,
    releaseType: candidate.releaseType,
    isServerCandidate: candidate.isServerCandidate,
    reason: candidate.reason,
    downloadUrl: candidate.downloadUrl
  }));
}

function modCandidateSummary(candidates: ModJarCandidate[]) {
  return candidates.map((candidate) => ({
    provider: candidate.provider,
    projectId: candidate.projectId,
    projectSlug: candidate.projectSlug,
    projectName: candidate.projectName,
    versionId: candidate.versionId,
    versionName: candidate.versionName,
    versionNumber: candidate.versionNumber,
    fileId: candidate.fileId,
    fileName: candidate.fileName,
    gameVersions: candidate.gameVersions,
    loaders: candidate.loaders,
    releaseType: candidate.releaseType,
    primary: candidate.primary,
    reason: candidate.reason,
    downloadUrl: candidate.downloadUrl
  }));
}

async function downloadCandidateToServerSlot(ctx: AgentToolContext, candidate: ServerPackageCandidate, title: string) {
  const downloadId = createId("download");
  const emitProgress = (progress: Omit<AgentDownloadProgress, "id" | "url" | "fileName" | "destinationPath">) => {
    ctx.progress?.({ id: downloadId, url: candidate.downloadUrl, fileName: candidate.fileName, destinationPath: "server_slots/current", ...progress });
  };
  await requireConfirmation(ctx, {
    title,
    description: `Agent 准备下载 ${candidate.provider} 服务端包 ${candidate.fileName} 到当前服务端槽位。来源：${candidate.downloadUrl}`,
    risk: "high"
  });
  emitProgress({ loadedBytes: 0, totalBytes: null, percent: 0, status: "starting" });
  try {
    const status = await ctx.fileService.downloadIntoServerSlot(ctx.getServerId(), candidate.downloadUrl, {
      signal: ctx.signal,
      proxyUrl: ctx.downloadProxyUrl?.(),
      onProgress: (progress) => emitProgress({ ...progress, status: progress.percent >= 100 ? "completed" : "downloading" })
    });
    ctx.serverSlotStatus?.(status);
    return { candidate, slotStatus: status };
  } catch (error) {
    emitProgress({ loadedBytes: 0, totalBytes: null, percent: 0, status: isAbortError(error) ? "cancelled" : "failed", error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

async function downloadModCandidateToMods(ctx: AgentToolContext, candidate: ModJarCandidate) {
  if (!candidate.fileName.toLowerCase().endsWith(".jar")) {
    throw new Error(`只能下载 .jar 模组文件，拒绝下载：${candidate.fileName}`);
  }
  const destinationPath = path.join("server", "mods", path.basename(candidate.fileName).replace(/[<>:"/\\|?*]/g, "_") || "mod.jar");
  const downloadId = createId("download");
  const emitProgress = (progress: Omit<AgentDownloadProgress, "id" | "url" | "fileName" | "destinationPath">) => {
    ctx.progress?.({ id: downloadId, url: candidate.downloadUrl, fileName: candidate.fileName, destinationPath, ...progress });
  };
  await requireConfirmation(ctx, {
    title: "下载模组到 server/mods",
    description: `Agent 准备从 ${candidate.provider} 下载模组 ${candidate.fileName} 到当前服务端的 ${destinationPath}。来源：${candidate.downloadUrl}`,
    risk: "high"
  });
  emitProgress({ loadedBytes: 0, totalBytes: null, percent: 0, status: "starting" });
  try {
    const savedPath = await ctx.fileService.downloadIntoServer(ctx.getServerId(), candidate.downloadUrl, destinationPath, {
      signal: ctx.signal,
      proxyUrl: ctx.downloadProxyUrl?.(),
      onProgress: (progress) => emitProgress({ ...progress, status: progress.percent >= 100 ? "completed" : "downloading" })
    });
    return { candidate, destinationPath: savedPath };
  } catch (error) {
    emitProgress({ loadedBytes: 0, totalBytes: null, percent: 0, status: isAbortError(error) ? "cancelled" : "failed", error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

function curseForgeModLoaderType(loader: string) {
  switch (loader.toLowerCase()) {
    case "forge":
      return "1";
    case "fabric":
      return "4";
    case "quilt":
      return "5";
    case "neoforge":
    case "neo-forge":
      return "6";
    default:
      return "";
  }
}

function curseForgeLoaderName(loaderType: number) {
  switch (loaderType) {
    case 1:
      return "forge";
    case 4:
      return "fabric";
    case 5:
      return "quilt";
    case 6:
      return "neoforge";
    default:
      return "";
  }
}

function modJarScore(fileName: string, primary: boolean) {
  const lower = fileName.toLowerCase();
  let score = 0;
  if (lower.endsWith(".jar")) score += 100;
  if (primary) score += 20;
  if (/sources|source|dev|deobf|javadoc|api|slim|all\b/.test(lower)) score -= 60;
  if (/fabric|forge|quilt|neoforge/.test(lower)) score += 5;
  if (lower.endsWith(".mrpack") || lower.endsWith(".zip")) score -= 200;
  return score;
}

function pickBestModCandidate(candidates: ModJarCandidate[]) {
  return candidates
    .filter((candidate) => candidate.fileName.toLowerCase().endsWith(".jar") && candidate.downloadUrl)
    .sort((first, second) => modJarScore(second.fileName, second.primary) - modJarScore(first.fileName, first.primary))[0];
}

async function fetchCurseForgeJson(ctx: AgentToolContext, pathname: string, params: Record<string, string | number | undefined> = {}, toolName?: string) {
  const apiKey = requireCurseForgeApiKey(ctx, toolName);
  const url = new URL(`https://api.curseforge.com/v1${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  try {
    return await fetchJson(url.toString(), ctx.signal, ctx.downloadProxyUrl?.(), { "x-api-key": apiKey });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/HTTP\s+(401|403)\b/.test(message)) {
      const configMessage = `CurseForge API 鉴权失败或需要 API Key。请点击 Tools 卡片或设置中的配置按钮更新 CurseForge API Key。申请/管理地址：${curseForgeApiKeyUrl}。原始错误：${message}`;
      emitToolConfigRequired(ctx, { key: "curseForgeApiKey", label: "CurseForge API Key", toolName, helpUrl: curseForgeApiKeyUrl, message: configMessage });
      throw new Error(configMessage);
    }
    throw error;
  }
}

async function fetchCurseForgeDownloadUrl(ctx: AgentToolContext, modId: string, fileId: string, fileName: string, currentUrl: string, toolName?: string) {
  if (currentUrl) return currentUrl.replace(/ /g, "%20");
  const apiKey = requireCurseForgeApiKey(ctx, toolName);
  const url = `https://api.curseforge.com/v1/mods/${encodeURIComponent(modId)}/files/${encodeURIComponent(fileId)}/download-url`;
  const fallbackUrl = forgeCdnUrl(fileId, fileName);
  try {
    const response = await fetch(url, { headers: { "user-agent": "MinecraftServerAgent/0.1", "x-api-key": apiKey }, signal: ctx.signal, dispatcher: fetchDispatcher(ctx.downloadProxyUrl?.()) });
    const text = await response.text();
    if (!response.ok) return fallbackUrl;
    try {
      const parsed = JSON.parse(text) as JsonRecord;
      const data = parsed.data;
      return (typeof data === "string" && data ? data : fallbackUrl).replace(/ /g, "%20");
    } catch {
      const trimmed = text.trim().replace(/^"|"$/g, "");
      return (trimmed || fallbackUrl).replace(/ /g, "%20");
    }
  } catch {
    return fallbackUrl;
  }
}

interface CurseForgeManifestMod {
  projectId: string;
  fileId: string;
  fileName: string;
  projectName: string;
  downloadUrl: string;
}

function manifestSummary(manifest: CurseForgeManifestSlotInfo) {
  return {
    name: manifest.name,
    version: manifest.version,
    minecraftVersion: manifest.minecraftVersion,
    loaders: manifest.loaders,
    requiredModCount: manifest.files.filter((file) => file.required).length,
    optionalModCount: manifest.files.filter((file) => !file.required).length,
    overridesPath: manifest.overridesPath,
    slotFileName: manifest.slot.fileName
  };
}

function manifestForgeFamilyLoader(manifest: CurseForgeManifestSlotInfo) {
  // FileService orders the primary loader first. Do not install a secondary loader instead.
  const match = /^(forge|neoforge|neo-forge)-(.+)$/i.exec(manifest.loaders[0] ?? "");
  if (!match) return null;
  const type: ForgeFamilyLoader = match[1]!.toLowerCase() === "forge" ? "forge" : "neoforge";
  return { type, name: type === "forge" ? "Forge" : "NeoForge", ...resolveForgeFamilyInstaller(type, manifest.minecraftVersion, match[2]!.trim()) };
}

async function preflightCurseForgeManifestMods(ctx: AgentToolContext, manifest: CurseForgeManifestSlotInfo) {
  const requiredFiles = manifest.files.filter((file) => file.required);
  const mods: CurseForgeManifestMod[] = [];
  const seenNames = new Set<string>();
  for (const entry of requiredFiles) {
    const response = await fetchCurseForgeJson(ctx, `/mods/${entry.projectId}/files/${entry.fileId}`, {}, "install_curseforge_manifest_pack_from_server_slot") as JsonRecord;
    const file = response.data;
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      throw new Error(`CurseForge 未返回清单模组 ${entry.projectId}/${entry.fileId} 的文件信息`);
    }
    const fileRecord = file as JsonRecord;
    const fileName = path.basename(stringField(fileRecord.fileName) || stringField(fileRecord.displayName));
    if (!fileName.toLowerCase().endsWith(".jar")) {
      throw new Error(`清单模组 ${entry.projectId}/${entry.fileId} 不是 .jar 文件：${fileName || "未知文件名"}`);
    }
    const safeFileName = fileName.replace(/[<>:"/\\|?*]/g, "_");
    if (seenNames.has(safeFileName.toLowerCase())) {
      throw new Error(`清单中存在会写入同一文件名的模组：${safeFileName}`);
    }
    seenNames.add(safeFileName.toLowerCase());
    mods.push({
      projectId: entry.projectId,
      fileId: entry.fileId,
      fileName: safeFileName,
      projectName: stringField(fileRecord.displayName) || entry.projectId,
      downloadUrl: normalizeCurseForgeDownloadUrl(
        await fetchCurseForgeDownloadUrl(ctx, entry.projectId, entry.fileId, safeFileName, stringField(fileRecord.downloadUrl), "install_curseforge_manifest_pack_from_server_slot"),
        entry.fileId,
        safeFileName
      )
    });
  }
  return mods;
}

async function downloadCurseForgeManifestMods(ctx: AgentToolContext, mods: CurseForgeManifestMod[]) {
  const server = await ctx.serverService.requireServer(ctx.getServerId());
  const paths = mods.map((mod) => path.join("server", "mods", mod.fileName));
  for (const destinationPath of paths) {
    if (await pathExists(path.join(server.directory, destinationPath))) {
      throw new Error(`目标文件已存在，拒绝覆盖：${destinationPath}`);
    }
  }

  const downloadedPaths: string[] = [];
  for (const [index, mod] of mods.entries()) {
    const destinationPath = path.join("server", "mods", mod.fileName);
    const downloadId = createId("download");
    const emitProgress = (progress: Omit<AgentDownloadProgress, "id" | "url" | "fileName" | "destinationPath">) => {
      ctx.progress?.({ id: downloadId, url: mod.downloadUrl, fileName: mod.fileName, destinationPath, ...progress });
    };
    emitProgress({ loadedBytes: 0, totalBytes: null, percent: 0, status: "starting" });
    try {
      downloadedPaths.push(await ctx.fileService.downloadIntoServer(ctx.getServerId(), mod.downloadUrl, destinationPath, {
        signal: ctx.signal,
        proxyUrl: ctx.downloadProxyUrl?.(),
        onProgress: (progress) => emitProgress({ ...progress, status: progress.percent >= 100 ? "completed" : "downloading" })
      }));
      emitWorkflowProgress(ctx, "extract_to_workspace", "running", ((index + 1) / Math.max(mods.length, 1)) * 100, `正在下载模组 ${index + 1}/${mods.length}: ${mod.fileName}`, "CurseForge 清单包还原");
    } catch (error) {
      emitProgress({ loadedBytes: 0, totalBytes: null, percent: 0, status: isAbortError(error) ? "cancelled" : "failed", error: error instanceof Error ? error.message : String(error) });
      throw new Error(`下载清单模组 ${index + 1}/${mods.length} 失败；已成功下载 ${downloadedPaths.length} 个模组。${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return downloadedPaths;
}

function normalizeCurseForgeSearchText(value: string) {
  return value
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/\b3rd\b/g, "third")
    .replace(/\b2nd\b/g, "second")
    .replace(/\b1st\b/g, "first")
    .replace(/\bed\.\b/g, "edition")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function curseForgeSearchTokens(value: string) {
  return normalizeCurseForgeSearchText(value).split(" ").filter((token) => token.length > 1);
}

function isCurseForgeSlugCandidate(value: string) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(value.trim());
}

function extractCurseForgeSlugHint(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const urlMatch = trimmed.match(/curseforge\.com\/minecraft\/(?:modpacks|mc-mods|mods)\/([a-z0-9-]+)/i);
  if (urlMatch?.[1]) return urlMatch[1].toLowerCase();
  if (isCurseForgeSlugCandidate(trimmed)) return trimmed.toLowerCase();
  return "";
}

function scoreCurseForgeProject(project: JsonRecord, searchQuery: string) {
  const normalizedQuery = normalizeCurseForgeSearchText(searchQuery);
  const queryTokens = curseForgeSearchTokens(searchQuery);
  const slug = stringField(project.slug).toLowerCase();
  const name = stringField(project.name);
  const normalizedName = normalizeCurseForgeSearchText(name);
  const normalizedSlug = normalizeCurseForgeSearchText(slug.replace(/-/g, " "));
  const downloadCount = numberField(project.downloadCount);
  let score = Math.log10(Math.max(downloadCount, 1)) * 8;

  if (slug === searchQuery.trim().toLowerCase()) score += 1000;
  if (normalizedName === normalizedQuery || normalizedSlug === normalizedQuery) score += 500;
  if (normalizedName.includes(normalizedQuery) && normalizedQuery.length >= 6) score += 200;
  if (normalizedSlug.includes(normalizedQuery) && normalizedQuery.length >= 6) score += 180;
  if (normalizedQuery && (normalizedName.startsWith(normalizedQuery) || normalizedSlug.startsWith(normalizedQuery))) score += 80;

  const nameTokens = new Set([...curseForgeSearchTokens(name), ...curseForgeSearchTokens(slug.replace(/-/g, " "))]);
  let matched = 0;
  for (const token of queryTokens) {
    if (nameTokens.has(token)) matched += 1;
    else if ([...nameTokens].some((nameToken) => nameToken.includes(token) || token.includes(nameToken))) matched += 0.5;
  }
  if (queryTokens.length > 0) {
    score += (matched / queryTokens.length) * 220;
    if (matched === 0) score -= 120;
  }

  // Prefer official-looking titles over fan packs that merely mention the target.
  if (/\bofficial\b/.test(normalizedName) && /\bofficial\b/.test(normalizedQuery)) score += 40;
  if (/\b(based on|remastered|smp|plus|legacy|remix|unofficial)\b/.test(normalizedName) && !/\b(based on|remastered|smp|plus|legacy|remix|unofficial)\b/.test(normalizedQuery)) {
    score -= 60;
  }

  return score;
}

function pickBestCurseForgeProject(projects: JsonRecord[], searchQuery: string) {
  if (projects.length === 0) return undefined;
  const normalizedQuery = normalizeCurseForgeSearchText(searchQuery);
  const exactSlug = projects.find((project) => stringField(project.slug).toLowerCase() === searchQuery.trim().toLowerCase());
  if (exactSlug) return exactSlug;

  const exactName = projects.find((project) => normalizeCurseForgeSearchText(stringField(project.name)) === normalizedQuery);
  if (exactName) return exactName;

  return [...projects].sort((first, second) => scoreCurseForgeProject(second, searchQuery) - scoreCurseForgeProject(first, searchQuery))[0];
}

function curseForgeSearchVariants(searchQuery: string) {
  const variants = new Set<string>();
  const trimmed = searchQuery.trim();
  if (trimmed) variants.add(trimmed);

  const normalized = normalizeCurseForgeSearchText(trimmed);
  if (normalized) variants.add(normalized);

  const withoutEditionNoise = normalized
    .replace(/\b(minecraft|modpack|mod pack|official pack|official modpack|official)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (withoutEditionNoise) variants.add(withoutEditionNoise);

  // Prefer hyphenated slug-style queries when the normalized text is multi-token.
  const slugStyle = withoutEditionNoise.replace(/\s+/g, "-");
  if (slugStyle.includes("-")) variants.add(slugStyle);

  return [...variants];
}

async function resolveCurseForgeProject(ctx: AgentToolContext, rawProjectId: string, query: string, classId = 4471, toolName = "download_curseforge_server_pack_to_server_slot") {
  const directId = /^\d+$/.test(rawProjectId) ? rawProjectId : "";
  if (directId) {
    const response = await fetchCurseForgeJson(ctx, `/mods/${directId}`, {}, toolName) as JsonRecord;
    const data = response.data;
    if (data && typeof data === "object" && !Array.isArray(data)) return data as JsonRecord;
  }

  const slugHint = extractCurseForgeSlugHint(rawProjectId) || extractCurseForgeSlugHint(query);
  if (slugHint) {
    const bySlug = await fetchCurseForgeJson(ctx, "/mods/search", {
      gameId: 432,
      classId,
      slug: slugHint,
      pageSize: 5
    }, toolName) as JsonRecord;
    const slugProjects = recordArrayField(bySlug.data);
    const exact = slugProjects.find((project) => stringField(project.slug).toLowerCase() === slugHint) ?? slugProjects[0];
    if (exact) return exact;
  }

  const searchQuery = query || rawProjectId;
  if (!searchQuery) throw new Error("缺少 CurseForge 搜索关键词或 projectId");

  const seen = new Set<string>();
  const projects: JsonRecord[] = [];
  for (const variant of curseForgeSearchVariants(searchQuery)) {
    const response = await fetchCurseForgeJson(ctx, "/mods/search", {
      gameId: 432,
      classId,
      searchFilter: variant,
      sortField: 6,
      sortOrder: "desc",
      pageSize: 20
    }, toolName) as JsonRecord;
    for (const project of recordArrayField(response.data)) {
      const id = String(numberField(project.id) || stringField(project.id) || stringField(project.slug));
      if (!id || seen.has(id)) continue;
      seen.add(id);
      projects.push(project);
    }
  }

  const selected = pickBestCurseForgeProject(projects, searchQuery);
  if (!selected) {
    throw new Error(`CurseForge 未找到项目：${searchQuery}。请改用英文整合包名、CurseForge slug（如 vault-hunters-1-18-2）、数字 projectId，或完整 CurseForge 项目/文件 URL。`);
  }
  return selected;
}

async function curseForgeFileCandidate(ctx: AgentToolContext, project: JsonRecord, file: JsonRecord) {
  const projectId = String(numberField(project.id) || stringField(project.id));
  const fileId = String(numberField(file.id) || stringField(file.id));
  const fileName = stringField(file.fileName) || stringField(file.displayName) || `${fileId}.zip`;
  const downloadUrl = normalizeCurseForgeDownloadUrl(
    await fetchCurseForgeDownloadUrl(ctx, projectId, fileId, fileName, stringField(file.downloadUrl), "download_curseforge_server_pack_to_server_slot"),
    fileId,
    fileName
  );
  const gameVersions = stringArrayField(file.gameVersions);
  const loaders = gameVersions.filter((version) => ["forge", "fabric", "quilt", "neoforge"].includes(version.toLowerCase()));
  const score = fileServerScore(fileName, file.isServerPack === true ? 2 : undefined);
  return {
    provider: "curseforge" as const,
    projectId,
    projectSlug: stringField(project.slug),
    projectName: stringField(project.name) || projectId,
    versionId: fileId,
    versionName: stringField(file.displayName),
    fileId,
    fileName,
    downloadUrl,
    gameVersions,
    loaders,
    releaseType: String(numberField(file.releaseType) || ""),
    isServerCandidate: Boolean(downloadUrl) && score >= 50,
    reason: file.isServerPack === true ? "CurseForge file metadata marks this file as a server pack" : `filename server score=${score}`
  } satisfies ServerPackageCandidate;
}

function extractCurseForgeFileIdHint(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const fileMatch = trimmed.match(/curseforge\.com\/minecraft\/(?:modpacks|mc-mods|mods)\/[a-z0-9-]+\/files\/(\d+)/i)
    || trimmed.match(/\/files\/(\d+)(?:\/|$)/i);
  return fileMatch?.[1] || "";
}

async function findCurseForgeServerPackage(ctx: AgentToolContext, input: Record<string, unknown>) {
  const query = stringInput(input, "query");
  const rawProjectId = stringInput(input, "projectId") || stringInput(input, "projectIdOrSlug");
  const fileId = stringInput(input, "fileId") || extractCurseForgeFileIdHint(query) || extractCurseForgeFileIdHint(rawProjectId);
  const minecraftVersion = stringInput(input, "minecraftVersion");
  const loader = stringInput(input, "loader");
  const modpackVersion = stringInput(input, "modpackVersion");
  const allowFallbackFile = booleanInput(input, "allowFallbackFile");
  const project = await resolveCurseForgeProject(ctx, rawProjectId, query);
  const projectId = String(numberField(project.id) || stringField(project.id));
  const wantedLoaderType = curseForgeModLoaderType(loader);

  const rawFiles: JsonRecord[] = [];
  if (fileId) {
    const response = await fetchCurseForgeJson(ctx, `/mods/${projectId}/files/${fileId}`, {}, "download_curseforge_server_pack_to_server_slot") as JsonRecord;
    const data = response.data;
    if (data && typeof data === "object" && !Array.isArray(data)) rawFiles.push(data as JsonRecord);
  } else {
    const response = await fetchCurseForgeJson(ctx, `/mods/${projectId}/files`, {
      gameVersion: minecraftVersion,
      modLoaderType: wantedLoaderType,
      pageSize: 50
    }, "download_curseforge_server_pack_to_server_slot") as JsonRecord;
    rawFiles.push(...recordArrayField(response.data));
  }

  const serverPackIds = [...new Set(rawFiles.map((file) => numberField(file.serverPackFileId)).filter((id) => id > 0))];
  for (const serverPackId of serverPackIds.slice(0, 8)) {
    const response = await fetchCurseForgeJson(ctx, `/mods/${projectId}/files/${serverPackId}`, {}, "download_curseforge_server_pack_to_server_slot") as JsonRecord;
    const data = response.data;
    if (data && typeof data === "object" && !Array.isArray(data)) rawFiles.unshift(data as JsonRecord);
  }

  const filteredFiles = rawFiles.filter((file) => {
    const fileName = stringField(file.fileName) || stringField(file.displayName);
    if (!fileName) return false;
    const versions = stringArrayField(file.gameVersions);
    if (minecraftVersion && !versions.some((version) => matchesWanted(version, minecraftVersion))) return false;
    if (loader && wantedLoaderType && !versions.some((version) => matchesWanted(version, loader))) return false;
    if (modpackVersion) {
      const versionText = `${stringField(file.displayName)} ${fileName}`.toLowerCase();
      if (!versionText.includes(modpackVersion.toLowerCase())) return false;
    }
    return true;
  });

  const candidates = await Promise.all(filteredFiles.map((file) => curseForgeFileCandidate(ctx, project, file)));
  candidates.sort((first, second) => Number(second.isServerCandidate) - Number(first.isServerCandidate) || fileServerScore(second.fileName) - fileServerScore(first.fileName));
  const selected = pickBestCandidate(candidates, allowFallbackFile);
  if (!selected) {
    throw new Error(`CurseForge API 已可访问，但没有找到可直接部署的服务端包。候选文件：${JSON.stringify(candidateSummary(candidates).slice(0, 10), null, 2)}`);
  }
  return { selected, candidates };
}

async function fetchModrinthJson(ctx: AgentToolContext, url: string, toolName?: string) {
  try {
    return await fetchJson(url, ctx.signal, ctx.downloadProxyUrl?.(), optionalModrinthHeaders(ctx));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/HTTP\s+(401|403)\b/.test(message) && !(ctx.getModrinthApiKey?.() || appConfig.modrinthApiKey).trim()) {
      const configMessage = `Modrinth 公开 API 请求被拒绝，可能需要 Personal Access Token。请点击 Tools 卡片或设置中的配置按钮填写 Modrinth PAT。申请/管理地址：${modrinthPatUrl}。原始错误：${message}`;
      emitToolConfigRequired(ctx, { key: "modrinthApiKey", label: "Modrinth Personal Access Token", toolName, helpUrl: modrinthPatUrl, message: configMessage });
      throw new Error(configMessage);
    }
    throw error;
  }
}

async function resolveModrinthProject(ctx: AgentToolContext, projectIdOrSlug: string, query: string, projectType = "modpack", toolName = "download_modrinth_server_pack_to_server_slot") {
  if (projectIdOrSlug) {
    const project = await fetchModrinthJson(ctx, `https://api.modrinth.com/v2/project/${encodeURIComponent(projectIdOrSlug)}`, toolName) as JsonRecord;
    return project;
  }
  if (!query) throw new Error("缺少 Modrinth 搜索关键词或 projectIdOrSlug");
  const url = new URL("https://api.modrinth.com/v2/search");
  url.searchParams.set("query", query);
  url.searchParams.set("facets", JSON.stringify([[`project_type:${projectType}`]]));
  url.searchParams.set("limit", "10");
  const response = await fetchModrinthJson(ctx, url.toString(), toolName) as JsonRecord;
  const hits = recordArrayField(response.hits);
  const normalized = query.toLowerCase();
  const selected = hits.find((project) => stringField(project.slug).toLowerCase() === normalized)
    ?? hits.find((project) => stringField(project.title).toLowerCase().includes(normalized))
    ?? hits[0];
  if (!selected) throw new Error(`Modrinth 未找到项目：${query}`);
  return selected;
}

async function curseForgeModCandidate(ctx: AgentToolContext, project: JsonRecord, file: JsonRecord) {
  const projectId = String(numberField(project.id) || stringField(project.id));
  const fileId = String(numberField(file.id) || stringField(file.id));
  const fileName = stringField(file.fileName) || stringField(file.displayName) || `${fileId}.jar`;
  const downloadUrl = normalizeCurseForgeDownloadUrl(
    await fetchCurseForgeDownloadUrl(ctx, projectId, fileId, fileName, stringField(file.downloadUrl), "download_mod_to_server_mods"),
    fileId,
    fileName
  );
  const gameVersions = stringArrayField(file.gameVersions);
  const sortableGameVersions = recordArrayField(file.sortableGameVersions);
  const loaders = [
    ...gameVersions.filter((version) => ["forge", "fabric", "quilt", "neoforge"].includes(version.toLowerCase())),
    ...sortableGameVersions.map((version) => curseForgeLoaderName(numberField(version.gameVersionTypeId))).filter(Boolean)
  ];
  const primary = file.isServerPack !== true;
  return {
    provider: "curseforge" as const,
    projectId,
    projectSlug: stringField(project.slug),
    projectName: stringField(project.name) || projectId,
    versionId: fileId,
    versionName: stringField(file.displayName),
    fileId,
    fileName,
    downloadUrl,
    gameVersions,
    loaders: [...new Set(loaders)],
    releaseType: String(numberField(file.releaseType) || ""),
    primary,
    reason: `jar score=${modJarScore(fileName, primary)}`
  } satisfies ModJarCandidate;
}

async function findCurseForgeModJar(ctx: AgentToolContext, input: Record<string, unknown>) {
  const query = stringInput(input, "query");
  const rawProjectId = stringInput(input, "projectId") || stringInput(input, "projectIdOrSlug");
  const fileId = stringInput(input, "fileId");
  const minecraftVersion = stringInput(input, "minecraftVersion");
  const loader = stringInput(input, "loader");
  const modVersion = stringInput(input, "modVersion");
  const project = await resolveCurseForgeProject(ctx, rawProjectId, query, 6, "download_mod_to_server_mods");
  const projectId = String(numberField(project.id) || stringField(project.id));
  const wantedLoaderType = curseForgeModLoaderType(loader);

  const rawFiles: JsonRecord[] = [];
  if (fileId) {
    const response = await fetchCurseForgeJson(ctx, `/mods/${projectId}/files/${fileId}`, {}, "download_mod_to_server_mods") as JsonRecord;
    const data = response.data;
    if (data && typeof data === "object" && !Array.isArray(data)) rawFiles.push(data as JsonRecord);
  } else {
    const response = await fetchCurseForgeJson(ctx, `/mods/${projectId}/files`, {
      gameVersion: minecraftVersion,
      modLoaderType: wantedLoaderType,
      pageSize: 50
    }, "download_mod_to_server_mods") as JsonRecord;
    rawFiles.push(...recordArrayField(response.data));
  }

  const filteredFiles = rawFiles.filter((file) => {
    const fileName = stringField(file.fileName) || stringField(file.displayName);
    if (!fileName || !fileName.toLowerCase().endsWith(".jar")) return false;
    const versions = stringArrayField(file.gameVersions);
    if (minecraftVersion && !versions.some((version) => matchesWanted(version, minecraftVersion))) return false;
    if (loader && wantedLoaderType && !versions.some((version) => matchesWanted(version, loader))) {
      const sortableVersions = recordArrayField(file.sortableGameVersions);
      if (!sortableVersions.some((version) => curseForgeLoaderName(numberField(version.gameVersionTypeId)) === loader.toLowerCase())) return false;
    }
    if (modVersion) {
      const versionText = `${stringField(file.displayName)} ${fileName}`.toLowerCase();
      if (!versionText.includes(modVersion.toLowerCase())) return false;
    }
    return true;
  });

  const candidates = await Promise.all(filteredFiles.map((file) => curseForgeModCandidate(ctx, project, file)));
  const selected = pickBestModCandidate(candidates);
  if (!selected) {
    throw new Error(`CurseForge API 已可访问，但没有找到可下载的 .jar 模组文件。候选文件：${JSON.stringify(modCandidateSummary(candidates).slice(0, 10), null, 2)}`);
  }
  return { selected, candidates };
}

async function findModrinthServerPackage(ctx: AgentToolContext, input: Record<string, unknown>) {
  const query = stringInput(input, "query");
  const projectIdOrSlug = stringInput(input, "projectIdOrSlug") || stringInput(input, "projectId");
  const versionId = stringInput(input, "versionId");
  const minecraftVersion = stringInput(input, "minecraftVersion");
  const loader = stringInput(input, "loader");
  const modpackVersion = stringInput(input, "modpackVersion");
  const allowMrpackFallback = booleanInput(input, "allowMrpackFallback");
  const project = await resolveModrinthProject(ctx, projectIdOrSlug, query);
  const projectId = stringField(project.project_id) || stringField(project.id) || projectIdOrSlug;
  const projectSlug = stringField(project.slug);
  const projectName = stringField(project.title) || stringField(project.name) || projectId;

  let versions: JsonRecord[];
  if (versionId) {
    versions = [await fetchModrinthJson(ctx, `https://api.modrinth.com/v2/version/${encodeURIComponent(versionId)}`, "download_modrinth_server_pack_to_server_slot") as JsonRecord];
  } else {
    const url = new URL(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId || projectSlug)}/version`);
    if (loader) url.searchParams.set("loaders", JSON.stringify([loader.toLowerCase()]));
    if (minecraftVersion) url.searchParams.set("game_versions", JSON.stringify([minecraftVersion]));
    versions = recordArrayField(await fetchModrinthJson(ctx, url.toString(), "download_modrinth_server_pack_to_server_slot"));
  }

  const filteredVersions = versions.filter((version) => {
    if (minecraftVersion && !stringArrayField(version.game_versions).some((item) => matchesWanted(item, minecraftVersion))) return false;
    if (loader && !stringArrayField(version.loaders).some((item) => matchesWanted(item, loader))) return false;
    if (modpackVersion) {
      const versionText = `${stringField(version.name)} ${stringField(version.version_number)}`.toLowerCase();
      if (!versionText.includes(modpackVersion.toLowerCase())) return false;
    }
    return true;
  });

  const candidates: ServerPackageCandidate[] = [];
  for (const version of filteredVersions) {
    const gameVersions = stringArrayField(version.game_versions);
    const loaders = stringArrayField(version.loaders);
    for (const file of recordArrayField(version.files)) {
      const fileName = stringField(file.filename);
      const downloadUrl = stringField(file.url);
      if (!fileName || !downloadUrl) continue;
      const lower = fileName.toLowerCase();
      const isMrpack = lower.endsWith(".mrpack");
      // Prefer dedicated server packs; allow .mrpack as a lower-priority deployable candidate via deploy_mrpack_server_from_server_slot.
      const score = isMrpack
        ? 55 + (file.primary === true ? 10 : 0)
        : fileServerScore(fileName) + (file.primary === true ? 10 : 0);
      candidates.push({
        provider: "modrinth",
        projectId,
        projectSlug,
        projectName,
        versionId: stringField(version.id),
        versionName: stringField(version.name),
        versionNumber: stringField(version.version_number),
        fileName,
        downloadUrl,
        gameVersions,
        loaders,
        releaseType: stringField(version.version_type),
        isServerCandidate: isMrpack || score >= 50,
        reason: isMrpack
          ? `.mrpack 可下载到服务端槽位后，用 inspect_mrpack_server_slot + deploy_mrpack_server_from_server_slot 部署；score=${score}`
          : `filename server score=${score}`
      });
    }
  }

  candidates.sort((first, second) => Number(second.isServerCandidate) - Number(first.isServerCandidate) || fileServerScore(second.fileName) - fileServerScore(first.fileName) || (second.fileName.toLowerCase().endsWith(".mrpack") ? 0 : 1) - (first.fileName.toLowerCase().endsWith(".mrpack") ? 0 : 1));
  const selected = pickBestCandidate(candidates, allowMrpackFallback);
  if (!selected || !selected.isServerCandidate && !allowMrpackFallback) {
    throw new Error(`Modrinth API 已可访问，但没有找到可部署的服务端包或 .mrpack。完整服务端包优先；若仅有 .mrpack，下载后须用 inspect_mrpack_server_slot 与 deploy_mrpack_server_from_server_slot，不能当普通 ZIP 解压。候选文件：${JSON.stringify(candidateSummary(candidates).slice(0, 10), null, 2)}`);
  }
  return { selected, candidates };
}

async function findModrinthModJar(ctx: AgentToolContext, input: Record<string, unknown>) {
  const query = stringInput(input, "query");
  const projectIdOrSlug = stringInput(input, "projectIdOrSlug") || stringInput(input, "projectId");
  const versionId = stringInput(input, "versionId");
  const minecraftVersion = stringInput(input, "minecraftVersion");
  const loader = stringInput(input, "loader");
  const modVersion = stringInput(input, "modVersion");
  const project = await resolveModrinthProject(ctx, projectIdOrSlug, query, "mod", "download_mod_to_server_mods");
  const projectId = stringField(project.project_id) || stringField(project.id) || projectIdOrSlug;
  const projectSlug = stringField(project.slug);
  const projectName = stringField(project.title) || stringField(project.name) || projectId;

  let versions: JsonRecord[];
  if (versionId) {
    versions = [await fetchModrinthJson(ctx, `https://api.modrinth.com/v2/version/${encodeURIComponent(versionId)}`, "download_mod_to_server_mods") as JsonRecord];
  } else {
    const url = new URL(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId || projectSlug)}/version`);
    if (loader) url.searchParams.set("loaders", JSON.stringify([loader.toLowerCase()]));
    if (minecraftVersion) url.searchParams.set("game_versions", JSON.stringify([minecraftVersion]));
    versions = recordArrayField(await fetchModrinthJson(ctx, url.toString(), "download_mod_to_server_mods"));
  }

  const filteredVersions = versions.filter((version) => {
    if (minecraftVersion && !stringArrayField(version.game_versions).some((item) => matchesWanted(item, minecraftVersion))) return false;
    if (loader && !stringArrayField(version.loaders).some((item) => matchesWanted(item, loader))) return false;
    if (modVersion) {
      const versionText = `${stringField(version.name)} ${stringField(version.version_number)}`.toLowerCase();
      if (!versionText.includes(modVersion.toLowerCase())) return false;
    }
    return true;
  });

  const candidates: ModJarCandidate[] = [];
  for (const version of filteredVersions) {
    const gameVersions = stringArrayField(version.game_versions);
    const loaders = stringArrayField(version.loaders);
    for (const file of recordArrayField(version.files)) {
      const fileName = stringField(file.filename);
      const downloadUrl = stringField(file.url);
      if (!fileName || !downloadUrl || !fileName.toLowerCase().endsWith(".jar")) continue;
      const primary = file.primary === true;
      candidates.push({
        provider: "modrinth",
        projectId,
        projectSlug,
        projectName,
        versionId: stringField(version.id),
        versionName: stringField(version.name),
        versionNumber: stringField(version.version_number),
        fileName,
        downloadUrl,
        gameVersions,
        loaders,
        releaseType: stringField(version.version_type),
        primary,
        reason: `jar score=${modJarScore(fileName, primary)}`
      });
    }
  }

  const selected = pickBestModCandidate(candidates);
  if (!selected) {
    throw new Error(`Modrinth API 已可访问，但没有找到可下载的 .jar 模组文件。候选文件：${JSON.stringify(modCandidateSummary(candidates).slice(0, 10), null, 2)}`);
  }
  return { selected, candidates };
}

function modProvider(input: Record<string, unknown>) {
  const value = stringInput(input, "provider", "modrinth").toLowerCase();
  if (value !== "curseforge" && value !== "modrinth") {
    throw new Error("provider 必须是 modrinth 或 curseforge");
  }
  return value as "curseforge" | "modrinth";
}

const rootMinecraftLayoutMarkers = [
  "mods",
  "libraries",
  "world",
  "eula.txt",
  "server.properties",
  "user_jvm_args.txt",
  "run.sh",
  "run.bat",
  "startserver.sh",
  "startserver.bat",
  "server.jar"
] as const;

async function pathExists(targetPath: string) {
  return access(targetPath).then(() => true).catch(() => false);
}

async function detectMcdrInstallRoot(serverDirectory: string) {
  const minecraftDirectory = path.join(serverDirectory, "server");
  const hasConfigYml = await pathExists(path.join(serverDirectory, "config.yml"));
  const hasServerDir = await pathExists(minecraftDirectory);
  if (hasConfigYml && hasServerDir) {
    return { layout: "mcdr" as const, installRoot: minecraftDirectory };
  }
  return { layout: "plain" as const, installRoot: serverDirectory };
}

async function listRootMinecraftLayoutMarkers(serverDirectory: string) {
  const entries = await readdir(serverDirectory).catch(() => [] as string[]);
  const names = new Set(entries.map((entry) => entry.toLowerCase()));
  return rootMinecraftLayoutMarkers.filter((marker) => names.has(marker));
}

async function runProcess(executable: string, args: string[], cwd: string, signal?: AbortSignal, onOutput?: (stream: "stdout" | "stderr", text: string) => void, proxyUrl?: string) {
  return new Promise<string>((resolve, reject) => {
    const effectiveArgs = isJavaExecutable(executable) ? [...javaProxyArgs(proxyUrl), ...args] : args;
    const child = spawn(executable, effectiveArgs, { cwd, env: proxyEnv(proxyUrl), shell: false, windowsHide: true });
    const chunks: string[] = [];
    let chunkChars = 0;
    let settled = false;
    const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString("utf8");
      chunks.push(text);
      chunkChars += text.length;
      while (chunkChars > 12000 && chunks.length > 0) {
        const first = chunks.shift();
        if (first === undefined) break;
        chunkChars -= first.length;
        if (chunks.length === 0) {
          const kept = first.slice(-6000);
          chunks.push(kept);
          chunkChars = kept.length;
        }
      }
      onOutput?.(stream, text);
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

async function ensureForgeServerTextFiles(serverDirectory: string, modpackName: string, minecraftVersion: string, minMemory: string, maxMemory: string, loaderName: string) {
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
  if (!properties.has("motd")) properties.set("motd", modpackName || `${loaderName} ${minecraftVersion}`);
  if (!properties.has("level-type")) properties.set("level-type", "default");
  await writeFile(serverPropertiesPath, [...properties.entries()].map(([key, value]) => `${key}=${value}`).join("\n") + "\n", "utf8");
  createdOrUpdated.push("server.properties");

  await writeFile(path.join(serverDirectory, "user_jvm_args.txt"), `${minMemory ? `-Xms${minMemory}\n` : ""}${maxMemory ? `-Xmx${maxMemory}\n` : ""}`, "utf8");
  createdOrUpdated.push("user_jvm_args.txt");
  return createdOrUpdated;
}

export { createGlobalAgentTools } from "./tools/globalTools.js";

export function createAgentTools(ctx: AgentToolContext): AgentTool[] {
  const workflowSteps = (ctx.getDeploymentWorkflow?.() ?? defaultDeploymentWorkflow()).steps.filter((step) => step.enabled);
  const capabilityNames = Object.keys(installableCapabilities).join(", ");
  const templateNames = ["default", "reference"];
  const tools: AgentTool[] = [
    ...(ctx.allowAskUser === false ? [] : [createAskUserTool(ctx)]),
    createWebSearchTool(ctx),
    createFetchWebPageTool(ctx),
    createRunShellCommandTool(ctx),
    {
      definition: { type: "function", function: {
        name: "begin_deployment_workflow",
        description: "开始完整整合包部署的 turn 编排。仅用户要求完整部署时调用；普通查询、排错、安装单个模组不调用。系统将指定本轮节点并在完成后自动进入下一轮；同一并行组共用一轮，所有分支和后台任务必须汇合。",
        parameters: objectSchema({})
      } },
      execute: async () => {
        if (!ctx.beginDeploymentWorkflow) throw new Error("当前会话不支持启动部署流程");
        return ctx.beginDeploymentWorkflow();
      }
    },
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
        if (!workflowSteps.some((step) => step.id === stepId)) throw new Error(`Unknown or disabled workflow step: ${stepId}`);
        const rawStatus = stringInput(input, "status");
        if (!["pending", "running", "completed", "failed"].includes(rawStatus)) throw new Error(`Unknown workflow status: ${rawStatus}`);
        const status = rawStatus as "pending" | "running" | "completed" | "failed";
        const progress = clampPercent(typeof input.progress === "number" ? input.progress : 0);
        const detail = stringInput(input, "detail");
        emitWorkflowProgress(ctx, stepId, status, progress, detail, stringInput(input, "title", "整合包服务端部署流程"));
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
        const status = await ctx.fileService.getServerSlotStatus(ctx.getServerId());
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
        const upload = ctx.uploadService.requireSessionUpload(ctx.getUploadSessionId?.() ?? ctx.getServerId(), stringInput(input, "uploadId"));
        await requireConfirmation(ctx, {
          title: "保存上传文件到服务端槽位",
          description: `Agent 准备清空当前服务端旧槽位，并把上传文件 ${upload.originalName} 保存为当前服务端槽位内容。`,
          risk: "medium"
        });
        const status = await ctx.fileService.copyIntoServerSlot(ctx.getServerId(), upload.storedPath, upload.originalName);
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
          const status = await ctx.fileService.downloadIntoServerSlot(ctx.getServerId(), url, {
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
          name: "download_curseforge_server_pack_to_server_slot",
          description: "使用 CurseForge 官方 API 查找整合包服务端包并下载到当前服务端槽位。仅在用户已明确确认是哪一个整合包/版本后调用；未确认前禁止调用。可用 query（名称）、projectId（数字 ID）、projectIdOrSlug（slug 如 vault-hunters-1-18-2）或完整 CurseForge 项目/文件 URL 定位项目；会跟随 client 文件的 serverPackFileId 下载真正的 Server Pack。需要已配置 CurseForge API Key；缺失或鉴权失败时必须停止部署并让用户点击 Tools 卡片/设置中的配置按钮，申请/管理地址：https://console.curseforge.com/?#/api-keys。",
          parameters: objectSchema({
            query: stringProperty,
            projectId: stringProperty,
            projectIdOrSlug: stringProperty,
            fileId: stringProperty,
            minecraftVersion: stringProperty,
            loader: stringProperty,
            modpackVersion: stringProperty,
            allowFallbackFile: { type: "boolean" }
          })
        }
      },
      execute: async (input) => {
        const { selected, candidates } = await findCurseForgeServerPackage(ctx, input);
        const result = await downloadCandidateToServerSlot(ctx, selected, "下载 CurseForge 服务端包到槽位");
        return JSON.stringify({ ...result, candidates: candidateSummary(candidates).slice(0, 10), apiKeyUrl: curseForgeApiKeyUrl }, null, 2);
      }
    },
    {
      definition: {
        type: "function",
        function: {
          name: "download_modrinth_server_pack_to_server_slot",
          description: "使用 Modrinth API 查找整合包服务端包或 .mrpack 并下载到当前服务端槽位。仅在用户已明确确认是哪一个整合包/版本后调用；未确认前禁止调用。通常不需要 API Key；若公开 API 返回 401/403，必须停止部署并向用户索取 Modrinth PAT，申请/管理地址：https://modrinth.com/settings/pats。若选择 .mrpack，下载完成后必须调用 inspect_mrpack_server_slot，再调用 deploy_mrpack_server_from_server_slot；不能直接解压。",
          parameters: objectSchema({
            query: stringProperty,
            projectIdOrSlug: stringProperty,
            versionId: stringProperty,
            minecraftVersion: stringProperty,
            loader: stringProperty,
            modpackVersion: stringProperty,
            allowMrpackFallback: { type: "boolean" }
          })
        }
      },
      execute: async (input) => {
        const { selected, candidates } = await findModrinthServerPackage(ctx, input);
        const result = await downloadCandidateToServerSlot(ctx, selected, "下载 Modrinth 服务端包到槽位");
        return JSON.stringify({ ...result, candidates: candidateSummary(candidates).slice(0, 10), apiKeyUrl: modrinthPatUrl }, null, 2);
      }
    },
    {
      definition: {
        type: "function",
        function: {
          name: "download_mod_to_server_mods",
          description: "使用 Modrinth 或 CurseForge 官方 API 查找模组 .jar，并下载到当前服务端的 server/mods/ 目录。provider=modrinth 通常不需要 PAT；provider=curseforge 需要已配置 CurseForge API Key。只允许下载 .jar 模组文件，不会下载 .mrpack、zip 或服务端包。",
          parameters: objectSchema({
            provider: { type: "string", enum: ["modrinth", "curseforge"] },
            query: stringProperty,
            projectIdOrSlug: stringProperty,
            projectId: stringProperty,
            versionId: stringProperty,
            fileId: stringProperty,
            minecraftVersion: stringProperty,
            loader: stringProperty,
            modVersion: stringProperty
          }, ["provider"])
        }
      },
      execute: async (input) => {
        const provider = modProvider(input);
        const { selected, candidates } = provider === "curseforge"
          ? await findCurseForgeModJar(ctx, input)
          : await findModrinthModJar(ctx, input);
        const result = await downloadModCandidateToMods(ctx, selected);
        return JSON.stringify({ ...result, candidates: modCandidateSummary(candidates).slice(0, 10), apiKeyUrl: provider === "curseforge" ? curseForgeApiKeyUrl : modrinthPatUrl }, null, 2);
      }
    },
    {
      definition: {
        type: "function",
        function: {
          name: "extract_server_slot_to_workspace",
          description: "将服务端槽位中的 zip/tar.gz/tgz 服务端包解压到当前服务端工作目录。基于 MCDReforged reference 模板部署时必须解压到 server/ 目录，不能解压到根目录。.mrpack 禁止用此工具，必须改用 inspect_mrpack_server_slot + deploy_mrpack_server_from_server_slot。",
          parameters: objectSchema({ destinationPath: stringProperty })
        }
      },
      execute: async (input) => {
        const rawDestinationPath = stringInput(input, "destinationPath", "server").trim() || "server";
        const destinationPath = rawDestinationPath === "." ? "server" : rawDestinationPath;
        if (destinationPath.replaceAll("\\", "/").split("/")[0] !== "server") {
          throw new Error("基于 MCDReforged reference 模板部署时，服务端包必须解压到 server/ 目录。请将 destinationPath 设置为 server 或 server/<子目录>。");
        }
        await requireConfirmation(ctx, {
          title: "解压服务端槽位到 server 目录",
          description: `Agent 准备将服务端槽位中的压缩包解压到当前服务端的 ${destinationPath} 目录。`,
          risk: "medium"
        });
        await mkdir(path.join((await ctx.serverService.requireServer(ctx.getServerId())).directory, "server"), { recursive: true });
        const result = await ctx.fileService.extractServerSlotIntoServer(ctx.getServerId(), destinationPath, {
          onProgress: (progress) => emitWorkflowProgress(ctx, "extract_to_workspace", "running", progress.percent, `正在解压到 ${destinationPath}：${progress.currentEntry}`)
        });
        return JSON.stringify(result, null, 2);
      }
    },
    {
      definition: {
        type: "function",
        function: {
          name: "materialize_curseforge_manifest_pack_from_server_slot",
          description: "还原当前服务端槽位内 CurseForge manifest.json 清单包的服务端内容。仅适用于 ZIP 根目录含 manifest.json 与 overrides/ 的清单包，不适用于已可直启的完整服务端包。工具会验证清单、通过 CurseForge 官方 API 精确解析每个 required projectID/fileID、把 JAR 下载到 server/mods/，并把 overrides/ 的内容合并到 server/（不会留下 server/overrides/ 包装目录）。不会安装 Minecraft 或 Loader，也不会启动服务端；Forge/NeoForge 清单会返回对应的官方 installer URL，后续必须下载 installer、启用 forge_server_setup/neoforge_server_setup 并调用 setup_forge_server/setup_neoforge_server。需要已配置 CurseForge API Key。仅在用户已确认整合包后调用。",
          parameters: objectSchema({})
        }
      },
      execute: async () => {
        const manifest = await ctx.fileService.inspectCurseForgeManifestServerSlot(ctx.getServerId());
        const loader = manifestForgeFamilyLoader(manifest);
        const mods = await preflightCurseForgeManifestMods(ctx, manifest);
        await requireConfirmation(ctx, {
          title: "还原 CurseForge 清单整合包",
          description: `Agent 准备从当前服务端槽位的 ${manifest.slot.fileName} 还原 ${manifest.name || "CurseForge 整合包"}${manifest.version ? ` ${manifest.version}` : ""}：下载 ${mods.length} 个精确版本的 required 模组到 server/mods/，并复制 overrides 内容到 server/。${loader ? `清单要求 ${loader.name} ${loader.version}；后续仍需安装 ${loader.name}。` : "当前工具不会安装清单要求的 Loader。"}`,
          risk: "high"
        });
        const overrides = await ctx.fileService.materializeCurseForgeManifestOverrides(ctx.getServerId(), "server");
        const downloadedMods = await downloadCurseForgeManifestMods(ctx, mods);
        return JSON.stringify({
          ok: true,
          manifest: manifestSummary(manifest),
          downloadedModCount: downloadedMods.length,
          skippedOptionalModCount: manifest.files.filter((file) => !file.required).length,
          downloadedMods,
          copiedOverrides: overrides.copiedOverrides,
          loaderSetup: loader
            ? {
              status: "pending",
              loader: loader.type,
              [loader.type === "forge" ? "forgeVersion" : "neoforgeVersion"]: loader.version,
              officialInstallerUrl: loader.installerUrl,
              nextSteps: [
                `使用 download_https_file_to_server 将官方 ${loader.name} installer 下载到 server/${loader.installerFileName}`,
                `调用 install_agent_capability(capability=${loader.type}_server_setup)`,
                `调用 setup_${loader.type}_server，并使用 manifest 的 Minecraft/${loader.name} 版本与已安装 Java`,
                "按流程配置内置 Python 与 MCDReforged，最后统一验证"
              ]
            }
            : {
              status: "manual_loader_setup_required",
              loaders: manifest.loaders,
              message: "清单模组与 overrides 已还原，但当前独立 Loader 安装能力仅支持 Forge/NeoForge；请先为该 Loader 提供受控安装能力后再尝试启动。"
            }
        }, null, 2);
      }
    },
    {
      definition: {
        type: "function",
        function: {
          name: "install_agent_capability",
          description: `当当前工具集缺少完成任务所需的能力时，安装/启用一个内置受控能力包。本工具只能启用已内置能力；需要执行 Shell 命令时使用已注册的 run_shell_command。当前可安装：${capabilityNames}。`,
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
          description: "更新当前服务端名称、Java 路径/版本、内存、统一启动指令、Jar、启动参数、Minecraft 版本、整合包名称和服务端类型标签。配置内存时必须让 minMemory 和 maxMemory 使用同一个值；startupCommand 非空时会作为完整启动指令执行，可使用 {java}/{javaHome}/{python}/{pythonHome}/{workspace}/{serverDir}/{minecraftDir}/{memory}/{minMemory}/{maxMemory}/{jarFile}/{startArgs} 变量。直接启动验证可设置为调用 server/ 内脚本；MCDReforged 验证可设置为 {python} -m mcdreforged。serverType 只是展示/分类标签，不再决定启动方式。",
          parameters: objectSchema({
            name: stringProperty,
            javaPath: stringProperty,
            javaVersion: stringProperty,
            memory: stringProperty,
            minMemory: stringProperty,
            maxMemory: stringProperty,
            startupCommand: stringProperty,
            jarFile: stringProperty,
            startArgs: stringProperty,
            minecraftVersion: stringProperty,
            modpackName: stringProperty,
            serverType: stringProperty
          })
        }
      },
      execute: async (input) => {
        const changes = optionalStringChanges(input, ["name", "javaPath", "javaVersion", "memory", "minMemory", "maxMemory", "startupCommand", "jarFile", "startArgs", "minecraftVersion", "modpackName", "serverType"]);
        if (changes.memory) {
          changes.minMemory = changes.memory;
          changes.maxMemory = changes.memory;
          delete changes.memory;
        } else if (changes.minMemory || changes.maxMemory) {
          const memory = changes.maxMemory ?? changes.minMemory;
          if (memory) {
            changes.minMemory = memory;
            changes.maxMemory = memory;
          }
        }
        await requireConfirmation(ctx, {
          title: "修改当前服务端配置",
          description: `Agent 准备修改当前服务端配置：${JSON.stringify(changes)}`,
          risk: "medium"
        });
        const server = await ctx.serverService.updateServer(ctx.getServerId(), changes);
        return JSON.stringify(server, null, 2);
      }
    },
    {
      definition: {
        type: "function",
        function: {
          name: "get_current_server_config",
          description: "读取当前服务端的完整配置和运行状态，包括目录、Java、内存、统一启动指令、Jar、启动参数、serverType 标签、Minecraft 版本和整合包名称。排查或切换直启/MCDR 验证前应先调用。",
          parameters: objectSchema({})
        }
      },
      execute: async () => JSON.stringify(await ctx.serverService.requireServer(ctx.getServerId()), null, 2)
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
      execute: async (input) => JSON.stringify(await ctx.fileService.list(ctx.getServerId(), stringInput(input, "path", ".")), null, 2)
    },
    {
      definition: {
        type: "function",
        function: {
          name: "read_server_text_file",
          description: "读取当前服务端目录内的文本文件，包括配置、日志、CSV、TSV、脚本和常见数据文本。可用 offset 和 limit 按字符读取片段，避免一次读取超大日志。",
          parameters: objectSchema({ path: stringProperty, offset: { type: "number" }, limit: { type: "number" } }, ["path"])
        }
      },
      execute: async (input) => ctx.fileService.readText(ctx.getServerId(), stringInput(input, "path"), {
        offset: parsePositiveInteger(input.offset),
        maxChars: parsePositiveInteger(input.limit) || agentReadTextMaxChars
      })
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
        await ctx.fileService.writeText(ctx.getServerId(), targetPath, stringInput(input, "content"));
        return `已写入 ${targetPath}`;
      }
    },
    {
      definition: {
        type: "function",
        function: {
          name: "initialize_server_template",
          description: "将内置模板复制到当前服务端目录，仅用于旧实例补齐或明确要求的模板修复。新建服务端已由后端自动套用 reference 模板，不必重复调用。reference 是内置 MCDReforged 模板，会创建 config.yml、permission.yml、plugins/、config/ 和 server/；后续 Minecraft 文件必须放入 server/。先检查已有文件，默认不覆盖。",
          parameters: objectSchema({ template: { type: "string", enum: templateNames }, overwrite: { type: "boolean" } })
        }
      },
      execute: async (input) => {
        const template = stringInput(input, "template", "reference");
        if (!templateNames.includes(template)) throw new Error(`未知模板：${template}`);
        const overwrite = booleanInput(input, "overwrite");
        await requireConfirmation(ctx, {
          title: template === "reference" ? "套用内置 MCDReforged 模板" : "套用内置默认模板",
          description: template === "reference"
            ? `Agent 准备把内置 reference 模板完整复制到当前服务端目录，并确保 Minecraft 服务端工作目录为 server/。${overwrite ? "已有同名文件会被覆盖。" : "已有同名文件会保留。"}`
            : `Agent 准备把内置 default 模板复制到当前服务端目录。${overwrite ? "已有同名文件会被覆盖。" : "已有同名文件会保留。"}`,
          risk: "medium"
        });
        const templateDir = path.join(appConfig.templatesDir, template);
        const destinationPath = await ctx.fileService.copyDirectoryIntoServer(ctx.getServerId(), templateDir, ".", overwrite);
        if (template === "reference") await mkdir(path.join((await ctx.serverService.requireServer(ctx.getServerId())).directory, "server"), { recursive: true });
        return JSON.stringify({ template, destinationPath, overwrite, minecraftServerDirectory: template === "reference" ? "server" : "." }, null, 2);
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
      execute: async () => JSON.stringify(ctx.uploadService.list(ctx.getUploadSessionId?.() ?? ctx.getServerId()), null, 2)
    },
    {
      definition: {
        type: "function",
        function: {
          name: "move_upload_to_server",
          description: "将临时上传文件复制或解压到当前服务端目录。基于 MCDReforged reference 模板部署 Minecraft 服务端本体时，destinationPath 必须位于 server/ 下；原始服务端包优先使用 save_upload_to_server_slot 和 extract_server_slot_to_workspace。",
          parameters: objectSchema({ uploadId: stringProperty, destinationPath: stringProperty, extract: { type: "boolean" } }, ["uploadId"])
        }
      },
      execute: async (input) => {
        const upload = ctx.uploadService.requireSessionUpload(ctx.getUploadSessionId?.() ?? ctx.getServerId(), stringInput(input, "uploadId"));
        const requestedDestinationPath = stringInput(input, "destinationPath", "server").trim() || "server";
        const destinationPath = requestedDestinationPath === "." ? "server" : requestedDestinationPath;
        await requireConfirmation(ctx, {
          title: "移动上传文件到服务端目录",
          description: `Agent 准备将上传文件 ${upload.originalName} ${booleanInput(input, "extract") ? "解压" : "复制"}到 ${destinationPath}。`,
          risk: "medium"
        });
        if (destinationPath.replaceAll("\\", "/").split("/")[0] !== "server") {
          throw new Error("基于 MCDReforged reference 模板部署 Minecraft 服务端本体时，上传文件必须放入 server/ 目录。请将 destinationPath 设置为 server 或 server/<子目录>。");
        }
        await mkdir(path.join((await ctx.serverService.requireServer(ctx.getServerId())).directory, "server"), { recursive: true });
        const uploadName = upload.originalName.toLowerCase();
        const shouldExtract = booleanInput(input, "extract") && (uploadName.endsWith(".zip") || uploadName.endsWith(".tar.gz") || uploadName.endsWith(".tgz"));
        if (shouldExtract) {
          await ctx.fileService.extractArchiveIntoServer(ctx.getServerId(), upload.storedPath, upload.originalName, destinationPath);
          return `已解压 ${upload.originalName} 到 ${destinationPath}`;
        }
        await ctx.fileService.copyIntoServer(ctx.getServerId(), upload.storedPath, path.join(destinationPath, upload.originalName));
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
    createConfigureBuiltinPythonTool(ctx),
    createInstallMcdrPluginDependenciesTool(ctx),
    {
      definition: {
        type: "function",
        function: {
          name: "start_current_server",
          description: "按当前服务端配置启动。后端只保证同一时间运行一个服务端，不区分 MCDR/普通服务端；startupCommand 非空时按统一启动指令执行，空时才自动选择服务端自带 run/start/server/launch 脚本或生成 Java 启动脚本。最终验证前应由 Agent 先通过 update_current_server_config 将 startupCommand 切换为 MCDR 启动方式。",
          parameters: objectSchema({})
        }
      },
      execute: async () => JSON.stringify(await ctx.processManager.start(ctx.getServerId()))
    },
    {
      definition: {
        type: "function",
        function: {
          name: "wait_for_server_startup",
          description: "阻塞等待当前服务端日志明确出现 Minecraft 启动完成标记 Done (...)!。必须在 start_current_server 后调用，用它替代 sleep、固定等待或反复轮询；服务端提前退出、取消或超时会立即返回错误。默认最多等待 180 秒，可通过 timeoutSeconds 调整（5-600 秒）。",
          parameters: objectSchema({ timeoutSeconds: { type: "number", description: "最长等待秒数，默认 180，范围 5-600" } })
        }
      },
      execute: async (input) => {
        const rawTimeout = typeof input.timeoutSeconds === "number" ? input.timeoutSeconds : 180;
        const timeoutSeconds = Math.min(Math.max(Math.floor(rawTimeout), 5), 600);
        return JSON.stringify(await ctx.processManager.waitForStartup(ctx.getServerId(), {
          timeoutMs: timeoutSeconds * 1000,
          signal: ctx.signal
        }));
      }
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
      execute: async () => JSON.stringify(await ctx.processManager.stop(ctx.getServerId()))
    },
    {
      definition: {
        type: "function",
        function: {
          name: "kill_current_server",
          description: "强制结束当前服务端进程树或该服务端目录关联的后台残留进程。用于 stop 无响应、启动验证卡住、状态为 orphaned/疑似残留，或需要切换启动指令重新验证时。高风险操作，会终止相关进程。",
          parameters: objectSchema({})
        }
      },
      execute: async () => {
        await requireConfirmation(ctx, {
          title: "强制结束当前服务端进程树",
          description: "Agent 准备强制结束当前服务端正在运行或残留的进程树。该操作会终止相关 Java/MCDR/脚本进程。",
          risk: "high"
        });
        return JSON.stringify(await ctx.processManager.kill(ctx.getServerId()));
      }
    },
    {
      definition: {
        type: "function",
        function: {
          name: "send_current_server_command",
          description: "向当前正在运行的服务端控制台发送一条命令，例如 stop、list、spark profiler 等。只有服务端已由后端跟踪为 running 时可用。",
          parameters: objectSchema({ command: stringProperty }, ["command"])
        }
      },
      execute: async (input) => {
        const command = stringInput(input, "command").trim();
        if (!command) throw new Error("command 不能为空");
        ctx.processManager.sendCommand(ctx.getServerId(), command);
        return JSON.stringify({ ok: true, command });
      }
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
    createInspectMrpackServerTool(ctx),
    createDeployMrpackServerTool(ctx),
    createInspectClientOnlyServerModsTool(ctx),
    createDisableClientOnlyServerModsTool(ctx),
    createDisableServerModsTool(ctx),
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
          description: "解压当前服务端目录内已经存在的 .zip/.tar.gz/.tgz 文件到服务端目录内的指定位置。只能访问当前服务端沙箱目录。",
          parameters: objectSchema({ archivePath: stringProperty, zipPath: stringProperty, destinationPath: stringProperty })
        }
      },
      execute: async (input) => {
        const archivePath = stringInput(input, "archivePath") || stringInput(input, "zipPath");
        const archiveLower = archivePath.toLowerCase();
        if (!archiveLower.endsWith(".zip") && !archiveLower.endsWith(".tar.gz") && !archiveLower.endsWith(".tgz")) throw new Error("Only .zip/.tar.gz/.tgz files can be extracted");
        const destinationPath = stringInput(input, "destinationPath", ".");
        const archive = await ctx.fileService.resolveDownload(ctx.getServerId(), archivePath);
        await requireConfirmation(ctx, {
          title: "解压服务端内压缩包",
          description: `Agent 准备将当前服务端目录内的 ${archive.fileName} 解压到 ${destinationPath}。`,
          risk: "medium"
        });
        await ctx.fileService.extractArchiveIntoServer(ctx.getServerId(), archive.absolutePath, archive.fileName, destinationPath);
        return `已解压 ${archivePath} 到 ${destinationPath}`;
      }
    });
  }

  for (const loaderType of ["forge", "neoforge"] as const) {
    if (!ctx.installedCapabilities?.has(`${loaderType}_server_setup`)) continue;
    const loaderName = loaderType === "forge" ? "Forge" : "NeoForge";
    const versionKey = loaderType === "forge" ? "forgeVersion" : "neoforgeVersion";
    tools.push({
      definition: {
        type: "function",
        function: {
          name: `setup_${loaderType}_server`,
          description: `在当前服务端沙箱内运行 ${loaderName} installer，验证生成的 libraries/.../win_args.txt 或 unix_args.txt，并写入当前服务端可启动配置。${loaderType === "forge" ? "适用于 Forge 1.17+，使用 -installServer。" : "使用 --installServer；neoforgeVersion 使用整合包指定的版本（如 21.1.200、20.4.237）；Minecraft 1.20.1 支持旧版 47.1.x 或 1.20.1-47.1.x。"}若根目录已有 MCDReforged 布局（config.yml + server/），本工具必须把 ${loaderName} 安装到 server/，把 mods/config 等提升到 server/，并在 server/ 写入 eula.txt、server.properties、user_jvm_args.txt；绝不把 Minecraft 服务端文件安装或提升到 MCDReforged 根目录。若 installer 位于 server/ 下的嵌套整合包子目录，会提升到 server/ 而不是根目录。minMemory/maxMemory 必须使用同一个值，优先使用上下文里的推荐内存；整合包有明确要求时可以调整但不能超过推荐内存，并向用户说明。本工具只完成 ${loaderName} 安装与 server/ 基础文件，不替代 configure_builtin_python_environment、config.yml 编辑、以及 startupCommand={python} -m mcdreforged 的最终 MCDR 配置。`,
          parameters: objectSchema({
            minecraftVersion: stringProperty,
            [versionKey]: stringProperty,
            installerPath: stringProperty,
            javaPath: stringProperty,
            minMemory: stringProperty,
            maxMemory: stringProperty,
            modpackName: stringProperty,
            removeClientSideModPatterns: { type: "array", items: stringProperty }
          }, ["minecraftVersion", versionKey, "installerPath", "javaPath"])
        }
      },
      execute: async (input) => {
        const minecraftVersion = stringInput(input, "minecraftVersion");
        const loaderVersion = stringInput(input, versionKey);
        const installerPath = stringInput(input, "installerPath");
        const javaPath = stringInput(input, "javaPath");
        const requestedMemory = stringInput(input, "minMemory") || stringInput(input, "maxMemory", "4G");
        const minMemory = requestedMemory;
        const maxMemory = requestedMemory;
        const modpackName = stringInput(input, "modpackName");
        if (!installerPath.toLowerCase().endsWith(".jar")) throw new Error(`${loaderName} installer must be a .jar file`);
        if (!minecraftVersion || !loaderVersion || !javaPath) {
          throw new Error(`minecraftVersion、${versionKey}、javaPath 都必须提供`);
        }
        const installerInfo = resolveForgeFamilyInstaller(loaderType, minecraftVersion, loaderVersion);

        const server = await ctx.serverService.requireServer(ctx.getServerId());
        const installer = await ctx.fileService.resolveDownload(ctx.getServerId(), installerPath);
        await access(javaPath).catch(() => {
          throw new Error(`Java executable not found: ${javaPath}`);
        });
        const { layout, installRoot } = await detectMcdrInstallRoot(server.directory);
        await mkdir(installRoot, { recursive: true });
        const argsPath = installerInfo.argsPath;
        const installRootLabel = layout === "mcdr" ? "server/" : "服务端根目录";
        await requireConfirmation(ctx, {
          title: `运行 ${loaderName} 服务端安装器`,
          description: `Agent 准备在 ${installRootLabel} 内运行 ${installer.fileName} ${installerInfo.installFlag}，并将启动配置设置为 @${argsPath} nogui。MCDReforged 布局下 Minecraft 文件只会写入 server/，不会写到根目录。`,
          risk: "high"
        });

        ctx.consoleLog?.(`运行 ${loaderName} installer（cwd=${installRootLabel}）：${javaPath} -jar ${installer.absolutePath} ${installerInfo.installFlag}`);
        const output = await runProcess(
          javaPath,
          ["-jar", installer.absolutePath, installerInfo.installFlag],
          installRoot,
          ctx.signal,
          (stream, text) => ctx.consoleLog?.(text, stream),
          ctx.downloadProxyUrl?.()
        );
        const absoluteArgsPath = path.join(installRoot, argsPath);
        if (!(await pathExists(absoluteArgsPath))) {
          throw new Error(`${loaderName} installer did not create expected args file under ${installRootLabel}: ${argsPath}\n最近输出：\n${output.slice(-3000)}`);
        }
        const installerPathForPromote = path.relative(installRoot, installer.absolutePath).replaceAll("\\", "/");
        const promoteInstallerPath = installerPathForPromote && !installerPathForPromote.startsWith("..")
          ? installerPathForPromote
          : installerPath;
        const promotedContent = await promoteNestedModpackContent(installRoot, promoteInstallerPath);
        const configuredTextFiles = await ensureForgeServerTextFiles(installRoot, modpackName, minecraftVersion, minMemory, maxMemory, loaderName);
        const removedMods = await removeMatchingMods(installRoot, stringArrayInput(input, "removeClientSideModPatterns"));
        const rootMinecraftMarkers = await listRootMinecraftLayoutMarkers(server.directory);
        const layoutWarnings: string[] = [];
        if (layout === "mcdr" && rootMinecraftMarkers.length > 0) {
          layoutWarnings.push(
            `MCDReforged 根目录仍存在 Minecraft 文件/目录：${rootMinecraftMarkers.join(", ")}。这些应位于 server/，根目录只应保留 MCDR 的 config.yml、permission.yml、plugins/、config/、logs/ 与 server/。请用 list_server_files 核对并清理或迁移后再继续。`
          );
        }
        if (layout === "mcdr") {
          layoutWarnings.push(
            `${loaderName} 已安装到 server/。本工具不完成 MCDR 最终配置：继续按系统中的流程编排完成内置 Python（configure_builtin_python_environment，已成功配置可复用）、根目录 config.yml（working_directory=server，start_command 从 server/ 启动，handler 符合 ${loaderName}）和 startupCommand={python} -m mcdreforged 的最终验证。`
          );
        }
        const normalizedArgsPath = argsPath.replace(/\\/g, "/");
        const updated = await ctx.serverService.updateServer(ctx.getServerId(), {
          javaPath,
          javaVersion: ctx.javaService.recommendVersion(minecraftVersion),
          minMemory,
          maxMemory,
          jarFile: "",
          startArgs: `@${normalizedArgsPath} nogui`,
          minecraftVersion,
          modpackName: modpackName || `${loaderName} ${minecraftVersion}-${installerInfo.version}`,
          serverType: loaderType
        });
        return JSON.stringify({
          ok: true,
          layout,
          installRoot: layout === "mcdr" ? "server" : ".",
          argsPath: normalizedArgsPath,
          argsPathRelativeToInstallRoot: normalizedArgsPath,
          promotedContent,
          configuredTextFiles,
          removedClientSideMods: removedMods,
          rootMinecraftMarkers,
          layoutWarnings,
          nextSteps: layout === "mcdr"
            ? [
              "用 list_server_files 确认 mods/libraries/run 脚本/eula 在 server/ 内，根目录无 Minecraft 本体文件",
              "确认 config.yml 的 start_command 指向 server/ 内实际脚本，再配置 startupCommand={python} -m mcdreforged",
              "configure_builtin_python_environment",
              "编辑 config.yml 后 startupCommand={python} -m mcdreforged 做最终验证"
            ]
            : [
              `确认 ${loaderName} args 与 eula 已就绪后进入 MCDReforged 最终验证`
            ],
          outputTail: output.slice(-3000),
          server: updated
        }, null, 2);
      }
    });
  }

  return tools;
}
