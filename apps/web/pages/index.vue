<script setup lang="ts">
import { Marked, Renderer } from "marked";
import type { Tokens } from "marked";
import type { UploadProgress } from "~/composables/useApi";
import type { AgentConfirmationRequest, AgentDownloadProgress, AgentMessage, AgentRetryState, AgentSettings, AgentStatus, AgentToolConfigRequired, AgentToolConfigRequirement, AgentToolRecord, AgentToolSettings, AgentWorkflowProgress, AgentWorkflowStepStatus, ConsoleLogEntry, FileEntry, JavaDownloadSource, JavaDownloadSourceOption, JavaInstall, JavaInstallTask, JavaInstallTaskStatus, JavaManagementState, JavaVersionRecord, ModelConfig, ProxyTestResult, ServerRecord, ServerSlotStatus, SkillRecord, ToolConfigKey } from "~/types/app";

definePageMeta({ middleware: "auth" });

const { api, upload, downloadUrl } = useApi();
const runtime = useRuntimeConfig();
const clock = useClock();

const servers = ref<ServerRecord[]>([]);
const serversLoaded = ref(false);
const selectedServerId = ref("");
const logs = ref<ConsoleLogEntry[]>([]);
const files = ref<FileEntry[]>([]);
const currentPath = ref(".");
const agentMessages = ref<AgentMessage[]>([]);
const pendingConfirmation = ref<AgentConfirmationRequest | null>(null);
const models = ref<ModelConfig[]>([]);
const skills = ref<SkillRecord[]>([]);
const agentTools = ref<AgentToolRecord[]>([]);
const javaInstalls = ref<JavaInstall[]>([]);
const javaVersions = ref<JavaVersionRecord[]>([]);
const javaTasks = ref<JavaInstallTask[]>([]);
const javaDownloadSources = ref<JavaDownloadSourceOption[]>([]);
const globalPrompt = ref("");
const providerKeySettings = ref<AgentToolSettings>({ curseForgeApiKeyConfigured: false, curseForgeApiKeyHint: "未配置", modrinthApiKeyConfigured: false, modrinthApiKeyHint: "未配置" });
const providerKeyForm = reactive({ curseForgeApiKey: "", modrinthApiKey: "" });
const providerKeySaving = ref(false);
const providerKeyDialogOpen = ref(false);
const proxyTestDialogOpen = ref(false);
const proxyTesting = ref(false);
const proxyTestTarget = ref("www.google.com");
const proxyTestResult = ref<ProxyTestResult | null>(null);
const pendingToolConfig = ref<AgentToolConfigRequired | null>(null);
const agentAutoConfirm = ref(false);
const agentDownloadProxyEnabled = ref(false);
const agentDownloadProxyUrl = ref("");
const agentMemoryMb = ref(2048);
const systemMemoryMb = ref(2048);
const consoleCommand = ref("");
const agentInput = ref("");
const agentReasoningEffort = ref<"minimal" | "low" | "medium" | "high">("high");
const agentStatus = ref<AgentStatus>("idle");
const agentMessageList = ref<HTMLElement | null>(null);
const consoleLogList = ref<HTMLElement | null>(null);
const showAgentScrollToBottom = ref(false);
const agentUploadInput = ref<HTMLInputElement | null>(null);
const serverUploadInput = ref<HTMLInputElement | null>(null);
const settingsOpen = ref(false);
const sidebarCollapsed = ref(false);
const deploymentProgressDismissed = ref(false);
const fileDialogOpen = ref(false);
const configDialogOpen = ref(false);
const textEditor = reactive({ open: false, path: "", content: "" });
const createDialogOpen = ref(false);
const deleteDialog = reactive<{ open: boolean; server: ServerRecord | null; confirmName: string; deleting: boolean; error: string }>({ open: false, server: null, confirmName: "", deleting: false, error: "" });
const newServerName = ref("我的 Minecraft 服务端");
const newFolderName = ref("");
const selectedFilePaths = ref<string[]>([]);
const fileSelectionAnchorPath = ref("");
const fileDragSelecting = ref(false);
const filesLoading = ref(false);
const fixedModelDisplayName = "OpenAI Compatible";
const modelForm = reactive({ displayName: fixedModelDisplayName, baseUrl: "https://api.openai.com/v1", modelName: "gpt-4o-mini", apiKey: "", isDefault: true });
const modelSaving = ref(false);
const modelTesting = ref(false);
const serverForm = reactive({ name: "", javaPath: "", javaVersion: "", minMemory: "1G", maxMemory: "2G", jarFile: "server.jar", startArgs: "nogui", startupCommand: "", minecraftVersion: "", modpackName: "", promptOverride: "", useGlobalPrompt: true });
const javaVersionToInstall = ref("21");
const javaDownloadSource = ref<JavaDownloadSource>("auto-cn");

type StatusBubbleType = "idle" | "loading" | "success" | "error";

interface StatusBubbleItem {
  id: number;
  type?: StatusBubbleType;
  message: string;
  durationMs?: number;
  progressKey?: number;
  download?: AgentDownloadProgress;
  actionLabel?: string;
  actionKey?: string;
}

interface UploadState {
  active: boolean;
  fileName: string;
  loaded: number;
  total: number;
  percent: number;
  done: boolean;
}

interface PendingAgentAttachment {
  path: string;
  originalName: string;
}

interface ConsoleTextStyle {
  foreground: string | null;
  background: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  inverse: boolean;
}

interface RenderedConsoleLogEntry extends ConsoleLogEntry {
  html: string;
}

type DeploymentProgressState = "not_started" | "running" | "progress" | "completed" | "failed" | "cancelled";

const pendingAgentAttachments = ref<PendingAgentAttachment[]>([]);
const serverUpload = reactive<UploadState>({ active: false, fileName: "", loaded: 0, total: 0, percent: 0, done: false });
const agentUpload = reactive<UploadState>({ active: false, fileName: "", loaded: 0, total: 0, percent: 0, done: false });
const agentDownloads = ref<AgentDownloadProgress[]>([]);
const agentWorkflow = ref<AgentWorkflowProgress | null>(null);
const serverSlot = ref<ServerSlotStatus | null>(null);
const agentRetry = ref<AgentRetryState | null>(null);
const agentRetryNowSending = ref(false);
const statusBubbles = ref<StatusBubbleItem[]>([]);

let consoleSocket: WebSocket | undefined;
let agentSocket: WebSocket | undefined;
let javaPollTimer: ReturnType<typeof setInterval> | undefined;
let socketReconnectTimer: ReturnType<typeof setTimeout> | undefined;
let agentRetryClockTimer: ReturnType<typeof setInterval> | undefined;
let nextStatusBubbleId = 0;
let nextStatusBubbleProgressKey = 0;
let modelStatusBubbleId: number | undefined;
let providerKeyStatusBubbleId: number | undefined;
let socketStatusBubbleId: number | undefined;
const agentDownloadStatusBubbleIds = new Map<string, number>();
let socketReconnectAttempt = 0;
let socketReconnectGeneration = 0;
let socketsClosedIntentionally = false;
let fileDragSelectedPaths = new Set<string>();
let consoleScrollFrame: number | undefined;
let agentScrollFrame: number | undefined;
const statusBubbleTimers = new Map<number, ReturnType<typeof setTimeout>>();

const agentTypewriterDelayMs = 12;
const agentRetryClock = ref(Date.now());
const socketReconnectBaseDelayMs = 1000;
const socketReconnectMaxDelayMs = 10000;
const agentStreamBuffers = new Map<string, { queue: string[]; timer: ReturnType<typeof setTimeout> | null; serverId: string }>();
const markdownRenderer = new Renderer();

markdownRenderer.html = ({ text }: Tokens.HTML | Tokens.Tag) => escapeHtml(text);
markdownRenderer.link = function (this: Renderer, { href, title, tokens }: Tokens.Link) {
  const label = this.parser.parseInline(tokens);
  const safeHref = safeMarkdownHref(href);
  if (!safeHref) return `<span class="markdown-link-disabled">${label}</span>`;
  const safeTitle = title ? ` title="${escapeHtml(title)}"` : "";
  return `<a href="${escapeHtml(safeHref)}"${safeTitle} target="_blank" rel="noreferrer noopener">${label}</a>`;
};
markdownRenderer.image = ({ href, text }: Tokens.Image) => {
  const safeHref = safeMarkdownHref(href);
  const label = escapeHtml(text || href);
  if (!safeHref) return `<span class="markdown-image-link">图片：${label}</span>`;
  return `<a class="markdown-image-link" href="${escapeHtml(safeHref)}" target="_blank" rel="noreferrer noopener">图片：${label}</a>`;
};

const agentMarkdown = new Marked({ async: false, breaks: true, gfm: true, renderer: markdownRenderer });

const selectedServer = computed(() => servers.value.find((server) => server.id === selectedServerId.value) ?? null);
const hasServers = computed(() => servers.value.length > 0);
const showEmptyLanding = computed(() => serversLoaded.value && !hasServers.value);
const sortedFiles = computed(() => [...files.value].sort((first, second) => {
  if (first.type !== second.type) return first.type === "directory" ? -1 : 1;
  return first.name.localeCompare(second.name, "zh-Hans-CN", { numeric: true, sensitivity: "base" });
}));
const parentDirectoryPath = computed(() => {
  if (currentPath.value === ".") return "";
  const parts = currentPath.value.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/") || ".";
});
const selectedFiles = computed(() => sortedFiles.value.filter((file) => selectedFilePaths.value.includes(file.path)));
const selectedFile = computed(() => selectedFiles.value.length === 1 ? selectedFiles.value[0] : null);
const savedApiKeyHint = computed(() => models.value[0]?.apiKeyHint || "");
const apiKeyPlaceholder = computed(() => savedApiKeyHint.value && savedApiKeyHint.value !== "未配置" ? savedApiKeyHint.value : "API Key（只覆盖，不回显）");
const hasUnsavedApiKey = computed(() => modelForm.apiKey.length > 0);
const modelBusy = computed(() => modelSaving.value || modelTesting.value);
const statusClass = computed(() => selectedServer.value ? `status-${selectedServer.value.status}` : "");
const serverStatusText = computed(() => selectedServer.value ? statusText(selectedServer.value.status) : "未选择");
const agentStatusText = computed(() => agentStatusLabel(agentStatus.value));
const runningServerCount = computed(() => servers.value.filter((server) => server.status === "running").length);
const crashedServerCount = computed(() => servers.value.filter((server) => server.status === "crashed" || server.status === "orphaned").length);
const agentBusy = computed(() => ["thinking", "running", "waiting_confirmation", "retrying"].includes(agentStatus.value));
const selectedJavaVersion = computed(() => javaVersions.value.find((version) => version.version === javaVersionToInstall.value) ?? null);
const selectedJavaTask = computed(() => selectedJavaVersion.value?.task ?? javaTasks.value.find((task) => task.version === javaVersionToInstall.value) ?? null);
const selectedJavaInstalled = computed(() => selectedJavaVersion.value?.installed ?? javaInstalls.value.some((java) => java.version === javaVersionToInstall.value && java.available));
const selectedJavaBusy = computed(() => selectedJavaTask.value ? isJavaTaskActive(selectedJavaTask.value.status) : false);
const activeJavaTaskCount = computed(() => javaTasks.value.filter((task) => isJavaTaskActive(task.status)).length);
const javaHasActiveTasks = computed(() => activeJavaTaskCount.value > 0);
const minimumServerMemoryMb = 512;
const agentMemoryWarning = computed(() => agentMemoryMb.value > systemMemoryMb.value * 0.9);
const agentMemoryLabel = computed(() => formatMemoryMb(agentMemoryMb.value));
const systemMemoryLabel = computed(() => formatMemoryMb(systemMemoryMb.value));
const serverMemoryMaxMb = computed(() => Math.max(minimumServerMemoryMb, systemMemoryMb.value));
const serverMemoryMb = computed({
  get: () => clampServerMemoryMb(parseMemoryToMb(serverForm.maxMemory || serverForm.minMemory)),
  set: (value: number) => {
    const normalized = clampServerMemoryMb(value);
    const memory = memoryConfigValue(normalized);
    serverForm.minMemory = memory;
    serverForm.maxMemory = memory;
  }
});
const serverMemoryLabel = computed(() => formatMemoryMb(serverMemoryMb.value));
const serverMemoryWarning = computed(() => serverMemoryMb.value > systemMemoryMb.value * 0.9);
const configJavaVersionOptions = computed(() => {
  const options = javaVersions.value
    .filter((version) => version.installed && version.installPath)
    .map((version) => ({
      version: version.version,
      label: version.label,
      installed: version.installed,
      installPath: version.installPath
    }));
  if (serverForm.javaVersion && !options.some((option) => option.version === serverForm.javaVersion)) {
    options.unshift({ version: serverForm.javaVersion, label: `Java ${serverForm.javaVersion}`, installed: Boolean(serverForm.javaPath), installPath: serverForm.javaPath || null });
  }
  return options.sort((first, second) => Number(first.version) - Number(second.version));
});
const deploymentWorkflow = computed<AgentWorkflowProgress | null>(() => {
  const workflow = agentWorkflow.value;
  if (!workflow) return null;

  const failedRun = agentStatus.value === "failed" || agentStatus.value === "cancelled";
  if (!failedRun || workflow.status === "failed") return workflow;

  const fallbackStep = workflow.steps.find((step) => step.status === "running")
    ?? workflow.steps.find((step) => step.status !== "completed")
    ?? workflow.steps[workflow.steps.length - 1];
  const failedStepId = workflow.currentStepId || fallbackStep?.id || "";
  const failedDetail = agentStatus.value === "cancelled" ? "任务已中断" : "任务执行失败";

  return {
    ...workflow,
    currentStepId: failedStepId,
    status: "failed",
    steps: workflow.steps.map((step) => step.id === failedStepId
      ? { ...step, status: "failed", detail: step.detail || failedDetail }
      : step)
  };
});
const showDeploymentProgressCard = computed(() => Boolean(selectedServer.value));
const deploymentProgressState = computed<DeploymentProgressState>(() => {
  const workflow = deploymentWorkflow.value;
  const workflowCompleted = workflow
    && workflow.overallProgress >= 100
    && workflow.steps.length > 0
    && workflow.steps.every((step) => step.status === "completed");
  if (!workflow) return serverSlot.value?.occupied ? "completed" : "not_started";
  if (workflowCompleted) return "completed";
  if (workflow.status === "failed") return agentStatus.value === "cancelled" ? "cancelled" : "failed";
  if (agentBusy.value) return "running";
  return "progress";
});
const deploymentProgressLabel = computed(() => {
  if (deploymentProgressState.value === "not_started") return "未开始";
  if (deploymentProgressState.value === "running") return "部署执行中";
  if (deploymentProgressState.value === "completed") return "部署完成";
  if (deploymentProgressState.value === "failed") return "部署失败";
  if (deploymentProgressState.value === "cancelled") return "部署已中断";
  return "部署进度";
});
const deploymentProgressCardStatus = computed(() => deploymentWorkflow.value?.status ?? "completed");
const deploymentProgressPercent = computed(() => deploymentWorkflow.value?.overallProgress ?? (serverSlot.value?.occupied ? 100 : 0));
const deploymentProgressDefaultDismissed = computed(() => deploymentProgressState.value === "not_started" || deploymentProgressState.value === "completed");
const deleteConfirmMatches = computed(() => deleteDialog.server ? deleteDialog.confirmName.trim() === deleteDialog.server.name : false);
const deleteServerBlocked = computed(() => deleteDialog.server ? !["stopped", "crashed"].includes(deleteDialog.server.status) : true);
const renderedConsoleLogs = computed<RenderedConsoleLogEntry[]>(() => renderConsoleLogs(logs.value));
const agentPlaceholder = computed(() => {
  if (agentStatus.value === "waiting_confirmation") return "请先处理确认弹窗，Agent 会继续或停止当前任务";
  if (agentStatus.value === "retrying") return "模型接口暂时异常，Agent 正在等待重试";
  if (agentBusy.value) return "Agent 正在处理当前任务，可以先整理下一条需求";
  return "让 Agent 部署整合包、生成配置、检查 Java 或分析报错";
});
const agentRetryRemainingSeconds = computed(() => {
  if (!agentRetry.value) return 0;
  agentRetryClock.value;
  return Math.max(0, Math.ceil((new Date(agentRetry.value.nextRetryAt).getTime() - Date.now()) / 1000));
});
const agentRetryMessage = computed(() => {
  if (!agentRetry.value) return "";
  return `模型连接短暂波动，${agentRetryRemainingSeconds.value} 秒后自动重试（第 ${agentRetry.value.attempt} 次）`;
});
const proxyTestModeLabel = computed(() => agentDownloadProxyEnabled.value
  ? agentDownloadProxyUrl.value.trim() || "代理已开启但地址为空"
  : "代理未启用，将检测直连");

watch(settingsOpen, (open) => {
  if (!open) {
    scrollConsoleHistoryToBottom();
    scrollAgentHistoryToBottom();
  }
});

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeMarkdownHref(href: string) {
  const trimmed = href.trim();
  if (!trimmed) return "";
  const scheme = trimmed.match(/^([a-z][a-z\d+.-]*):/i)?.[1]?.toLowerCase();
  if (scheme && !["http", "https", "mailto"].includes(scheme)) return "";
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  return trimmed;
}

function renderAgentMarkdown(content: string) {
  return agentMarkdown.parse(content) as string;
}

function createConsoleTextStyle(): ConsoleTextStyle {
  return {
    foreground: null,
    background: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    strike: false,
    inverse: false
  };
}

function resetConsoleTextStyle(style: ConsoleTextStyle) {
  Object.assign(style, createConsoleTextStyle());
}

const ansiBasicColors = [
  "#0f172a",
  "#ef4444",
  "#22c55e",
  "#eab308",
  "#3b82f6",
  "#d946ef",
  "#06b6d4",
  "#e5e7eb"
];

const ansiBrightColors = [
  "#64748b",
  "#f87171",
  "#4ade80",
  "#fde047",
  "#60a5fa",
  "#e879f9",
  "#22d3ee",
  "#ffffff"
];

const minecraftLegacyColors: Record<string, string> = {
  "0": "#000000",
  "1": "#0000aa",
  "2": "#00aa00",
  "3": "#00aaaa",
  "4": "#aa0000",
  "5": "#aa00aa",
  "6": "#ffaa00",
  "7": "#aaaaaa",
  "8": "#555555",
  "9": "#5555ff",
  a: "#55ff55",
  b: "#55ffff",
  c: "#ff5555",
  d: "#ff55ff",
  e: "#ffff55",
  f: "#ffffff"
};

function renderConsoleLogs(entries: ConsoleLogEntry[]) {
  const style = createConsoleTextStyle();
  let pendingAnsiControl = "";
  return entries.map((entry) => {
    const rendered = renderConsoleText(`${pendingAnsiControl}${entry.text}`, style);
    pendingAnsiControl = rendered.pendingAnsiControl;
    return { ...entry, html: rendered.html };
  });
}

function renderConsoleText(text: string, style: ConsoleTextStyle) {
  let html = "";
  let index = 0;
  let pendingAnsiControl = "";

  while (index < text.length) {
    const ansiIndex = text.indexOf("\u001B", index);
    const minecraftIndex = text.indexOf("§", index);
    const controlIndex = nextConsoleControlIndex(ansiIndex, minecraftIndex);

    if (controlIndex === -1) {
      html += renderStyledConsoleText(text.slice(index), style);
      break;
    }

    html += renderStyledConsoleText(text.slice(index, controlIndex), style);

    if (controlIndex === ansiIndex) {
      const consumed = consumeAnsiControl(text, controlIndex, style);
      if (!consumed) {
        pendingAnsiControl = text.slice(controlIndex);
        break;
      }
      index = consumed;
    } else {
      const consumed = consumeMinecraftLegacyControl(text, controlIndex, style);
      if (consumed) index = consumed;
      else {
        html += renderStyledConsoleText(text[controlIndex] ?? "", style);
        index = controlIndex + 1;
      }
    }
  }

  return { html, pendingAnsiControl };
}

function nextConsoleControlIndex(first: number, second: number) {
  if (first === -1) return second;
  if (second === -1) return first;
  return Math.min(first, second);
}

function renderStyledConsoleText(text: string, style: ConsoleTextStyle) {
  if (!text) return "";
  const escaped = escapeHtml(text);
  const styleAttribute = consoleTextStyleAttribute(style);
  return styleAttribute ? `<span${styleAttribute}>${escaped}</span>` : escaped;
}

function consoleTextStyleAttribute(style: ConsoleTextStyle) {
  const declarations: string[] = [];
  const foreground = style.inverse ? style.background ?? "#05080d" : style.foreground;
  const background = style.inverse ? style.foreground ?? "#e5e7eb" : style.background;
  const decorations: string[] = [];

  if (foreground) declarations.push(`color: ${foreground}`);
  if (background) declarations.push(`background-color: ${background}`);
  if (style.bold) declarations.push("font-weight: 700");
  if (style.dim) declarations.push("opacity: 0.72");
  if (style.italic) declarations.push("font-style: italic");
  if (style.underline) decorations.push("underline");
  if (style.strike) decorations.push("line-through");
  if (decorations.length) declarations.push(`text-decoration: ${decorations.join(" ")}`);

  return declarations.length ? ` style="${declarations.join("; " )}"` : "";
}

function consumeAnsiControl(text: string, start: number, style: ConsoleTextStyle) {
  const introducer = text[start + 1];
  if (!introducer) return null;

  if (introducer === "[") {
    for (let cursor = start + 2; cursor < text.length; cursor += 1) {
      const code = text.charCodeAt(cursor);
      if (code >= 0x40 && code <= 0x7e) {
        if (text[cursor] === "m") applyAnsiSgr(text.slice(start + 2, cursor), style);
        return cursor + 1;
      }
    }
    return text.length - start > 128 ? start + 1 : null;
  }

  if (introducer === "]") {
    const bellIndex = text.indexOf("\u0007", start + 2);
    const stringTerminatorIndex = text.indexOf("\u001B\\", start + 2);
    if (bellIndex === -1 && stringTerminatorIndex === -1) return text.length - start > 1024 ? start + 1 : null;
    if (bellIndex === -1) return stringTerminatorIndex + 2;
    if (stringTerminatorIndex === -1) return bellIndex + 1;
    return Math.min(bellIndex + 1, stringTerminatorIndex + 2);
  }

  if ("()*+-./#%".includes(introducer)) return text[start + 2] ? start + 3 : null;
  return start + 2;
}

function applyAnsiSgr(parameters: string, style: ConsoleTextStyle) {
  const codes = parameters.trim()
    ? parameters.split(/[;:]/).filter(Boolean).map((value) => Number(value)).filter(Number.isFinite)
    : [0];
  if (codes.length === 0) codes.push(0);

  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index] ?? 0;
    if (code === 0) resetConsoleTextStyle(style);
    else if (code === 1) style.bold = true;
    else if (code === 2) style.dim = true;
    else if (code === 3) style.italic = true;
    else if (code === 4) style.underline = true;
    else if (code === 7) style.inverse = true;
    else if (code === 9) style.strike = true;
    else if (code === 22) {
      style.bold = false;
      style.dim = false;
    } else if (code === 23) style.italic = false;
    else if (code === 24) style.underline = false;
    else if (code === 27) style.inverse = false;
    else if (code === 29) style.strike = false;
    else if (code >= 30 && code <= 37) style.foreground = ansiBasicColors[code - 30] ?? null;
    else if (code === 39) style.foreground = null;
    else if (code >= 40 && code <= 47) style.background = ansiBasicColors[code - 40] ?? null;
    else if (code === 49) style.background = null;
    else if (code >= 90 && code <= 97) style.foreground = ansiBrightColors[code - 90] ?? null;
    else if (code >= 100 && code <= 107) style.background = ansiBrightColors[code - 100] ?? null;
    else if (code === 38 || code === 48) {
      const color = readExtendedAnsiColor(codes, index + 1);
      if (color) {
        if (code === 38) style.foreground = color.value;
        else style.background = color.value;
        index = color.nextIndex - 1;
      }
    }
  }
}

function readExtendedAnsiColor(codes: number[], start: number) {
  const mode = codes[start];
  if (mode === 5 && Number.isFinite(codes[start + 1])) {
    return { value: ansi256Color(codes[start + 1] ?? 0), nextIndex: start + 2 };
  }
  if (mode === 2 && Number.isFinite(codes[start + 1]) && Number.isFinite(codes[start + 2]) && Number.isFinite(codes[start + 3])) {
    return { value: rgbColor(codes[start + 1] ?? 0, codes[start + 2] ?? 0, codes[start + 3] ?? 0), nextIndex: start + 4 };
  }
  return null;
}

function ansi256Color(value: number) {
  const index = clampColorByte(value);
  if (index < 8) return ansiBasicColors[index] ?? "#ffffff";
  if (index < 16) return ansiBrightColors[index - 8] ?? "#ffffff";
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return rgbColor(level, level, level);
  }

  const colorIndex = index - 16;
  const levels = [0, 95, 135, 175, 215, 255];
  return rgbColor(
    levels[Math.floor(colorIndex / 36) % 6] ?? 0,
    levels[Math.floor(colorIndex / 6) % 6] ?? 0,
    levels[colorIndex % 6] ?? 0
  );
}

function rgbColor(red: number, green: number, blue: number) {
  return `rgb(${clampColorByte(red)}, ${clampColorByte(green)}, ${clampColorByte(blue)})`;
}

function clampColorByte(value: number) {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function consumeMinecraftLegacyControl(text: string, start: number, style: ConsoleTextStyle) {
  const code = text[start + 1]?.toLowerCase();
  if (!code) return null;
  const color = minecraftLegacyColors[code];
  if (color) {
    resetConsoleTextStyle(style);
    style.foreground = color;
    return start + 2;
  }

  if (code === "r") resetConsoleTextStyle(style);
  else if (code === "l") style.bold = true;
  else if (code === "m") style.strike = true;
  else if (code === "n") style.underline = true;
  else if (code === "o") style.italic = true;
  else if (code !== "k") return null;
  return start + 2;
}

function collapsibleAgentLogTitle(content: string) {
  const firstLine = content.trim().split(/\r?\n/, 1)[0] ?? "";
  if (firstLine.startsWith("调用工具：")) return firstLine;
  if (firstLine.startsWith("工具结果：")) return firstLine;
  if (firstLine.startsWith("工具调用失败")) return firstLine;
  return "";
}

function isCollapsibleAgentLog(content: string) {
  return Boolean(collapsibleAgentLogTitle(content));
}

function statusText(status: ServerRecord["status"]) {
  const labels: Record<ServerRecord["status"], string> = {
    running: "运行中",
    starting: "启动中",
    stopping: "关闭中",
    stopped: "已停止",
    crashed: "异常退出",
    orphaned: "疑似后台残留"
  };
  return labels[status];
}

function agentStatusLabel(status: AgentStatus) {
  return {
    idle: "空闲",
    thinking: "分析中",
    running: "执行中",
    waiting_confirmation: "等待确认",
    retrying: "等待重试",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消"
  }[status];
}

function dismissStatusBubble(id: number | undefined) {
  if (id === undefined) return;
  const timer = statusBubbleTimers.get(id);
  if (timer) clearTimeout(timer);
  statusBubbleTimers.delete(id);
  statusBubbles.value = statusBubbles.value.filter((bubble) => bubble.id !== id);
  if (modelStatusBubbleId === id) modelStatusBubbleId = undefined;
  if (providerKeyStatusBubbleId === id) providerKeyStatusBubbleId = undefined;
  if (socketStatusBubbleId === id) socketStatusBubbleId = undefined;
  for (const [downloadId, bubbleId] of agentDownloadStatusBubbleIds.entries()) {
    if (bubbleId === id) agentDownloadStatusBubbleIds.delete(downloadId);
  }
}

function scheduleStatusBubbleDismiss(id: number, durationMs: number) {
  const timer = statusBubbleTimers.get(id);
  if (timer) clearTimeout(timer);
  statusBubbleTimers.delete(id);
  if (durationMs > 0) {
    statusBubbleTimers.set(id, setTimeout(() => dismissStatusBubble(id), durationMs));
  }
}

function showStatusBubble(type: StatusBubbleType, message: string, durationMs = 0, download?: AgentDownloadProgress, action?: { label: string; key: string }) {
  const id = ++nextStatusBubbleId;
  statusBubbles.value = [...statusBubbles.value, { id, type, message, durationMs, progressKey: ++nextStatusBubbleProgressKey, download, actionLabel: action?.label, actionKey: action?.key }];
  scheduleStatusBubbleDismiss(id, durationMs);
  return id;
}

function updateStatusBubble(id: number, type: StatusBubbleType, message: string, durationMs = 0, download?: AgentDownloadProgress, action?: { label: string; key: string }) {
  let updated = false;
  statusBubbles.value = statusBubbles.value.map((bubble) => {
    if (bubble.id !== id) return bubble;
    updated = true;
    return { ...bubble, type, message, durationMs, progressKey: ++nextStatusBubbleProgressKey, download, actionLabel: action?.label, actionKey: action?.key };
  });
  if (!updated) return undefined;
  scheduleStatusBubbleDismiss(id, durationMs);
  return id;
}

function upsertStatusBubble(id: number | undefined, type: StatusBubbleType, message: string, durationMs = 0, download?: AgentDownloadProgress, action?: { label: string; key: string }) {
  if (id !== undefined) {
    const updatedId = updateStatusBubble(id, type, message, durationMs, download, action);
    if (updatedId !== undefined) return updatedId;
  }
  return showStatusBubble(type, message, durationMs, download, action);
}

function hasStatusBubble(id: number | undefined) {
  return id !== undefined && statusBubbles.value.some((bubble) => bubble.id === id);
}

function clearStatusBubbles() {
  for (const timer of statusBubbleTimers.values()) clearTimeout(timer);
  statusBubbleTimers.clear();
  statusBubbles.value = [];
  modelStatusBubbleId = undefined;
  providerKeyStatusBubbleId = undefined;
  socketStatusBubbleId = undefined;
  agentDownloadStatusBubbleIds.clear();
}

function showModelStatus(type: "loading" | "success" | "error", message: string) {
  const durationMs = type === "loading" ? 0 : type === "error" ? 5000 : 3000;
  const id = upsertStatusBubble(modelStatusBubbleId, type, message, durationMs);
  if (type === "loading") modelStatusBubbleId = id;
  else modelStatusBubbleId = undefined;
}

function showProviderKeyStatus(type: "loading" | "success" | "error", message: string, withAction = false) {
  const durationMs = type === "loading" ? 0 : type === "error" && withAction ? 0 : type === "error" ? 6000 : 3000;
  const id = upsertStatusBubble(providerKeyStatusBubbleId, type, message, durationMs, undefined, withAction ? { label: "前往配置", key: "provider-keys" } : undefined);
  if (type === "loading" || withAction) providerKeyStatusBubbleId = id;
  else providerKeyStatusBubbleId = undefined;
}

function openSettings() {
  settingsOpen.value = true;
}

function openProviderKeyDialog(requirement?: AgentToolConfigRequirement | AgentToolConfigRequired) {
  if (requirement && "key" in requirement) {
    pendingToolConfig.value = {
      key: requirement.key,
      label: requirement.label,
      toolName: "toolName" in requirement ? requirement.toolName : undefined,
      helpUrl: requirement.helpUrl,
      message: "message" in requirement ? requirement.message : `需要配置 ${requirement.label}`
    };
  }
  providerKeyDialogOpen.value = true;
  settingsOpen.value = true;
}

function openProxyTestDialog() {
  proxyTestTarget.value = proxyTestTarget.value.trim() || "www.google.com";
  proxyTestResult.value = null;
  proxyTestDialogOpen.value = true;
  settingsOpen.value = true;
}

function closeProxyTestDialog() {
  if (proxyTesting.value) return;
  proxyTestDialogOpen.value = false;
}

function proxyTestResultText(result: ProxyTestResult) {
  if (result.ok) {
    const status = result.status ? `HTTP ${result.status}${result.statusText ? ` ${result.statusText}` : ""}` : "已连通";
    return `${status}，耗时 ${result.elapsedMs}ms`;
  }
  return `连接失败：${result.error || "未知错误"}，耗时 ${result.elapsedMs}ms`;
}

function compactText(value: string, maxLength = 52) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function toolMeta(tool: AgentToolRecord) {
  const parts = [tool.category || "Tool"];
  if (tool.configRequirements?.some((requirement) => requirement.required && !requirement.configured)) parts.push("需配置");
  return parts.join(" · ");
}

function closeProviderKeyDialog() {
  providerKeyDialogOpen.value = false;
  pendingToolConfig.value = null;
}

function providerKeyPlaceholder(key: ToolConfigKey) {
  const hint = key === "curseForgeApiKey" ? providerKeySettings.value.curseForgeApiKeyHint : providerKeySettings.value.modrinthApiKeyHint;
  return hint && hint !== "未配置" ? `${hint}（留空保留）` : "留空保留，输入后覆盖";
}

function handleStatusBubbleAction(item: StatusBubbleItem) {
  if (item.actionKey === "provider-keys") openProviderKeyDialog(pendingToolConfig.value ?? undefined);
}

function openFileDialog() {
  fileDialogOpen.value = true;
  configDialogOpen.value = false;
  void loadFiles().catch(() => undefined);
}

function openConfigDialog() {
  configDialogOpen.value = true;
  fileDialogOpen.value = false;
  void loadJavaState().catch(() => undefined);
}

function canRunAction(action: "start" | "stop" | "kill" | "restart") {
  const status = selectedServer.value?.status;
  if (!status) return false;
  if (action === "start") return status === "stopped" || status === "crashed";
  if (action === "restart") return status === "running" || status === "crashed" || status === "orphaned";
  if (action === "kill") return status === "running" || status === "starting" || status === "stopping" || status === "orphaned";
  return status === "running" || status === "starting" || status === "stopping";
}

const showAgentOutputLoading = computed(() => {
  if (!agentBusy.value) return false;
  let lastUserIndex = -1;
  let lastAgentOutputIndex = -1;
  agentMessages.value.forEach((message, index) => {
    if (message.role === "user") lastUserIndex = index;
    if (message.role === "agent" && message.content.trim()) lastAgentOutputIndex = index;
  });
  return lastAgentOutputIndex <= lastUserIndex;
});
const agentOutputLoadingText = computed(() => {
  if (agentStatus.value === "thinking") return "Agent 正在分析任务";
  if (agentStatus.value === "waiting_confirmation") return "等待确认后继续输出";
  return "Agent 正在执行。";
});

watch(selectedServer, (server) => {
  if (!server) return;
  Object.assign(serverForm, {
    name: server.name,
    javaPath: server.javaPath ?? "",
    javaVersion: server.javaVersion ?? "",
    minMemory: server.minMemory,
    maxMemory: server.maxMemory,
    jarFile: server.jarFile,
    startArgs: server.startArgs,
    startupCommand: server.startupCommand ?? "",
    minecraftVersion: server.minecraftVersion ?? "",
    modpackName: server.modpackName ?? "",
    promptOverride: server.promptOverride ?? "",
    useGlobalPrompt: Boolean(server.useGlobalPrompt)
  });
}, { immediate: true });

watch(settingsOpen, (open) => {
  if (open) void loadJavaState().catch(() => undefined);
});

watch(deploymentProgressDefaultDismissed, (dismissed) => {
  deploymentProgressDismissed.value = dismissed;
}, { immediate: true });

async function safe<T>(action: () => Promise<T>, serverId = selectedServerId.value) {
  try {
    return await action();
  } catch (error) {
    appendAgentMessage("system", `错误：${getErrorMessage(error)}`, "failed", serverId);
    throw error;
  }
}

function getErrorMessage(error: unknown) {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: { error?: unknown; message?: unknown } }).data;
    if (typeof data?.error === "string") return data.error;
    if (typeof data?.message === "string") return data.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function localMessageId() {
  return globalThis.crypto?.randomUUID?.() ?? `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function scrollHistoryListToBottom(getList: () => HTMLElement | null) {
  if (!process.client) return;
  const scroll = () => {
    const list = getList();
    if (list) list.scrollTop = list.scrollHeight;
  };
  void nextTick(() => requestAnimationFrame(() => {
    scroll();
    requestAnimationFrame(scroll);
  }));
}

function isNearListBottom(list: HTMLElement, threshold = 72) {
  return list.scrollHeight - list.scrollTop - list.clientHeight <= threshold;
}

function updateAgentScrollState() {
  const list = agentMessageList.value;
  showAgentScrollToBottom.value = Boolean(list && !isNearListBottom(list));
}

function shouldStickAgentToBottom(role?: AgentMessage["role"]) {
  if (role === "user") return true;
  const list = agentMessageList.value;
  return !list || isNearListBottom(list);
}

function scrollConsoleHistoryToBottom() {
  scrollHistoryListToBottom(() => consoleLogList.value);
}

function scrollAgentHistoryToBottom() {
  scrollHistoryListToBottom(() => agentMessageList.value);
  showAgentScrollToBottom.value = false;
}

function resetHistoryScrollPositions() {
  if (!process.client) return;
  void nextTick(() => {
    const list = consoleLogList.value;
    if (list) list.scrollTop = 0;
    const messages = agentMessageList.value;
    if (messages) messages.scrollTop = 0;
  });
}

function appendAgentMessage(role: AgentMessage["role"], content: string, status: AgentStatus | null = null, serverId = selectedServerId.value) {
  const shouldScroll = shouldStickAgentToBottom(role);
  agentMessages.value.push({ id: localMessageId(), serverId, role, content, status, createdAt: new Date().toISOString() });
  if (shouldScroll) scrollAgentHistoryToBottom();
  else updateAgentScrollState();
}

function upsertAgentMessage(id: string, role: AgentMessage["role"], content: string, status: AgentStatus | null, serverId = selectedServerId.value) {
  const shouldScroll = shouldStickAgentToBottom(role);
  const existingIndex = agentMessages.value.findIndex((message) => message.id === id);
  if (existingIndex >= 0) {
    const existing = agentMessages.value[existingIndex];
    if (!existing) return;
    existing.content = content;
    existing.status = status;
    if (role === "agent" && isTerminalAgentStatus(status ?? undefined) && existingIndex !== agentMessages.value.length - 1) {
      agentMessages.value.splice(existingIndex, 1);
      agentMessages.value.push(existing);
    }
  } else {
    agentMessages.value.push({ id, serverId, role, content, status, createdAt: new Date().toISOString() });
  }
  if (shouldScroll) scrollAgentHistoryToBottom();
  else updateAgentScrollState();
}

function appendAgentMessageDeltaNow(id: string, delta: string, serverId = selectedServerId.value) {
  const shouldScroll = shouldStickAgentToBottom("agent");
  const existingIndex = agentMessages.value.findIndex((message) => message.id === id);
  if (existingIndex >= 0) {
    const existing = agentMessages.value[existingIndex];
    if (!existing) return;
    existing.content += delta;
    if (existingIndex !== agentMessages.value.length - 1) {
      agentMessages.value.splice(existingIndex, 1);
      agentMessages.value.push(existing);
    }
  } else {
    agentMessages.value.push({ id, serverId, role: "agent", content: delta, status: "running", createdAt: new Date().toISOString() });
  }
  if (shouldScroll) scrollAgentHistoryToBottom();
  else updateAgentScrollState();
}

function appendAgentMessageDelta(id: string, delta: string, serverId = selectedServerId.value) {
  if (!delta) return;
  const buffer = agentStreamBuffers.get(id) ?? { queue: [], timer: null, serverId };
  buffer.serverId = serverId;
  buffer.queue.push(...Array.from(delta));
  agentStreamBuffers.set(id, buffer);
  scheduleAgentMessageDrain(id);
}

function scheduleAgentMessageDrain(id: string) {
  const buffer = agentStreamBuffers.get(id);
  if (!buffer || buffer.timer) return;
  buffer.timer = setTimeout(() => {
    buffer.timer = null;
    const next = buffer.queue.shift();
    if (next) appendAgentMessageDeltaNow(id, next, buffer.serverId);
    if (buffer.queue.length > 0) {
      scheduleAgentMessageDrain(id);
    } else {
      agentStreamBuffers.delete(id);
    }
  }, agentTypewriterDelayMs);
}

function flushAgentMessageBuffer(id: string) {
  const buffer = agentStreamBuffers.get(id);
  if (!buffer) return;
  if (buffer.timer) clearTimeout(buffer.timer);
  const remaining = buffer.queue.join("");
  agentStreamBuffers.delete(id);
  if (remaining) appendAgentMessageDeltaNow(id, remaining, buffer.serverId);
}

function clearAgentMessageBuffers() {
  for (const buffer of agentStreamBuffers.values()) {
    if (buffer.timer) clearTimeout(buffer.timer);
  }
  agentStreamBuffers.clear();
}

function isTerminalAgentStatus(status?: AgentStatus) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function clearAgentRetryState() {
  agentRetry.value = null;
  agentRetryNowSending.value = false;
}

async function refreshAfterAgentRun() {
  await Promise.all([loadServerDetail(), loadFiles(), loadPendingConfirmation()]);
}

async function syncAfterSocketReconnect(serverId: string) {
  if (serverId !== selectedServerId.value) return;
  await Promise.all([loadAgentMessages(), loadPendingConfirmation(), loadServerSlotStatus(), loadServerDetail(), loadFiles()]);
}

async function loadServers() {
  servers.value = await api<ServerRecord[]>("/api/servers");
  serversLoaded.value = true;
  if (!selectedServerId.value && servers.value[0]) selectedServerId.value = servers.value[0].id;
}

async function selectServer(id: string) {
  closeSockets();
  selectedServerId.value = id;
  currentPath.value = ".";
  settingsOpen.value = false;
  fileDialogOpen.value = false;
  configDialogOpen.value = false;
  clearAgentMessageBuffers();
  pendingAgentAttachments.value = [];
  agentDownloads.value = [];
  agentWorkflow.value = null;
  serverSlot.value = null;
  agentRetry.value = null;
  agentRetryNowSending.value = false;
  agentMessages.value = [];
  resetHistoryScrollPositions();
  await Promise.all([loadServerDetail(), loadLogs(), loadFiles(), loadAgentMessages(), loadPendingConfirmation(), loadServerSlotStatus()]);
  connectSockets();
}

async function loadServerDetail() {
  if (!selectedServerId.value) return;
  const server = await api<ServerRecord>(`/api/servers/${selectedServerId.value}`);
  const index = servers.value.findIndex((item) => item.id === server.id);
  if (index >= 0) servers.value[index] = server;
}

async function createServer() {
  const name = newServerName.value.trim();
  if (!name) return;
  const server = await safe(() => api<ServerRecord>("/api/servers", { method: "POST", body: { name } }));
  servers.value.unshift(server);
  createDialogOpen.value = false;
  await selectServer(server.id);
}

function openCreateServerDialog() {
  newServerName.value = "";
  createDialogOpen.value = true;
}

function closeCreateServerDialog() {
  createDialogOpen.value = false;
}

function openDeleteServer(server: ServerRecord) {
  deleteDialog.open = true;
  deleteDialog.server = server;
  deleteDialog.confirmName = "";
  deleteDialog.deleting = false;
  deleteDialog.error = "";
}

function closeDeleteServer() {
  if (deleteDialog.deleting) return;
  deleteDialog.open = false;
  deleteDialog.server = null;
  deleteDialog.confirmName = "";
  deleteDialog.error = "";
}

async function deleteServer() {
  const server = deleteDialog.server;
  if (!server || !deleteConfirmMatches.value || deleteDialog.deleting) return;
  const deletingSelectedServer = selectedServerId.value === server.id;
  deleteDialog.deleting = true;
  deleteDialog.error = "";
  try {
    await safe(() => api(`/api/servers/${server.id}`, { method: "DELETE", body: { confirmName: deleteDialog.confirmName.trim() } }));
    if (deletingSelectedServer) {
      closeSockets();
      selectedServerId.value = "";
      logs.value = [];
      files.value = [];
      agentMessages.value = [];
      pendingConfirmation.value = null;
      agentDownloads.value = [];
      agentWorkflow.value = null;
      serverSlot.value = null;
      agentRetry.value = null;
      agentRetryNowSending.value = false;
      currentPath.value = ".";
      agentStatus.value = "idle";
      fileDialogOpen.value = false;
      configDialogOpen.value = false;
      textEditor.open = false;
    }
    await loadServers();
    if (deletingSelectedServer && selectedServerId.value) await selectServer(selectedServerId.value);
    deleteDialog.open = false;
    deleteDialog.server = null;
    deleteDialog.confirmName = "";
    deleteDialog.error = "";
  } catch (error) {
    deleteDialog.error = getErrorMessage(error);
  } finally {
    deleteDialog.deleting = false;
  }
}

async function saveServerConfig() {
  if (!selectedServerId.value) return;
  const memory = memoryConfigValue(serverMemoryMb.value);
  await safe(() => api<ServerRecord>(`/api/servers/${selectedServerId.value}`, {
    method: "PATCH",
    body: {
      name: serverForm.name,
      javaPath: serverForm.javaPath || null,
      javaVersion: serverForm.javaVersion || null,
      minMemory: memory,
      maxMemory: memory,
      jarFile: serverForm.jarFile,
      startArgs: serverForm.startArgs,
      startupCommand: serverForm.startupCommand || null,
      minecraftVersion: serverForm.minecraftVersion || null,
      modpackName: serverForm.modpackName || null,
      promptOverride: serverForm.promptOverride || null,
      useGlobalPrompt: serverForm.useGlobalPrompt
    }
  }));
  await loadServers();
  configDialogOpen.value = false;
  showStatusBubble("success", "服务端配置已保存", 2400);
}

async function serverAction(action: "start" | "stop" | "kill" | "restart") {
  if (!selectedServerId.value) return;
  await safe(() => api(`/api/servers/${selectedServerId.value}/${action}`, { method: "POST" }));
  await loadServers();
}

async function loadLogs() {
  if (!selectedServerId.value) return;
  logs.value = await api<ConsoleLogEntry[]>(`/api/servers/${selectedServerId.value}/logs?limit=500`);
  scrollConsoleHistoryToBottom();
}

async function sendCommand() {
  if (!selectedServerId.value || !consoleCommand.value.trim()) return;
  const command = consoleCommand.value.trim();
  consoleCommand.value = "";
  if (consoleSocket?.readyState === WebSocket.OPEN) {
    consoleSocket.send(JSON.stringify({ type: "command", command }));
  } else {
    await safe(() => api(`/api/servers/${selectedServerId.value}/command`, { method: "POST", body: { command } }));
  }
}

async function loadFiles() {
  if (!selectedServerId.value) return;
  filesLoading.value = true;
  try {
    const nextFiles = await api<FileEntry[]>(`/api/servers/${selectedServerId.value}/files?path=${encodeURIComponent(currentPath.value)}`);
    files.value = nextFiles;
    const visiblePaths = new Set(nextFiles.map((file) => file.path));
    selectedFilePaths.value = selectedFilePaths.value.filter((path) => visiblePaths.has(path));
    if (fileSelectionAnchorPath.value && !visiblePaths.has(fileSelectionAnchorPath.value)) fileSelectionAnchorPath.value = selectedFilePaths.value.at(-1) ?? "";
  } finally {
    filesLoading.value = false;
  }
}

async function openFolder(path: string) {
  selectedFilePaths.value = [];
  fileSelectionAnchorPath.value = "";
  endFileDragSelection();
  currentPath.value = path;
  await loadFiles();
}

async function goUp() {
  if (currentPath.value === ".") return;
  const parts = currentPath.value.split("/").filter(Boolean);
  parts.pop();
  currentPath.value = parts.join("/") || ".";
  await loadFiles();
}

async function createFolder() {
  if (!selectedServerId.value || !newFolderName.value.trim()) return;
  const path = currentPath.value === "." ? newFolderName.value : `${currentPath.value}/${newFolderName.value}`;
  await safe(() => api(`/api/servers/${selectedServerId.value}/files/folder`, { method: "POST", body: { path } }));
  newFolderName.value = "";
  await loadFiles();
}

async function removeFile(path: string) {
  if (!selectedServerId.value || !confirm(`删除 ${path}？`)) return;
  await safe(() => api(`/api/servers/${selectedServerId.value}/files?path=${encodeURIComponent(path)}`, { method: "DELETE" }));
  selectedFilePaths.value = selectedFilePaths.value.filter((selectedPath) => selectedPath !== path);
  if (fileSelectionAnchorPath.value === path) fileSelectionAnchorPath.value = selectedFilePaths.value.at(-1) ?? "";
  await loadFiles();
}

async function removeSelectedFiles() {
  if (!selectedServerId.value || selectedFiles.value.length === 0) return;
  const paths = selectedFiles.value.map((file) => file.path);
  if (!confirm(`删除选中的 ${paths.length} 项？`)) return;
  for (const path of paths) {
    await safe(() => api(`/api/servers/${selectedServerId.value}/files?path=${encodeURIComponent(path)}`, { method: "DELETE" }));
  }
  selectedFilePaths.value = [];
  fileSelectionAnchorPath.value = "";
  await loadFiles();
}

async function renameFile(path: string) {
  if (!selectedServerId.value) return;
  const newName = prompt("新名称", path.split("/").at(-1));
  if (!newName) return;
  await safe(() => api(`/api/servers/${selectedServerId.value}/files/rename`, { method: "POST", body: { path, newName } }));
  selectedFilePaths.value = [];
  fileSelectionAnchorPath.value = "";
  await loadFiles();
}

function orderedUniqueFilePaths(paths: string[]) {
  const selected = new Set(paths);
  return sortedFiles.value.map((file) => file.path).filter((path) => selected.has(path));
}

function rangeFilePaths(fromPath: string, toPath: string) {
  const paths = sortedFiles.value.map((file) => file.path);
  const fromIndex = paths.indexOf(fromPath);
  const toIndex = paths.indexOf(toPath);
  if (fromIndex === -1 || toIndex === -1) return [toPath];
  const start = Math.min(fromIndex, toIndex);
  const end = Math.max(fromIndex, toIndex);
  return paths.slice(start, end + 1);
}

function selectFile(path: string, event?: MouseEvent) {
  if (event?.shiftKey) {
    const anchorPath = fileSelectionAnchorPath.value || selectedFilePaths.value.at(-1) || path;
    const rangePaths = rangeFilePaths(anchorPath, path);
    selectedFilePaths.value = event.ctrlKey || event.metaKey
      ? orderedUniqueFilePaths([...selectedFilePaths.value, ...rangePaths])
      : rangePaths;
    fileSelectionAnchorPath.value = anchorPath;
    return;
  }

  if (event?.ctrlKey || event?.metaKey) {
    toggleSelectedFile(path);
    fileSelectionAnchorPath.value = path;
    return;
  }

  selectedFilePaths.value = [path];
  fileSelectionAnchorPath.value = path;
}

function toggleSelectedFile(path: string) {
  selectedFilePaths.value = selectedFilePaths.value.includes(path)
    ? selectedFilePaths.value.filter((selectedPath) => selectedPath !== path)
    : [...selectedFilePaths.value, path];
  fileSelectionAnchorPath.value = path;
}

function beginFileDragSelection(path: string, event: MouseEvent) {
  if (event.button !== 0) return;
  selectFile(path, event);
  fileDragSelecting.value = true;
  fileDragSelectedPaths = new Set(selectedFilePaths.value);
}

function dragSelectFile(path: string) {
  if (!fileDragSelecting.value || fileDragSelectedPaths.has(path)) return;
  fileDragSelectedPaths.add(path);
  selectedFilePaths.value = orderedUniqueFilePaths([...selectedFilePaths.value, path]);
}

function endFileDragSelection() {
  fileDragSelecting.value = false;
  fileDragSelectedPaths.clear();
}

async function openFileEntry(file: FileEntry) {
  if (file.type === "directory") {
    await openFolder(file.path);
    return;
  }
  if (file.editable) await editFile(file.path);
}

function showFileProperties(file: FileEntry) {
  const details = [
    `名称：${file.name}`,
    `路径：${file.path}`,
    `类型：${file.type === "directory" ? "文件夹" : "文件"}`,
    file.type === "file" ? `大小：${formatBytes(file.size)}` : "大小：不适用",
    `修改时间：${new Date(file.modifiedAt).toLocaleString()}`,
    `可编辑：${file.editable ? "是" : "否"}`
  ];
  alert(details.join("\n"));
}

async function editFile(path: string) {
  if (!selectedServerId.value) return;
  const result = await safe(() => api<{ content: string }>(`/api/servers/${selectedServerId.value}/files/text?path=${encodeURIComponent(path)}`));
  textEditor.path = path;
  textEditor.content = result?.content ?? "";
  textEditor.open = true;
}

async function saveTextFile() {
  if (!selectedServerId.value) return;
  await safe(() => api(`/api/servers/${selectedServerId.value}/files/text`, { method: "PUT", body: { path: textEditor.path, content: textEditor.content } }));
  textEditor.open = false;
  await loadFiles();
}

async function uploadServerFile(event: Event) {
  if (!selectedServerId.value) return;
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const form = new FormData();
  form.append("path", currentPath.value);
  form.append("file", file);
  beginUpload(serverUpload, file);
  try {
    await safe(() => upload(`/api/servers/${selectedServerId.value}/files/upload`, form, {
      onProgress: (progress) => updateUploadProgress(serverUpload, progress)
    }));
    finishUpload(serverUpload);
    await loadFiles();
  } catch (error) {
    failUpload(serverUpload);
    throw error;
  } finally {
    input.value = "";
  }
}

async function loadAgentMessages() {
  if (!selectedServerId.value) return;
  agentMessages.value = await api<AgentMessage[]>(`/api/servers/${selectedServerId.value}/agent/messages`);
  scrollAgentHistoryToBottom();
}

async function loadPendingConfirmation() {
  if (!selectedServerId.value) return;
  const result = await api<{ confirmation: AgentConfirmationRequest | null }>(`/api/servers/${selectedServerId.value}/agent/confirmation`);
  pendingConfirmation.value = result.confirmation;
}

async function loadServerSlotStatus() {
  if (!selectedServerId.value) return;
  serverSlot.value = await api<ServerSlotStatus>(`/api/servers/${selectedServerId.value}/agent/server-slot`);
}

async function sendAgentMessage() {
  if (!selectedServerId.value || (!agentInput.value.trim() && pendingAgentAttachments.value.length === 0) || agentBusy.value) return;
  const serverId = selectedServerId.value;
  const textContent = agentInput.value.trim();
  const attachments = [...pendingAgentAttachments.value];
  const attachmentContent = formatAgentAttachmentMessage(attachments);
  const content = [textContent, attachmentContent].filter(Boolean).join("\n\n");
  const reasoningEffort = agentReasoningEffort.value;
  agentInput.value = "";
  pendingAgentAttachments.value = [];
  appendAgentMessage("user", content, null, serverId);
  agentStatus.value = "thinking";

  let confirmationPoll: ReturnType<typeof setInterval> | undefined;
  if (agentSocket?.readyState === WebSocket.OPEN) {
    agentSocket.send(JSON.stringify({ type: "message", content, reasoningEffort }));
  } else {
    confirmationPoll = setInterval(() => {
      if (serverId === selectedServerId.value) loadPendingConfirmation().catch(() => undefined);
    }, 1000);

    try {
      const result = await safe(() => api<{ response: string }>(`/api/servers/${serverId}/agent/messages`, { method: "POST", body: { content, reasoningEffort } }));
      if (serverId === selectedServerId.value && result.response) {
        appendAgentMessage("agent", result.response, result.response.startsWith("执行失败：") ? "failed" : "completed", serverId);
        agentStatus.value = result.response.startsWith("执行失败：") ? "failed" : "completed";
        await refreshAfterAgentRun();
      }
    } catch {
      if (serverId === selectedServerId.value) {
        agentStatus.value = "failed";
        agentInput.value = textContent;
        pendingAgentAttachments.value = attachments;
      }
    } finally {
      if (confirmationPoll) clearInterval(confirmationPoll);
    }
  }
}

function formatAgentAttachmentMessage(attachments: PendingAgentAttachment[]) {
  if (attachments.length === 0) return "";
  return [
    "本条消息附带以下已上传到当前服务端目录的文件：",
    ...attachments.map((attachment) => `- ${attachment.originalName}，服务端路径=${attachment.path}`),
    "这些文件已经位于当前服务端目录内；请结合这条文字消息处理附件，可使用 list_server_files 和 read_server_text_file 直接查看文本文件内容。"
  ].join("\n");
}

async function resolveAgentConfirmation(approved: boolean) {
  if (!selectedServerId.value || !pendingConfirmation.value) return;
  const confirmationId = pendingConfirmation.value.id;
  pendingConfirmation.value = null;
  if (agentSocket?.readyState === WebSocket.OPEN) {
    agentSocket.send(JSON.stringify({ type: "confirmation", confirmationId, approved }));
  } else {
    await safe(() => api(`/api/servers/${selectedServerId.value}/agent/confirmation`, { method: "POST", body: { confirmationId, approved } }));
    agentStatus.value = approved ? "running" : "failed";
  }
}

async function cancelAgentRun() {
  if (!selectedServerId.value || !agentBusy.value) return;
  const serverId = selectedServerId.value;
  pendingConfirmation.value = null;
  agentRetry.value = null;
  agentRetryNowSending.value = false;
  agentStatus.value = "cancelled";
  if (agentSocket?.readyState === WebSocket.OPEN) {
    agentSocket.send(JSON.stringify({ type: "cancel" }));
  } else {
    await safe(() => api(`/api/servers/${serverId}/agent/cancel`, { method: "POST" }), serverId);
  }
  window.setTimeout(clearTerminalAgentDownloads, 1600);
}

async function retryAgentNow() {
  if (!selectedServerId.value || agentStatus.value !== "retrying" || agentRetryNowSending.value) return;
  const serverId = selectedServerId.value;
  agentRetryNowSending.value = true;
  try {
    if (agentSocket?.readyState === WebSocket.OPEN) {
      agentSocket.send(JSON.stringify({ type: "retry" }));
    } else {
      await safe(() => api(`/api/servers/${serverId}/agent/retry`, { method: "POST" }), serverId);
    }
    if (serverId === selectedServerId.value) agentRetry.value = null;
  } finally {
    if (serverId === selectedServerId.value) agentRetryNowSending.value = false;
  }
}

async function clearAgentContext() {
  if (!selectedServerId.value || agentBusy.value) return;
  const firstConfirm = confirm("确定清除当前服务端的 Agent 上下文吗？这会删除当前对话记录。文件和服务端配置不会被删除。");
  if (!firstConfirm) return;
  const secondConfirm = confirm("请再次确认：清除后 Agent 将不再看到这些历史对话。继续？");
  if (!secondConfirm) return;
  const serverId = selectedServerId.value;
  await safe(() => api(`/api/servers/${serverId}/agent/context`, { method: "DELETE" }), serverId);
  if (serverId !== selectedServerId.value) return;
  clearAgentMessageBuffers();
  agentMessages.value = [];
  pendingConfirmation.value = null;
  pendingAgentAttachments.value = [];
  agentDownloads.value = [];
  agentWorkflow.value = null;
  agentRetry.value = null;
  agentRetryNowSending.value = false;
  agentStatus.value = "idle";
}

async function uploadAgentFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file || !selectedServerId.value) return;
  const form = new FormData();
  form.append("path", ".");
  form.append("file", file);
  beginUpload(agentUpload, file);
  try {
    const result = await safe(() => upload<{ path: string }>(`/api/servers/${selectedServerId.value}/files/upload`, form, {
      onProgress: (progress) => updateUploadProgress(agentUpload, progress)
    }));
    finishUpload(agentUpload);
    if (result?.path) {
      pendingAgentAttachments.value.push({ path: result.path, originalName: file.name });
      await loadFiles();
    }
  } catch (error) {
    failUpload(agentUpload);
    throw error;
  } finally {
    input.value = "";
  }
}

function removePendingAgentAttachment(path: string) {
  pendingAgentAttachments.value = pendingAgentAttachments.value.filter((attachment) => attachment.path !== path);
}

function openAgentUploadPicker() {
  if (agentBusy.value) {
    appendAgentMessage("system", "Agent 正在处理当前任务，请等待完成后再上传文件。", null);
    return;
  }
  agentUploadInput.value?.click();
}

async function loadSettings() {
  const [modelData, skillData, toolData, promptData, agentSettings, providerKeys, javaData] = await Promise.all([
    api<ModelConfig[]>("/api/models"),
    api<SkillRecord[]>("/api/skills"),
    api<AgentToolRecord[]>("/api/tools"),
    api<{ prompt: string }>("/api/prompts/global"),
    api<AgentSettings>("/api/settings/agent"),
    api<AgentToolSettings>("/api/settings/provider-keys"),
    api<JavaManagementState>("/api/java")
  ]);
  models.value = modelData;
  const model = modelData[0];
  if (model) {
    Object.assign(modelForm, {
      displayName: fixedModelDisplayName,
      baseUrl: model.baseUrl,
      modelName: model.modelName,
      apiKey: "",
      isDefault: true
    });
  }
  skills.value = skillData;
  agentTools.value = toolData;
  globalPrompt.value = promptData.prompt;
  providerKeySettings.value = providerKeys;
  providerKeyForm.curseForgeApiKey = "";
  providerKeyForm.modrinthApiKey = "";
  agentAutoConfirm.value = agentSettings.autoConfirm;
  agentDownloadProxyEnabled.value = agentSettings.downloadProxyEnabled;
  agentDownloadProxyUrl.value = agentSettings.downloadProxyUrl;
  agentMemoryMb.value = agentSettings.memoryMb;
  systemMemoryMb.value = agentSettings.systemMemoryMb;
  applyJavaState(javaData);
}

async function loadJavaState() {
  applyJavaState(await api<JavaManagementState>("/api/java"));
}

function applyJavaState(state: JavaManagementState) {
  javaVersions.value = state.versions;
  javaInstalls.value = state.installed;
  javaTasks.value = state.tasks;
  javaDownloadSources.value = state.sources;
  if (!javaVersions.value.some((version) => version.version === javaVersionToInstall.value)) {
    javaVersionToInstall.value = javaVersions.value.find((version) => version.version === "21")?.version ?? javaVersions.value[0]?.version ?? javaVersionToInstall.value;
  }
  if (!serverForm.javaVersion || !javaVersions.value.some((version) => version.version === serverForm.javaVersion && version.installed && version.installPath)) {
    serverForm.javaVersion = javaVersions.value.find((version) => version.installed && version.installPath)?.version ?? "";
  }
  applyServerJavaSelection();
  if (!javaDownloadSources.value.some((source) => source.id === javaDownloadSource.value)) {
    javaDownloadSource.value = javaDownloadSources.value.find((source) => source.id === "auto-cn")?.id ?? javaDownloadSources.value[0]?.id ?? javaDownloadSource.value;
  }
}

async function saveModel() {
  if (modelBusy.value) return;
  modelSaving.value = true;
  showModelStatus("loading", "正在保存模型配置...");
  modelForm.displayName = fixedModelDisplayName;
  const body = {
    displayName: fixedModelDisplayName,
    baseUrl: modelForm.baseUrl,
    modelName: modelForm.modelName,
    apiKey: modelForm.apiKey || undefined,
    isDefault: true
  };
  try {
    const currentModelId = models.value[0]?.id;
    const saved = currentModelId
      ? await safe(() => api<ModelConfig>(`/api/models/${encodeURIComponent(currentModelId)}`, { method: "PATCH", body }))
      : await safe(() => api<ModelConfig>("/api/models", { method: "POST", body }));
    models.value = saved ? [saved] : [];
    if (saved) {
      Object.assign(modelForm, {
        displayName: fixedModelDisplayName,
        baseUrl: saved.baseUrl,
        modelName: saved.modelName,
        apiKey: "",
        isDefault: true
      });
    } else {
      modelForm.apiKey = "";
    }
    showModelStatus("success", "模型配置已保存");
  } catch (error) {
    showModelStatus("error", `保存失败：${getErrorMessage(error)}`);
  } finally {
    modelSaving.value = false;
  }
}

async function testModel(id?: string) {
  if (modelBusy.value || (!id && hasUnsavedApiKey.value)) return;
  modelTesting.value = true;
  showModelStatus("loading", "正在测试模型连接...");
  const body = id ? { id } : {
    baseUrl: modelForm.baseUrl,
    modelName: modelForm.modelName
  };
  try {
    await safe(() => api("/api/models/test", { method: "POST", body }));
    showModelStatus("success", "模型连通性测试通过");
  } catch (error) {
    showModelStatus("error", `测试失败：${getErrorMessage(error)}`);
  } finally {
    modelTesting.value = false;
  }
}

async function saveGlobalPrompt() {
  await safe(() => api("/api/prompts/global", { method: "PUT", body: { prompt: globalPrompt.value } }));
}

async function resetGlobalPrompt() {
  const result = await safe(() => api<{ prompt: string }>("/api/prompts/global/reset", { method: "POST" }));
  globalPrompt.value = result?.prompt ?? globalPrompt.value;
}

async function saveAgentSettings() {
  const result = await safe(() => api<AgentSettings>("/api/settings/agent", {
    method: "PUT",
    body: {
      autoConfirm: agentAutoConfirm.value,
      downloadProxyEnabled: agentDownloadProxyEnabled.value,
      downloadProxyUrl: agentDownloadProxyUrl.value,
      memoryMb: agentMemoryMb.value
    }
  }));
  if (!result) return;
  agentAutoConfirm.value = result.autoConfirm;
  agentDownloadProxyEnabled.value = result.downloadProxyEnabled;
  agentDownloadProxyUrl.value = result.downloadProxyUrl;
  agentMemoryMb.value = result.memoryMb;
  systemMemoryMb.value = result.systemMemoryMb;
}

async function testProxyConnectivity() {
  if (proxyTesting.value) return;
  proxyTesting.value = true;
  proxyTestResult.value = null;
  const target = proxyTestTarget.value.trim() || "www.google.com";
  try {
    const result = await api<ProxyTestResult>("/api/settings/agent/proxy/test", {
      method: "POST",
      body: {
        target,
        downloadProxyEnabled: agentDownloadProxyEnabled.value,
        downloadProxyUrl: agentDownloadProxyUrl.value
      }
    });
    proxyTestResult.value = result;
    showStatusBubble(result.ok ? "success" : "error", proxyTestResultText(result), result.ok ? 3200 : 6200);
  } catch (error) {
    const message = getErrorMessage(error);
    showStatusBubble("error", `代理检测失败：${message}`, 6200);
    proxyTestResult.value = {
      ok: false,
      targetUrl: target,
      proxyEnabled: agentDownloadProxyEnabled.value,
      usedProxy: agentDownloadProxyEnabled.value,
      status: null,
      statusText: "",
      finalUrl: target,
      elapsedMs: 0,
      error: message
    };
  } finally {
    proxyTesting.value = false;
  }
}

async function saveProviderKeys() {
  if (providerKeySaving.value) return;
  providerKeySaving.value = true;
  showProviderKeyStatus("loading", "正在保存平台 API Key...");
  try {
    const result = await safe(() => api<AgentToolSettings>("/api/settings/provider-keys", {
      method: "PUT",
      body: {
        curseForgeApiKey: providerKeyForm.curseForgeApiKey || undefined,
        modrinthApiKey: providerKeyForm.modrinthApiKey || undefined
      }
    }));
    if (result) providerKeySettings.value = result;
    providerKeyForm.curseForgeApiKey = "";
    providerKeyForm.modrinthApiKey = "";
    showProviderKeyStatus("success", "平台 API Key 已保存");
    await loadSettings();
    closeProviderKeyDialog();
  } catch (error) {
    showProviderKeyStatus("error", `保存平台 API Key 失败：${getErrorMessage(error)}`);
  } finally {
    providerKeySaving.value = false;
  }
}

async function toggleSkill(skill: SkillRecord) {
  await safe(() => api(`/api/skills/${skill.id}`, { method: "PATCH", body: { enabled: !skill.enabled } }));
  await loadSettings();
}

async function installJava(version: string) {
  const normalized = version.trim();
  if (!normalized) return;
  const task = await safe(() => api<JavaInstallTask>("/api/java/install", { method: "POST", body: { version: normalized, source: javaDownloadSource.value } }));
  if (task) mergeJavaTask(task);
  await loadJavaState();
}

async function cancelJavaInstall(version: string) {
  const normalized = version.trim();
  if (!normalized) return;
  const task = await safe(() => api<JavaInstallTask | null>("/api/java/install/cancel", { method: "POST", body: { version: normalized } }));
  if (task) mergeJavaTask(task);
  await loadJavaState();
}

function mergeJavaTask(task: JavaInstallTask) {
  javaTasks.value = [task, ...javaTasks.value.filter((item) => item.version !== task.version)];
  javaVersions.value = javaVersions.value.map((version) => version.version === task.version ? { ...version, task } : version);
}

async function useJavaVersion(java: JavaVersionRecord) {
  if (!java.installPath) return;
  serverForm.javaPath = java.installPath;
  serverForm.javaVersion = java.version;
  await saveServerConfig();
}

function parseMemoryToMb(value: string | number | null | undefined) {
  if (typeof value === "number") return Number.isFinite(value) ? value : minimumServerMemoryMb;
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d+(?:\.\d+)?)\s*([gGmM])?$/);
  if (!match) return minimumServerMemoryMb;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return minimumServerMemoryMb;
  return match[2]?.toLowerCase() === "g" ? amount * 1024 : amount;
}

function clampServerMemoryMb(value: number) {
  const max = serverMemoryMaxMb.value || systemMemoryMb.value || minimumServerMemoryMb;
  return Math.min(max, Math.max(minimumServerMemoryMb, Math.round(value / 512) * 512));
}

function memoryConfigValue(valueMb: number) {
  const normalized = clampServerMemoryMb(valueMb);
  return normalized % 1024 === 0 ? `${normalized / 1024}G` : `${normalized}M`;
}

function applyServerJavaSelection() {
  const selected = javaVersions.value.find((version) => version.version === serverForm.javaVersion && version.installPath);
  serverForm.javaPath = selected?.installPath ?? "";
}

function isJavaTaskActive(status: JavaInstallTaskStatus) {
  return !["installed", "failed", "cancelled"].includes(status);
}

function isJavaTaskCancellable(status: JavaInstallTaskStatus) {
  return isJavaTaskActive(status) && status !== "cancelling";
}

function javaStatusText(java: JavaVersionRecord) {
  if (java.task?.status === "failed") return "失败";
  if (java.task?.status === "cancelled") return "已取消";
  if (java.task?.status === "cancelling") return "取消中";
  if (java.task && isJavaTaskActive(java.task.status)) return "安装中";
  if (java.installed) return "已安装";
  return "未安装";
}

function javaStatusClass(java: JavaVersionRecord) {
  if (java.task?.status === "failed") return "risk-high";
  if (java.task?.status === "cancelled") return "";
  if (java.task && isJavaTaskActive(java.task.status)) return "risk-medium";
  if (java.installed) return "status-running";
  return "";
}

function formatBytes(bytes: number) {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatMemoryMb(value: number) {
  return value >= 1024 ? `${(value / 1024).toFixed(value % 1024 === 0 ? 0 : 1)} GB` : `${value} MB`;
}

function beginUpload(state: UploadState, file: File) {
  state.active = true;
  state.fileName = file.name;
  state.loaded = 0;
  state.total = file.size;
  state.percent = 0;
  state.done = false;
}

function updateUploadProgress(state: UploadState, progress: UploadProgress) {
  state.loaded = progress.loaded;
  state.total = progress.total || state.total;
  state.percent = progress.percent;
}

function finishUpload(state: UploadState) {
  state.loaded = state.total;
  state.percent = 100;
  state.done = true;
  window.setTimeout(() => {
    state.active = false;
    state.done = false;
  }, 900);
}

function failUpload(state: UploadState) {
  state.active = false;
  state.done = false;
}

function uploadDetail(state: UploadState) {
  if (state.done) return "上传完成";
  if (state.total > 0) return `${formatBytes(Math.min(state.loaded, state.total))} / ${formatBytes(state.total)}`;
  return "正在上传";
}

function agentDownloadStatusText(status: AgentDownloadProgress["status"]) {
  return {
    starting: "准备下载",
    downloading: "正在下载",
    completed: "下载完成",
    cancelled: "已中断",
    failed: "下载失败"
  }[status];
}

function agentDownloadDetail(download: AgentDownloadProgress) {
  if (download.error) return download.error;
  if (download.totalBytes) return `${formatBytes(Math.min(download.loadedBytes, download.totalBytes))} / ${formatBytes(download.totalBytes)}`;
  if (download.loadedBytes > 0) return `已下载 ${formatBytes(download.loadedBytes)}`;
  return download.destinationPath;
}

function workflowStatusText(status: AgentWorkflowStepStatus) {
  return {
    pending: "等待中",
    running: "进行中",
    completed: "已完成",
    failed: "失败"
  }[status];
}

function workflowStepClass(status: AgentWorkflowStepStatus) {
  return {
    pending: "",
    running: "risk-medium",
    completed: "status-running",
    failed: "risk-high"
  }[status];
}

function serverSlotDetail(slot: ServerSlotStatus | null) {
  if (!slot) return "正在读取服务端包状态";
  if (!slot.occupied) return "等待上传或下载服务端包";
  const size = slot.size === null ? "未知大小" : formatBytes(slot.size);
  return `${slot.fileName} · ${size}`;
}

function mergeAgentDownload(download: AgentDownloadProgress) {
  const index = agentDownloads.value.findIndex((item) => item.id === download.id);
  if (index >= 0) agentDownloads.value[index] = download;
  else agentDownloads.value.unshift(download);

  const terminal = ["completed", "cancelled", "failed"].includes(download.status);
  const type: StatusBubbleType = download.status === "failed" || download.status === "cancelled" ? "error" : terminal ? "success" : "loading";
  const durationMs = terminal ? (type === "error" ? 5000 : 3000) : 0;
  const message = `${agentDownloadStatusText(download.status)} ${download.fileName}`;
  const bubbleId = upsertStatusBubble(agentDownloadStatusBubbleIds.get(download.id), type, message, durationMs, download);
  agentDownloadStatusBubbleIds.set(download.id, bubbleId);
}

function clearTerminalAgentDownloads() {
  agentDownloads.value = agentDownloads.value.filter((download) => !["completed", "cancelled", "failed"].includes(download.status));
}

function javaTaskDetail(task: JavaInstallTask) {
  if (task.status === "downloading" && task.totalBytes) {
    return `${task.message}（${task.sourceLabel}）：${formatBytes(task.downloadedBytes)} / ${formatBytes(task.totalBytes)}`;
  }
  if (task.error) return task.error;
  return task.sourceLabel ? `${task.message}（${task.sourceLabel}）` : task.message;
}

function startJavaPolling() {
  if (!process.client || javaPollTimer) return;
  javaPollTimer = setInterval(() => {
    if (!javaHasActiveTasks.value) return;
    void loadJavaState().catch(() => undefined);
  }, 1000);
}

function startAgentRetryClock() {
  if (!process.client || agentRetryClockTimer) return;
  agentRetryClockTimer = setInterval(() => {
    if (agentRetry.value) agentRetryClock.value = Date.now();
  }, 1000);
}

function showSocketStatus(type: "loading" | "success" | "error", message: string, timeoutMs = 0) {
  socketStatusBubbleId = upsertStatusBubble(socketStatusBubbleId, type, message, timeoutMs);
}

function closeSockets() {
  socketsClosedIntentionally = true;
  socketReconnectGeneration += 1;
  socketReconnectAttempt = 0;
  if (socketReconnectTimer) clearTimeout(socketReconnectTimer);
  socketReconnectTimer = undefined;
  consoleSocket?.close();
  agentSocket?.close();
  consoleSocket = undefined;
  agentSocket = undefined;
  dismissStatusBubble(socketStatusBubbleId);
}

function scheduleSocketReconnect(serverId: string, generation: number) {
  if (!process.client || socketsClosedIntentionally || serverId !== selectedServerId.value || generation !== socketReconnectGeneration) return;
  socketReconnectAttempt += 1;
  const delay = Math.min(socketReconnectMaxDelayMs, socketReconnectBaseDelayMs * 2 ** Math.min(socketReconnectAttempt - 1, 4));
  showSocketStatus("loading", `实时连接已断开，${Math.ceil(delay / 1000)} 秒后自动重连（第 ${socketReconnectAttempt} 次）`);
  if (socketReconnectTimer) clearTimeout(socketReconnectTimer);
  socketReconnectTimer = setTimeout(() => {
    socketReconnectTimer = undefined;
    connectSockets(false, generation);
  }, delay);
}

function connectSockets(resetReconnect = true, generation = socketReconnectGeneration) {
  if (resetReconnect) {
    socketReconnectGeneration += 1;
    generation = socketReconnectGeneration;
    socketReconnectAttempt = 0;
  }
  socketsClosedIntentionally = false;
  if (socketReconnectTimer) clearTimeout(socketReconnectTimer);
  socketReconnectTimer = undefined;
  consoleSocket?.close();
  agentSocket?.close();
  if (!selectedServerId.value || !process.client) return;
  const serverId = selectedServerId.value;
  const configuredWsBase = runtime.public.wsBase.replace(/\/$/, "");
  const wsBase = configuredWsBase || `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
  const wsToken = document.cookie.split(";").find((c) => c.trim().startsWith("mcsa_token="))?.split("=").slice(1).join("=").trim();
  const wsQuery = wsToken ? `?token=${encodeURIComponent(wsToken)}` : "";
  let consoleConnected = false;
  let agentConnected = false;
  const markSocketOpen = () => {
    if (!consoleConnected || !agentConnected || serverId !== selectedServerId.value || generation !== socketReconnectGeneration) return;
    const hadReconnects = socketReconnectAttempt > 0;
    socketReconnectAttempt = 0;
    if (hadReconnects) {
      showSocketStatus("success", "实时连接已恢复", 1800);
      syncAfterSocketReconnect(serverId).catch(() => undefined);
    }
    else if (hasStatusBubble(socketStatusBubbleId)) showSocketStatus("success", "实时连接已建立", 1200);
  };
  const handleSocketClose = () => {
    if (serverId !== selectedServerId.value || generation !== socketReconnectGeneration || socketsClosedIntentionally) return;
    scheduleSocketReconnect(serverId, generation);
  };
  consoleSocket = new WebSocket(`${wsBase}/ws/console/${serverId}${wsQuery}`);
  consoleSocket.onopen = () => {
    consoleConnected = true;
    markSocketOpen();
  };
  consoleSocket.onmessage = (event) => {
    if (serverId !== selectedServerId.value) return;
    const payload = JSON.parse(event.data);
    if (payload.type === "clear") logs.value = [];
    if (payload.type === "log") {
      logs.value.push(payload.entry);
      if (logs.value.length > 800) logs.value.splice(0, logs.value.length - 800);
      scrollConsoleHistoryToBottom();
    }
    if (payload.type === "status") loadServers();
  };
  consoleSocket.onclose = handleSocketClose;
  consoleSocket.onerror = () => consoleSocket?.close();
  agentSocket = new WebSocket(`${wsBase}/ws/agent/${serverId}${wsQuery}`);
  agentSocket.onopen = () => {
    agentConnected = true;
    markSocketOpen();
  };
  agentSocket.onmessage = (event) => {
    if (serverId !== selectedServerId.value) return;
    const payload = JSON.parse(event.data) as { type?: string; status?: AgentStatus; content?: string; messageId?: string; confirmation?: AgentConfirmationRequest; toolConfigRequired?: AgentToolConfigRequired; retry?: AgentRetryState; download?: AgentDownloadProgress; workflow?: AgentWorkflowProgress; serverSlot?: ServerSlotStatus };
    if (payload.type === "status" && payload.status) {
      agentStatus.value = payload.status;
      if (payload.status !== "retrying") clearAgentRetryState();
    }
    if (payload.type === "confirmation_required" && payload.confirmation) pendingConfirmation.value = payload.confirmation;
    if (payload.type === "confirmation_resolved") pendingConfirmation.value = null;
    if (payload.type === "tool_config_required" && payload.toolConfigRequired) {
      pendingToolConfig.value = payload.toolConfigRequired;
      showProviderKeyStatus("error", payload.toolConfigRequired.message, true);
      providerKeyDialogOpen.value = true;
      settingsOpen.value = true;
    }
    if (payload.type === "retry_scheduled" && payload.retry) {
      agentRetry.value = payload.retry;
      agentRetryNowSending.value = false;
      if (payload.status) agentStatus.value = payload.status;
    }
    if (payload.type === "retry_cleared") {
      agentRetry.value = null;
      agentRetryNowSending.value = false;
      if (payload.status) agentStatus.value = payload.status;
    }
    if (payload.type === "download_progress" && payload.download) mergeAgentDownload(payload.download);
    if (payload.type === "workflow_progress" && payload.workflow) agentWorkflow.value = payload.workflow;
    if (payload.type === "server_slot" && payload.serverSlot) serverSlot.value = payload.serverSlot;
    if (payload.type === "log" && payload.content) {
      appendAgentMessage("system", payload.content, null, serverId);
    }
    if (payload.type === "message" && payload.messageId) {
      if (isTerminalAgentStatus(payload.status)) agentRetry.value = null;
      if (isTerminalAgentStatus(payload.status)) flushAgentMessageBuffer(payload.messageId);
      const existing = agentMessages.value.find((message) => message.id === payload.messageId);
      upsertAgentMessage(payload.messageId, "agent", payload.content ?? existing?.content ?? "", payload.status ?? "completed", serverId);
    } else if (payload.type === "message" && payload.content) {
      if (isTerminalAgentStatus(payload.status)) agentRetry.value = null;
      appendAgentMessage("agent", payload.content, payload.status ?? "completed", serverId);
    }
    if (payload.type === "message_delta" && payload.messageId && payload.content) {
      appendAgentMessageDelta(payload.messageId, payload.content, serverId);
    }
    if (payload.type === "error" && payload.content && payload.messageId) {
      agentRetry.value = null;
      flushAgentMessageBuffer(payload.messageId);
      upsertAgentMessage(payload.messageId, "agent", payload.content, payload.status ?? "failed", serverId);
      if (payload.status) agentStatus.value = payload.status;
    } else if (payload.type === "error" && payload.content) {
      appendAgentMessage("agent", payload.content, payload.status ?? "failed", serverId);
      if (payload.status) agentStatus.value = payload.status;
    }
    if (payload.type === "done") {
      agentRetry.value = null;
      agentRetryNowSending.value = false;
      for (const id of agentStreamBuffers.keys()) flushAgentMessageBuffer(id);
      if (payload.status) agentStatus.value = payload.status;
      window.setTimeout(clearTerminalAgentDownloads, 1600);
      refreshAfterAgentRun().catch(() => undefined);
    }
  };
  agentSocket.onclose = () => {
    handleSocketClose();
  };
  agentSocket.onerror = () => agentSocket?.close();
}

onMounted(async () => {
  window.addEventListener("mouseup", endFileDragSelection);
  await safe(async () => {
    await loadServers();
    await loadSettings();
    if (selectedServerId.value) await selectServer(selectedServerId.value);
  });
  startJavaPolling();
  startAgentRetryClock();
});

onBeforeUnmount(() => {
  window.removeEventListener("mouseup", endFileDragSelection);
  clearAgentMessageBuffers();
  clearStatusBubbles();
  closeSockets();
  if (javaPollTimer) clearInterval(javaPollTimer);
  if (agentRetryClockTimer) clearInterval(agentRetryClockTimer);
});
</script>

<template>
  <div class="app-shell" :class="{ 'sidebar-collapsed': sidebarCollapsed }">
    <div class="background-field" aria-hidden="true">
      <div class="orb orb-a" />
      <div class="orb orb-b" />
      <div class="circuit-plane" />
    </div>

    <StatusBubble :items="statusBubbles" @action="handleStatusBubbleAction" />

    <Transition name="modal">
      <div v-if="providerKeyDialogOpen" class="modal-backdrop">
        <form class="card stack provider-key-dialog" @submit.prevent="saveProviderKeys">
          <div class="card-header">
            <div>
              <p class="eyebrow">Provider Keys</p>
              <h2 class="card-title">配置平台 API Key</h2>
            </div>
            <button type="button" :disabled="providerKeySaving" @click="closeProviderKeyDialog">关闭</button>
          </div>
          <p v-if="pendingToolConfig" class="danger-note">{{ pendingToolConfig.message }}</p>
          <div class="settings-field-grid">
            <label class="stack">
              <span class="muted">CurseForge API Key</span>
              <input v-model="providerKeyForm.curseForgeApiKey" type="password" :placeholder="providerKeyPlaceholder('curseForgeApiKey')" autocomplete="off" />
              <small class="muted">状态：{{ providerKeySettings.curseForgeApiKeyConfigured ? '已配置' : '未配置' }} · <a href="https://console.curseforge.com/?#/api-keys" target="_blank" rel="noreferrer noopener">申请/管理</a></small>
            </label>
            <label class="stack">
              <span class="muted">Modrinth Personal Access Token</span>
              <input v-model="providerKeyForm.modrinthApiKey" type="password" :placeholder="providerKeyPlaceholder('modrinthApiKey')" autocomplete="off" />
              <small class="muted">状态：{{ providerKeySettings.modrinthApiKeyConfigured ? '已配置' : '未配置' }} · <a href="https://modrinth.com/settings/pats" target="_blank" rel="noreferrer noopener">申请/管理</a></small>
            </label>
          </div>
          <small class="muted">留空会保留已保存的 Key；保存后只显示脱敏提示，不回显明文。</small>
          <div class="row">
            <button class="primary" type="submit" :disabled="providerKeySaving">{{ providerKeySaving ? "保存中" : "保存 Key" }}</button>
            <button type="button" :disabled="providerKeySaving" @click="closeProviderKeyDialog">取消</button>
          </div>
        </form>
      </div>
    </Transition>

    <Transition name="modal">
      <div v-if="proxyTestDialogOpen" class="modal-backdrop">
        <form class="card stack proxy-test-dialog" @submit.prevent="testProxyConnectivity">
          <div class="card-header">
            <div>
              <p class="eyebrow">Proxy Probe</p>
              <h2 class="card-title">检测 Agent 代理连通性</h2>
            </div>
            <button type="button" :disabled="proxyTesting" @click="closeProxyTestDialog">关闭</button>
          </div>
          <label class="stack">
            <span class="muted">检测地址</span>
            <input v-model.trim="proxyTestTarget" placeholder="www.google.com" autocomplete="off" />
          </label>
          <small class="muted">当前模式：{{ proxyTestModeLabel }}。未写协议时会自动使用 https://。</small>
          <div v-if="proxyTestResult" class="proxy-test-result" :class="proxyTestResult.ok ? 'proxy-test-ok' : 'proxy-test-failed'">
            <strong>{{ proxyTestResult.ok ? "连通性确认通过" : "连通性确认失败" }}</strong>
            <span>{{ proxyTestResultText(proxyTestResult) }}</span>
            <small>目标：{{ proxyTestResult.targetUrl }}</small>
            <small>最终地址：{{ proxyTestResult.finalUrl }}</small>
            <small>代理：{{ proxyTestResult.usedProxy ? "已使用" : "未使用" }}</small>
          </div>
          <div class="row proxy-test-actions">
            <button class="primary" type="submit" :disabled="proxyTesting || !proxyTestTarget.trim()">{{ proxyTesting ? "检测中" : "确认检测" }}</button>
            <button type="button" :disabled="proxyTesting" @click="closeProxyTestDialog">取消</button>
          </div>
        </form>
      </div>
    </Transition>

    <Transition name="modal">
    <div v-if="createDialogOpen" class="modal-backdrop">
      <form class="card create-dialog stack" @submit.prevent="createServer">
        <div>
          <p class="eyebrow">Create Instance</p>
          <h2 class="card-title">新建实例</h2>
        </div>
        <label class="stack">
          <span class="muted">请输入服务端名称</span>
          <input v-model="newServerName" placeholder="例如：Survival-01" autocomplete="off" autofocus />
        </label>
        <div class="row">
          <button class="primary" type="submit" :disabled="!newServerName.trim()">创建并进入控制台</button>
          <button type="button" @click="closeCreateServerDialog">取消</button>
        </div>
      </form>
    </div>
    </Transition>

    <section v-if="showEmptyLanding" class="landing-shell" aria-labelledby="landing-title">
      <div class="landing-hero card">
        <div class="brand landing-brand">
          <div class="brand-mark">MCTM</div>
          <div>
            <div class="brand-title">MCTManager</div>
            <div class="brand-subtitle">Agent Ops Panel</div>
          </div>
        </div>

        <div class="landing-copy">
          <p class="eyebrow">Instance Panel</p>
          <h1 id="landing-title">Agent 驱动的 Minecraft 服务端</h1>
<!--          <p class="muted">创建后可以直接进入实例工作台，在同一屏完成终端控制、文件管理、启动配置和 Agent 部署排错。</p>-->
        </div>
      </div>

      <div class="card stack landing-card">
        <div class="card-header">
          <div>
            <p class="eyebrow">Create Instance</p>
            <h2 class="card-title">新建实例</h2>
          </div>
<!--          <span class="status-pill">空工作区</span>-->
        </div>
<!--        <p class="muted">点击创建后输入实例名称，系统会为它准备独立目录。</p>-->
        <button class="primary landing-create-button" type="button" @click="openCreateServerDialog">开始</button>
      </div>
    </section>

    <aside v-else-if="hasServers" class="sidebar" :class="{ collapsed: sidebarCollapsed }">
      <div class="sidebar-head">
        <div class="brand">
          <div class="brand-mark">MCTM</div>
          <div class="brand-copy">
            <div class="brand-title">MCTManager</div>
            <div class="brand-subtitle">Agent Ops Panel</div>
          </div>
        </div>
        <button class="sidebar-toggle" :aria-label="sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'" @click="sidebarCollapsed = !sidebarCollapsed">
          {{ sidebarCollapsed ? "»" : "«" }}
        </button>
      </div>

      <div class="stack sidebar-create">
        <button class="primary" type="button" @click="openCreateServerDialog">创建实例</button>
      </div>

      <div class="sidebar-stats" aria-label="实例状态统计">
        <div><strong>{{ servers.length }}</strong><span>实例</span></div>
        <div><strong>{{ runningServerCount }}</strong><span>运行</span></div>
        <div><strong>{{ crashedServerCount }}</strong><span>异常</span></div>
      </div>

      <TransitionGroup name="server-stack" tag="div" class="server-list">
        <div
          v-for="server in servers"
          :key="server.id"
          class="server-item-shell"
          :class="{ active: server.id === selectedServerId }"
        >
          <button class="server-item" :title="server.name" @click="selectServer(server.id)">
            <span class="server-initial">{{ server.name.slice(0, 2).toUpperCase() }}</span>
            <span class="server-item-copy">
              <strong>{{ server.name }}</strong>
              <small class="muted">{{ server.directory.split(/[\\/]/).filter(Boolean).at(-1) || server.id }}</small>
            </span>
          </button>
          <button class="server-delete" :disabled="server.status !== 'stopped' && server.status !== 'crashed'" title="删除服务端" @click="openDeleteServer(server)">删除</button>
        </div>
      </TransitionGroup>

      <div style="margin-top: auto" class="stack sidebar-footer">
        <div class="muted">{{ clock }}</div>
        <button @click="settingsOpen ? settingsOpen = false : openSettings()">{{ settingsOpen ? "返回实例" : "全局设置" }}</button>
      </div>
    </aside>

    <main v-if="hasServers" class="main">
      <Transition name="modal">
      <div v-if="pendingConfirmation" class="modal-backdrop">
        <section class="card confirmation-dialog stack">
          <div class="card-header">
            <h2 class="card-title">需要确认：{{ pendingConfirmation.title }}</h2>
            <span class="status-pill" :class="pendingConfirmation.risk === 'high' ? 'risk-high' : 'risk-medium'">{{ pendingConfirmation.risk }}</span>
          </div>
          <p class="message-content">{{ pendingConfirmation.description }}</p>
          <p class="muted">该操作会影响当前服务端目录以外的应用工作区、全局配置或数据库。确认后 Agent 才会继续执行。</p>
          <div class="row">
            <button class="primary" @click="resolveAgentConfirmation(true)">确认执行</button>
            <button class="danger" @click="resolveAgentConfirmation(false)">拒绝</button>
          </div>
        </section>
      </div>
      </Transition>

      <Transition name="modal">
      <div v-if="deleteDialog.open && deleteDialog.server" class="modal-backdrop">
        <section class="card delete-dialog stack">
          <div class="card-header">
            <div>
              <p class="eyebrow">Permanent Delete</p>
              <h2 class="card-title">删除服务端：{{ deleteDialog.server.name }}</h2>
            </div>
            <span class="status-pill risk-high">包含文件</span>
          </div>
          <p class="message-content">这会删除服务端记录、控制台日志、Agent 对话、临时上传记录，以及磁盘上的完整服务端文件夹：</p>
          <code class="path-preview">{{ deleteDialog.server.directory }}</code>
          <p v-if="deleteServerBlocked" class="danger-note">该服务端当前状态为 {{ deleteDialog.server.status }}，必须先关闭到 stopped 或 crashed，且不能存在后台残留进程，才能删除。</p>
          <label class="stack">
            <span class="muted">请输入完整服务端名称以确认删除</span>
            <input v-model="deleteDialog.confirmName" :placeholder="deleteDialog.server.name" autocomplete="off" />
          </label>
          <p v-if="deleteDialog.error" class="danger-note">删除失败：{{ deleteDialog.error }}</p>
          <div class="row">
            <button class="danger" :disabled="deleteDialog.deleting || deleteServerBlocked || !deleteConfirmMatches" @click="deleteServer">
              {{ deleteDialog.deleting ? "正在删除" : "永久删除" }}
            </button>
            <button :disabled="deleteDialog.deleting" @click="closeDeleteServer">取消</button>
          </div>
        </section>
      </div>
      </Transition>

      <div class="content-stage">
      <Transition name="server-switch" mode="out-in">
        <section v-if="settingsOpen" key="settings" class="settings-panel">
          <div class="settings-column">
            <div class="card stack settings-card settings-model-card">
              <div class="card-header"><h2 class="card-title">模型配置</h2><button @click="loadSettings">刷新</button></div>
              <div class="settings-field-grid">
                <input :value="fixedModelDisplayName" readonly aria-readonly="true" placeholder="显示名称" />
                <input v-model="modelForm.baseUrl" placeholder="Base URL" />
                <input v-model="modelForm.modelName" placeholder="模型名称" />
                <input v-model="modelForm.apiKey" :placeholder="apiKeyPlaceholder" type="password" />
              </div>
              <small class="muted">API Key 留空会保留已保存的 Key；已配置时显示脱敏提示。</small>
              <div class="row">
                <button class="primary" :disabled="modelBusy" @click="saveModel">{{ modelSaving ? "保存中" : "保存" }}</button>
                <button :disabled="modelBusy || hasUnsavedApiKey" @click="testModel()">{{ modelTesting ? "测试中" : "测试" }}</button>
              </div>
            </div>

            <div class="card stack settings-card settings-tools-skills-card">
              <div class="card-header"><h2 class="card-title">Tools & Skills</h2></div>
              <div class="settings-list settings-tools-skills-list">
                <div v-for="skill in skills" :key="skill.id" class="file-row compact-capability-row" :title="skill.description">
                  <span class="capability-copy">
                    <strong>{{ skill.name }} v{{ skill.version }}</strong>
                    <span class="status-pill status-running">Skill</span><br />
                    <small class="muted">{{ compactText(skill.description, 44) }}</small>
                  </span>
                  <button @click="toggleSkill(skill)">修改</button>
                </div>
                <div v-for="tool in agentTools" :key="tool.name" class="file-row tool-row compact-capability-row" :title="tool.description">
                  <span class="capability-copy">
                    <strong>{{ tool.name }}</strong>
                    <span class="status-pill status-running">Tool</span><br />
                    <small class="muted">{{ toolMeta(tool) }}</small>
                  </span>
                  <div v-if="tool.configRequirements?.length" class="row tool-config-actions">
                    <button type="button" @click="openProviderKeyDialog()">配置 API Key</button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="card stack settings-card settings-agent-card">
            <div class="card-header"><h2 class="card-title">Agent设置</h2></div>
            <div class="settings-agent-section stack">
              <div class="card-header"><h3 class="card-title">Agent 默认内存</h3><strong>{{ agentMemoryLabel }}</strong></div>
              <input v-model.number="agentMemoryMb" type="range" min="512" :max="systemMemoryMb" step="512" @change="saveAgentSettings" />
              <div class="row">
                <small class="muted">512 MB</small>
                <small class="muted">设备最大内存 {{ systemMemoryLabel }}</small>
              </div>
              <small v-if="agentMemoryWarning" class="danger-note">当前设置超过设备内存的 90%，可能导致系统或服务端不稳定。</small>
              <small class="muted">此处设置只影响 Agent 配置服务端时使用的推荐内存大小，不会影响已经存在的服务端。Agent 会优先使用这个内存；如果整合包有明确要求，可以调整，但不能超过推荐内存，并需要说明调整情况。</small>
              <div class="row">
                <button type="button" @click="saveAgentSettings">保存默认内存</button>
              </div>
            </div>
            <div class="settings-agent-section stack">
              <div class="card-header"><h3 class="card-title">Agent 代理</h3></div>
              <label class="row inline-check settings-proxy-toggle" title="影响 Agent 联网工具、Java 安装、Forge installer 和服务端启动进程，不影响模型请求。">
                <input v-model="agentDownloadProxyEnabled" type="checkbox" @change="saveAgentSettings" />
                <span>Agent 与服务端使用代理</span>
              </label>
              <div class="row settings-proxy-controls">
                <input v-model.trim="agentDownloadProxyUrl" placeholder="http://127.0.0.1:7890" :disabled="!agentDownloadProxyEnabled" @keyup.enter="saveAgentSettings" />
                <button type="button" :disabled="agentDownloadProxyEnabled && !agentDownloadProxyUrl.trim()" @click="saveAgentSettings">保存代理</button>
                <button type="button" @click="openProxyTestDialog">检测代理</button>
              </div>
              <small class="muted">支持 HTTP/HTTPS 代理地址，例如 Clash 或 v2rayN 的本地 HTTP 端口；开启后 Agent 工具、Forge 安装器和服务端 JVM 会继承代理。</small>
            </div>
            <div class="settings-agent-section stack">
              <div class="card-header"><h3 class="card-title">平台 API Key</h3><button type="button" @click="openProviderKeyDialog()">配置</button></div>
              <div class="provider-key-summary">
                <small class="muted">CurseForge：{{ providerKeySettings.curseForgeApiKeyHint }}</small>
                <small class="muted">Modrinth：{{ providerKeySettings.modrinthApiKeyHint }}</small>
              </div>
              <small class="muted">CurseForge 下载需要 API Key；Modrinth PAT 通常可选，遇到 401/403 时再配置。</small>
            </div>
            <div class="settings-agent-section settings-prompt-section stack">
              <div class="card-header"><h3 class="card-title">Prompt 设置</h3><button @click="resetGlobalPrompt">恢复默认</button></div>
              <textarea v-model="globalPrompt" class="settings-prompt-input" />
              <button class="primary" @click="saveGlobalPrompt">保存全局 Prompt</button>
            </div>
          </div>

          <div class="card stack settings-card settings-java-card">
            <div class="card-header"><h2 class="card-title">JAVA 管理</h2><button @click="loadSettings">刷新</button></div>
            <form class="row settings-java-controls" @submit.prevent="installJava(javaVersionToInstall)">
              <select v-model="javaVersionToInstall" class="compact-input">
                <option v-for="java in javaVersions" :key="java.version" :value="java.version">
                  {{ java.label }} - {{ javaStatusText(java) }}
                </option>
              </select>
              <select v-model="javaDownloadSource" class="compact-input">
                <option v-for="source in javaDownloadSources" :key="source.id" :value="source.id">
                  {{ source.label }}
                </option>
              </select>
              <button class="primary" type="submit" :disabled="selectedJavaInstalled || selectedJavaBusy">
                {{ selectedJavaInstalled ? "已安装" : selectedJavaBusy ? "安装中" : "安装所选版本" }}
              </button>
              <button v-if="selectedJavaTask && isJavaTaskActive(selectedJavaTask.status)" class="danger" type="button" :disabled="!isJavaTaskCancellable(selectedJavaTask.status)" @click="cancelJavaInstall(selectedJavaTask.version)">
                {{ selectedJavaTask.status === "cancelling" ? "取消中" : "取消安装" }}
              </button>
            </form>
            <div v-if="selectedJavaTask" class="java-progress stack">
              <div class="row">
                <span class="status-pill" :class="selectedJavaTask.status === 'failed' ? 'risk-high' : selectedJavaTask.status === 'installed' ? 'status-running' : isJavaTaskActive(selectedJavaTask.status) ? 'risk-medium' : ''">{{ selectedJavaTask.status }}</span>
                <small class="muted">{{ javaTaskDetail(selectedJavaTask) }}</small>
              </div>
              <div v-if="isJavaTaskActive(selectedJavaTask.status)" class="progress-track"><span :style="{ width: `${selectedJavaTask.progress}%` }" /></div>
            </div>
            <small class="muted settings-help">下拉框来自 Adoptium 可用主版本清单；默认使用国内高速源并自动回退官方源，安装中可随时取消，不会修改系统 Java。</small>
            <div class="java-version-list">
              <div v-for="java in javaVersions" :key="java.version" class="file-row java-version-row">
                <span>
                  {{ java.label }}
                  <span class="status-pill" :class="javaStatusClass(java)">{{ javaStatusText(java) }}</span><br />
                  <small class="muted">{{ java.installPath || java.task?.message || "未安装到应用 workspace" }}</small>
                  <template v-if="java.task">
                    <br /><small :class="java.task.status === 'failed' ? 'danger-note inline-note' : 'muted'">{{ javaTaskDetail(java.task) }}</small>
                    <div v-if="isJavaTaskActive(java.task.status)" class="progress-track"><span :style="{ width: `${java.task.progress}%` }" /></div>
                  </template>
                </span>
                <div class="row java-row-actions">
                  <button v-if="java.task && isJavaTaskActive(java.task.status)" class="danger" :disabled="!isJavaTaskCancellable(java.task.status)" @click="cancelJavaInstall(java.version)">
                    {{ java.task.status === "cancelling" ? "取消中" : "取消" }}
                  </button>
                  <button v-else-if="!java.installed" @click="installJava(java.version)">
                    安装
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section v-else-if="selectedServer" :key="selectedServer.id" class="workspace single-workspace">
          <header class="instance-topbar card">
            <div class="instance-title-block">
              <p class="eyebrow">Instance</p>
              <h1>{{ selectedServer.name }}</h1>
            </div>
            <div class="instance-actions">
              <span class="status-chip" :class="statusClass">
                <span class="status-chip-icon" aria-hidden="true" />
                <span>{{ serverStatusText }}</span>
              </span>
              <button class="primary" :disabled="!canRunAction('start')" @click="serverAction('start')">启动</button>
              <button :disabled="!canRunAction('stop')" @click="serverAction('stop')">停止</button>
              <button :disabled="!canRunAction('restart')" @click="serverAction('restart')">重启</button>
              <button class="danger" :disabled="!canRunAction('kill')" @click="serverAction('kill')">强制结束</button>
              <button type="button" @click="openFileDialog">文件</button>
              <button type="button" @click="openConfigDialog">配置</button>
            </div>
          </header>

            <div class="operation-grid">
            <div class="left-operation-stack">
              <section class="card stack workspace-card console-card single-console-panel">
                <div class="card-header">
                  <h2 class="card-title">实例终端</h2>
                  <div class="row">
                    <button type="button" @click="loadLogs">刷新日志</button>
                  </div>
                </div>
                <div ref="consoleLogList" class="console">
                  <p v-if="logs.length === 0" class="console-empty">暂无日志，启动实例后会显示实时输出。</p>
                  <div v-for="log in renderedConsoleLogs" :key="log.id" :class="['console-entry', log.stream]" v-html="log.html" />
                </div>
                <form class="row command-bar" @submit.prevent="sendCommand">
                  <input v-model="consoleCommand" placeholder="输入服务端控制台指令" />
                  <button class="primary" type="submit">发送</button>
                </form>
              </section>

              <div v-if="showDeploymentProgressCard" class="deployment-progress-shell" :class="[`workflow-${deploymentProgressCardStatus}`, { dismissed: deploymentProgressDismissed }]">
                  <div class="deployment-progress-panel">
                    <button type="button" class="deployment-progress-sticky-caret" :aria-label="deploymentProgressDismissed ? '显示部署进度' : '隐藏部署进度'" @click="deploymentProgressDismissed = !deploymentProgressDismissed"><span aria-hidden="true" /></button>
                    <section class="card stack deployment-progress-card" :class="`workflow-${deploymentProgressCardStatus}`" role="status" aria-live="polite">
                    <div class="card-header deployment-progress-header">
                      <div>
                        <p class="eyebrow">Deployment</p>
                      </div>
                      <div class="row deployment-progress-actions">
                        <span class="status-pill" :class="deploymentProgressCardStatus === 'failed' ? 'risk-high' : 'status-running'">{{ deploymentProgressLabel }}</span>
                      </div>
                    </div>
                    <div class="server-slot-card" :class="{ occupied: serverSlot?.occupied }">
                      <div>
                        <p class="eyebrow">Server Package</p>
                        <strong>{{ serverSlot?.occupied ? "已准备服务端包" : "等待服务端包" }}</strong>
                        <small class="muted">{{ serverSlotDetail(serverSlot) }}</small>
                      </div>
                      <button type="button" @click="loadServerSlotStatus">刷新状态</button>
                    </div>
                    <div class="workflow-progress-panel" :class="`workflow-${deploymentProgressCardStatus}`">
                      <div class="row workflow-head">
                        <strong>{{ deploymentWorkflow?.title ?? "服务端部署" }}</strong>
                        <span>{{ deploymentProgressPercent }}%</span>
                      </div>
                      <div class="progress-track"><span :style="{ width: `${deploymentProgressPercent}%` }" /></div>
                      <div v-if="deploymentWorkflow" class="workflow-steps" tabindex="0" aria-label="部署步骤">
                        <div v-for="step in deploymentWorkflow.steps" :key="step.id" class="workflow-step" :class="[`step-${step.status}`, { active: step.id === deploymentWorkflow.currentStepId }]" :data-workflow-step-id="step.id">
                          <div class="row">
                            <strong>{{ step.label }}</strong>
                            <span v-if="step.status === 'failed'" class="status-pill" :class="workflowStepClass(step.status)">{{ workflowStatusText(step.status) }}</span>
                          </div>
                          <div class="progress-track"><span :style="{ width: `${step.progress}%` }" /></div>
                          <small class="muted">{{ step.detail || `${step.progress}%` }}</small>
                        </div>
                      </div>
                      <small v-else class="muted">当前服务端包已准备好，可继续启动或调整配置。</small>
                    </div>
                    </section>
                  </div>
              </div>

            </div>

            <section class="card stack agent-card workspace-card single-agent-panel">
              <div class="card-header">
                <h2 class="card-title">Agent</h2>
                <div class="row">
                  <span class="status-pill">{{ agentStatusText }}</span>
                  <button class="danger" type="button" :disabled="agentBusy || agentMessages.length === 0" @click="clearAgentContext">清除上下文</button>
                </div>
              </div>
              <div class="agent-message-shell">
                <div ref="agentMessageList" class="message-list" @scroll="updateAgentScrollState">
                  <TransitionGroup name="message-stream" tag="div" class="message-stream">
                    <div v-for="message in agentMessages" :key="message.id" class="message" :class="[message.role, { failed: message.status === 'failed' }]">
                      <strong>{{ message.role }}</strong>
                      <div v-if="message.role === 'agent'" class="message-content markdown-content" v-html="renderAgentMarkdown(message.content)" />
                      <details v-else-if="message.role === 'system' && isCollapsibleAgentLog(message.content)" class="message-content agent-log-details">
                        <summary>{{ collapsibleAgentLogTitle(message.content) }}</summary>
                        <pre>{{ message.content }}</pre>
                      </details>
                      <div v-else class="message-content">{{ message.content }}</div>
                    </div>
                  </TransitionGroup>
                </div>
                <Transition name="agent-scroll-bottom">
                  <button v-if="showAgentScrollToBottom" class="agent-scroll-bottom" type="button" @click="scrollAgentHistoryToBottom">回到底部</button>
                </Transition>
              </div>
              <div v-if="pendingAgentAttachments.length" class="agent-attachments">
                <span class="muted">已上传到服务端目录，将随下一条消息引用</span>
                <div v-for="attachment in pendingAgentAttachments" :key="attachment.path" class="agent-attachment-chip">
                  <span>{{ attachment.originalName }}</span>
                  <code>{{ attachment.path }}</code>
                  <button type="button" :disabled="agentBusy" @click="removePendingAgentAttachment(attachment.path)">移除</button>
                </div>
              </div>
              <div v-if="agentUpload.active" class="upload-progress" role="status" aria-live="polite">
                <div class="row">
                  <strong>{{ agentUpload.done ? "上传完成" : "正在上传" }} {{ agentUpload.fileName }}</strong>
                  <span>{{ agentUpload.percent }}%</span>
                </div>
                <div class="progress-track"><span :style="{ width: `${agentUpload.percent}%` }" /></div>
                <small class="muted">{{ uploadDetail(agentUpload) }}</small>
              </div>
              <div v-if="agentRetry" class="agent-download-progress download-retrying" role="status" aria-live="polite">
                <div class="row">
                  <strong>{{ agentRetryMessage }}</strong>
                  <button type="button" :disabled="agentRetryNowSending" @click="retryAgentNow">{{ agentRetryNowSending ? "重试中" : "立即重试" }}</button>
                </div>
                <small class="muted">{{ agentRetry.message }}</small>
              </div>
              <Transition name="agent-input">
                <div v-if="showAgentOutputLoading" class="agent-output-loading" role="status" aria-live="polite">
                  <div class="agent-loader-core" aria-hidden="true"><span /><span /><span /></div>
                  <div>
                    <strong>{{ agentOutputLoadingText }}</strong>
                  </div>
                </div>
                <textarea v-else-if="!agentBusy" v-model="agentInput" :placeholder="agentPlaceholder" @keydown.ctrl.enter.prevent="sendAgentMessage" />
              </Transition>
              <div class="row agent-command-row">
                <label class="row reasoning-control">
                  <span class="muted">思考深度</span>
                  <select v-model="agentReasoningEffort" :disabled="agentBusy">
                    <option value="minimal">Minimal</option>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </label>
                <button v-if="agentStatus === 'retrying'" type="button" :disabled="agentRetryNowSending" @click="retryAgentNow">
                  {{ agentRetryNowSending ? "重试中" : "立即重试" }}
                </button>
                <button v-if="agentBusy" class="danger" type="button" @click="cancelAgentRun">中断</button>
                <label class="row inline-check agent-auto-confirm" title="开启后 Agent 请求确认的操作会自动放行，不再弹出确认窗口。">
                  <input v-model="agentAutoConfirm" type="checkbox" @change="saveAgentSettings" />
                  <span>自动确认</span>
                </label>
                <button class="primary" :disabled="agentBusy || (!agentInput.trim() && pendingAgentAttachments.length === 0)" @click="sendAgentMessage">{{ agentBusy ? "处理中" : "发送任务" }}</button>
                <input ref="agentUploadInput" class="visually-hidden" type="file" @change="uploadAgentFile" />
                <button type="button" :disabled="agentUpload.active" @click="openAgentUploadPicker">{{ agentUpload.active ? "上传中" : "上传文件" }}</button>
              </div>
            </section>
          </div>
        </section>
      </Transition>
      </div>

      <Transition name="modal">
        <div v-if="fileDialogOpen && selectedServer" class="modal-backdrop">
          <section class="card stack management-dialog files-dialog">
            <div class="card-header">
              <div>
                <p class="eyebrow">File Manager</p>
                <h2 class="card-title">{{ selectedServer.name }} 文件</h2>
                <p class="muted">当前路径：{{ currentPath }}</p>
              </div>
              <div class="row">
                <button type="button" @click="goUp">上级</button>
                <button type="button" @click="loadFiles">刷新</button>
                <button type="button" @click="fileDialogOpen = false">关闭</button>
              </div>
            </div>

            <div class="row file-toolbar">
              <input v-model="newFolderName" placeholder="新文件夹名称" />
              <button type="button" @click="createFolder">新建文件夹</button>
              <input ref="serverUploadInput" class="visually-hidden" type="file" @change="uploadServerFile" />
              <button type="button" :disabled="serverUpload.active" @click="serverUploadInput?.click()">{{ serverUpload.active ? "上传中" : "上传文件" }}</button>
              <template v-if="selectedFiles.length > 0">
                <span class="file-selection-count">已选 {{ selectedFiles.length }} 项</span>
                <button v-if="selectedFile" type="button" @click="showFileProperties(selectedFile)">属性</button>
                <button v-if="selectedFile" type="button" @click="renameFile(selectedFile.path)">重命名</button>
                <button class="danger" type="button" @click="removeSelectedFiles">删除</button>
              </template>
            </div>

            <div v-if="serverUpload.active" class="upload-progress" role="status" aria-live="polite">
              <div class="row">
                <strong>{{ serverUpload.done ? "上传完成" : "正在上传" }} {{ serverUpload.fileName }}</strong>
                <span>{{ serverUpload.percent }}%</span>
              </div>
              <div class="progress-track"><span :style="{ width: `${serverUpload.percent}%` }" /></div>
              <small class="muted">{{ uploadDetail(serverUpload) }}</small>
            </div>

            <TransitionGroup name="file-list-switch" tag="div" class="file-list dialog-file-list">
              <div v-if="filesLoading" key="loading" class="file-row file-loading-row">
                <span class="file-loading-spinner" aria-hidden="true"></span>
                <span class="muted">正在获取文件...</span>
              </div>
              <div v-else-if="sortedFiles.length === 0" key="empty" class="file-row empty-row">
                <span class="muted">当前目录为空</span>
              </div>
              <div v-if="!filesLoading && parentDirectoryPath" key="parent" class="file-row file-row-parent" role="button" tabindex="0" @click="openFolder(parentDirectoryPath)" @keydown.enter="openFolder(parentDirectoryPath)">
                <div class="file-name">
                  <span class="file-icon file-icon-parent" aria-hidden="true"></span>
                  <span class="visually-hidden">上一级</span>
                  <span>../</span>
                </div>
                <div class="row"></div>
              </div>
              <div v-for="file in filesLoading ? [] : sortedFiles" :key="file.path" :class="['file-row', 'dialog-file-row', selectedFilePaths.includes(file.path) ? 'selected' : '']" role="button" tabindex="0" @mousedown="beginFileDragSelection(file.path, $event)" @mouseenter="dragSelectFile(file.path)" @dblclick="openFileEntry(file)" @keydown.enter="openFileEntry(file)">
                <label class="file-check" :aria-label="`选择 ${file.name}`" @mousedown.stop @click.stop>
                  <input type="checkbox" :checked="selectedFilePaths.includes(file.path)" @change="toggleSelectedFile(file.path)" />
                  <span aria-hidden="true"></span>
                </label>
                <div class="file-name">
                  <span :class="['file-icon', file.type === 'directory' ? 'file-icon-directory' : 'file-icon-file']" aria-hidden="true"></span>
                  <span class="visually-hidden">{{ file.type === "directory" ? "文件夹" : "文件" }}</span>
                  <span>{{ file.name }}</span>
                  <small v-if="file.type === 'file'" class="muted">{{ formatBytes(file.size) }}</small>
                </div>
                <div class="row">
                  <a v-if="file.type === 'file'" :href="downloadUrl(`/api/servers/${selectedServer.id}/files/download?path=${encodeURIComponent(file.path)}`)" @click.stop><button>下载</button></a>
                </div>
              </div>
            </TransitionGroup>
          </section>
        </div>
      </Transition>

      <Transition name="modal">
        <div v-if="configDialogOpen && selectedServer" class="modal-backdrop">
          <form class="card stack management-dialog config-dialog" @submit.prevent="saveServerConfig">
            <div class="card-header">
              <div>
                <p class="eyebrow">Instance Config</p>
                <h2 class="card-title">服务端配置</h2>
              </div>
              <div class="row">
                <button class="primary" type="submit">保存</button>
                <button type="button" @click="configDialogOpen = false">关闭</button>
              </div>
            </div>
            <label class="config-field stack">
              <span class="muted">服务端名字</span>
              <input v-model.trim="serverForm.name" placeholder="服务端名字" />
            </label>
            <label class="config-field stack">
              <span class="muted">使用内存大小</span>
              <div class="memory-config-panel">
                <div class="memory-config-head">
                  <strong>{{ serverMemoryLabel }}</strong>
                  <input v-model.number="serverMemoryMb" type="number" :min="minimumServerMemoryMb" :max="serverMemoryMaxMb" step="512" inputmode="numeric" />
                </div>
                <input v-model.number="serverMemoryMb" class="memory-slider" type="range" :min="minimumServerMemoryMb" :max="serverMemoryMaxMb" step="512" />
                <div class="row memory-range-labels">
                  <small class="muted">{{ formatMemoryMb(minimumServerMemoryMb) }}</small>
                  <small class="muted">设备最大内存 {{ systemMemoryLabel }}</small>
                </div>
                <small v-if="serverMemoryWarning" class="danger-note">当前设置超过设备内存的 90%，可能导致系统或服务端不稳定。</small>
              </div>
            </label>
            <label class="config-field stack">
              <span class="muted">使用 Java 版本</span>
              <select v-model="serverForm.javaVersion" @change="applyServerJavaSelection">
                <option v-for="java in configJavaVersionOptions" :key="java.version" :value="java.version">
                  {{ java.label }}{{ java.installed ? "（已安装）" : "" }}
                </option>
              </select>
            </label>
            <label class="config-field stack">
              <span class="muted">启动指令</span>
              <textarea v-model.trim="serverForm.startupCommand" class="startup-command-input" placeholder="留空则自动使用服务端脚本或 Jar。可用变量：{java} {javaHome} {memory} {minMemory} {maxMemory} {jarFile} {startArgs}" />
            </label>
          </form>
        </div>
      </Transition>

      <Transition name="modal">
        <div v-if="textEditor.open" class="modal-backdrop">
          <section class="card stack editor-dialog">
            <div class="card-header"><h2 class="card-title">编辑 {{ textEditor.path }}</h2><button @click="textEditor.open = false">关闭</button></div>
            <textarea v-model="textEditor.content" class="code-editor" />
            <button class="primary" @click="saveTextFile">保存文件</button>
          </section>
        </div>
      </Transition>
    </main>
  </div>
</template>
