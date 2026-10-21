<script setup lang="ts">
import type { UploadProgress } from "~/composables/useApi";
import type { AgentActivity } from "~/types/app";
import AgentConfirmationDialog from "~/components/dialogs/AgentConfirmationDialog.vue";
import AgentQuestionDialog from "~/components/dialogs/AgentQuestionDialog.vue";
import CreateServerDialog from "~/components/dialogs/CreateServerDialog.vue";
import DeleteServerDialog from "~/components/dialogs/DeleteServerDialog.vue";
import FileManagerDialog from "~/components/dialogs/FileManagerDialog.vue";
import GlobalPromptEditorDialog from "~/components/dialogs/GlobalPromptEditorDialog.vue";
import InstanceSwitcherDialog from "~/components/dialogs/InstanceSwitcherDialog.vue";
import MapEditorDialog from "~/components/dialogs/MapEditorDialog.vue";
import ProviderKeyDialog from "~/components/dialogs/ProviderKeyDialog.vue";
import ProxyTestDialog from "~/components/dialogs/ProxyTestDialog.vue";
import ServerConfigDialog from "~/components/dialogs/ServerConfigDialog.vue";
import TextFileEditorDialog from "~/components/dialogs/TextFileEditorDialog.vue";
import WorkspaceSettingsPanel from "~/components/settings/WorkspaceSettingsPanel.vue";
import AgentPanel from "~/components/workspace/AgentPanel.vue";
import ConsolePanel from "~/components/workspace/ConsolePanel.vue";
import DashboardView from "~/components/dashboard/DashboardView.vue";
import DeploymentProgressPanel from "~/components/workspace/DeploymentProgressPanel.vue";
import EmptyWorkspaceLanding from "~/components/workspace/EmptyWorkspaceLanding.vue";
import InstanceTopbar from "~/components/workspace/InstanceTopbar.vue";
import ServerSidebar from "~/components/workspace/ServerSidebar.vue";
import type { AgentConfirmationRequest, AgentContextUsage, AgentDownloadProgress, AgentMessage, AgentRetryState, AgentSettings, AgentStatus, AgentToolConfigRequired, AgentToolConfigRequirement, AgentToolRecord, AgentToolSettings, AgentWorkflowProgress, ConsoleLogEntry, FileEntry, JavaDownloadSource, JavaDownloadSourceOption, JavaInstall, JavaInstallTask, JavaInstallTaskStatus, JavaManagementState, JavaVersionRecord, ModelApiType, ModelConfig, ProxyTestResult, ServerErrorDigest, ServerErrorState, ServerRecord, ServerSlotStatus, SkillRecord, ToolConfigKey } from "~/types/app";
import { createIncrementalConsoleRenderer } from "~/utils/consoleRendering";
import type { RenderedConsoleLogEntry } from "~/utils/consoleRendering";
import { formatBytes, formatMemoryConfig, formatMemoryMb, parseMemoryToMb } from "~/utils/formatters";
import { useStatusBubbles } from "~/composables/useStatusBubbles";
import { readBrowserState, writeBrowserState } from "~/utils/browserState";
import type { DeploymentProgressState, PendingAgentAttachment, ServerConfigForm, SettingsNavItem, SettingsTab, StatusBubbleItem, StatusBubbleType, UploadState } from "~/types/ui";

definePageMeta({ middleware: "auth" });

const { api, upload, downloadUrl } = useApi();
const runtime = useRuntimeConfig();
const clock = useClock();
const router = useRouter();

const globalAgent = useGlobalAgent();
const delivery = useAgentDelivery();
watch(globalAgent.activeModel, (value) => { dashboardActiveModel.value = value; });
watch(globalAgent.toolConfigRequired, (value) => {
  if (value) {
    pendingToolConfig.value = value;
    showProviderKeyStatus("error", value.message, true);
  }
});
const dashboardOpen = ref(true);
const mobileWorkspaceTab = ref<"console" | "deployment" | "agent">("console");
const dashboardInput = ref("");
const dashboardAgentUpload = reactive<UploadState>({ active: false, fileName: "", loaded: 0, total: 0, percent: 0, done: false });
const dashboardAttachments = ref<PendingAgentAttachment[]>([]);
const dashboardReasoningEffort = ref<"minimal" | "low" | "medium" | "high">("high");
const dashboardScrollToBottom = ref(false);

const servers = ref<ServerRecord[]>([]);
const serverListLoad = useResourceLoadState();
const serversLoaded = serverListLoad.loaded;
const consoleLoad = useResourceLoadState();
const historyLoad = useResourceLoadState();
const contextLoad = useResourceLoadState();
const settingsLoad = useResourceLoadState();
const javaLoad = useResourceLoadState();
const fileLoad = useResourceLoadState();
const textLoad = useResourceLoadState(false);
const fileDataPath = ref("");
const selectedServerId = ref("");
const logs = ref<ConsoleLogEntry[]>([]);
const consoleRefreshing = ref(false);
const serverErrorStates = ref<Record<string, ServerErrorState>>({});
const errorAnalysisSending = ref(false);
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
  const providerKeySettings = ref<AgentToolSettings>({ curseForgeApiKeyConfigured: false, curseForgeApiKeyHint: "未配置", modrinthApiKeyConfigured: false, modrinthApiKeyHint: "未配置", braveSearchApiKeyConfigured: false, braveSearchApiKeyHint: "未配置", tavilyApiKeyConfigured: false, tavilyApiKeyHint: "未配置", searxngBaseUrl: "" });
  const providerKeyForm = reactive({ curseForgeApiKey: "", modrinthApiKey: "", braveSearchApiKey: "", tavilyApiKey: "", searxngBaseUrl: "" });
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
const agentPythonPackageIndexUrl = ref("");
const agentMemoryMb = ref(2048);
const systemMemoryMb = ref(2048);
const consoleCommand = ref("");
const consoleCommandHistories = ref<Record<string, string[]>>({});
const consoleCommandHistory = computed(() => consoleCommandHistories.value[selectedServerId.value] ?? []);
const agentInput = ref("");
const agentReasoningEffort = ref<"minimal" | "low" | "medium" | "high">("high");
const agentStatus = ref<AgentStatus>("idle");
const showAgentScrollToBottom = ref(false);
const settingsOpen = ref(false);
const settingsTab = ref<SettingsTab>("overview");
const deploymentWorkflowDirty = useState<boolean>("deployment-workflow-dirty", () => false);
const settingsNavItems: SettingsNavItem[] = [
  { id: "overview", label: "设置总览", desc: "工作空间配置概况" },
  { id: "model", label: "模型接入", desc: "连接你的 AI 模型" },
  { id: "workflow", label: "流程编排", desc: "拖拽部署步骤，动态组装提示词" },
  { id: "skills", label: "技能管理", desc: "Agent 工作流与能力" },
  { id: "tools", label: "工具与凭据", desc: "工具目录与平台密钥" },
  { id: "agent", label: "Agent 行为", desc: "执行偏好与网络设置" },
  { id: "java", label: "Java 运行时", desc: "受管版本与安装任务" }
];
const loggingOut = ref(false);
const instanceMenuOpen = ref(false);
const restoreInstanceMenuFocus = ref(false);
const pendingInstanceMenuAction = ref<(() => void) | null>(null);
const serverSidebar = ref<InstanceType<typeof ServerSidebar> | null>(null);
const dashboardView = ref<InstanceType<typeof DashboardView> | null>(null);
const instanceTopbar = ref<InstanceType<typeof InstanceTopbar> | null>(null);
const fileManagerDialog = ref<InstanceType<typeof FileManagerDialog> | null>(null);
const agentPanel = ref<InstanceType<typeof AgentPanel> | null>(null);
const consolePanel = ref<InstanceType<typeof ConsolePanel> | null>(null);
const deploymentProgressDismissed = ref(true);
const fileDialogOpen = ref(false);
const configDialogOpen = ref(false);
const mapEditorDialogOpen = ref(false);
const restoreMapEditorFocus = ref(false);
const fileDialogFocusTarget = ref<"files" | "map" | null>(null);
const textEditor = reactive({ open: false, path: "", content: "" });
const promptEditor = reactive({ open: false, draft: "", saving: false });
const createDialogOpen = ref(false);
const deleteDialog = reactive<{ open: boolean; server: ServerRecord | null; confirmName: string; deleting: boolean; error: string }>({ open: false, server: null, confirmName: "", deleting: false, error: "" });
const newServerName = ref("我的 Minecraft 服务端");

const selectedFilePaths = ref<string[]>([]);
const fileSelectionAnchorPath = ref("");
const fileDragSelecting = ref(false);
const filesLoading = fileLoad.loading;
const fixedModelDisplayName = "OpenAI Compatible";
const modelForm = reactive<{ displayName: string; baseUrl: string; modelName: string; apiKey: string; apiType: ModelApiType; availableModels: string[]; isDefault: boolean; contextSizeK: number }>({ displayName: fixedModelDisplayName, baseUrl: "https://api.openai.com/v1", modelName: "gpt-4o-mini", apiKey: "", apiType: "chat_completions", availableModels: [], isDefault: true, contextSizeK: 120 });
const agentContextUsage = ref<AgentContextUsage>({
  contextSizeK: 120,
  maxTokens: 120000,
  usedTokens: 0,
  remainingTokens: 120000,
  remainingRatio: 1,
  remainingPercent: 100
});
const modelSaving = ref(false);
const modelTesting = ref(false);
const modelListBusy = ref(false);
const serverForm = reactive<ServerConfigForm>({ name: "", javaPath: "", javaVersion: "", minMemory: "1G", maxMemory: "2G", jarFile: "server.jar", startArgs: "nogui", startupCommand: "", minecraftVersion: "", modpackName: "", promptOverride: "", useGlobalPrompt: true });
const javaVersionToInstall = ref("21");
const javaDownloadSource = ref<JavaDownloadSource>("auto-cn");

const pendingAgentAttachments = ref<PendingAgentAttachment[]>([]);
const serverUpload = reactive<UploadState>({ active: false, fileName: "", loaded: 0, total: 0, percent: 0, done: false });
const serverSlotUpload = reactive<UploadState>({ active: false, fileName: "", loaded: 0, total: 0, percent: 0, done: false });
const serverSlotUploadServerId = ref("");
const inactiveServerSlotUpload: UploadState = { active: false, fileName: "", loaded: 0, total: 0, percent: 0, done: false };
const selectedServerSlotUpload = computed(() => serverSlotUploadServerId.value === selectedServerId.value ? serverSlotUpload : inactiveServerSlotUpload);
const agentUpload = reactive<UploadState>({ active: false, fileName: "", loaded: 0, total: 0, percent: 0, done: false });
const agentDownloads = ref<AgentDownloadProgress[]>([]);
const agentWorkflow = ref<AgentWorkflowProgress | null>(null);
const serverSlot = ref<ServerSlotStatus | null>(null);
const serverSlotLoading = ref(false);
const serverSlotError = ref("");
const agentRetry = ref<AgentRetryState | null>(null);
const agentActiveModel = ref("");
/// Active model override per conversation scope ("global" or a server id).
const modelOverrideByScope = ref<Record<string, string>>({});
const dashboardActiveModel = ref("");
const agentRetryNowSending = ref(false);
const { items: statusBubbles, clear: clearStatusBubbles, dismiss: dismissStatusBubble, has: hasStatusBubble, show: showStatusBubble, upsert: upsertStatusBubble } = useStatusBubbles();

let consoleSocket: WebSocket | undefined;
let agentSocket: WebSocket | undefined;
let agentMessageRevision = 0;
let selectionGeneration = 0;
let javaPollTimer: ReturnType<typeof setInterval> | undefined;
let socketReconnectTimer: ReturnType<typeof setTimeout> | undefined;
let agentRetryClockTimer: ReturnType<typeof setInterval> | undefined;
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

const agentRetryClock = ref(Date.now());
const socketReconnectBaseDelayMs = 1000;
const socketReconnectMaxDelayMs = 10000;
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
/** Model ids the user can switch to; falls back to the currently configured model. */
const availableModelOptions = computed(() => {
  const list = models.value[0]?.availableModels ?? modelForm.availableModels;
  const current = models.value[0]?.modelName ?? modelForm.modelName;
  const merged = new Set<string>(list);
  if (current) merged.add(current);
  return [...merged];
});
const instanceModelOptions = computed(() => availableModelOptions.value);
const statusClass = computed(() => selectedServer.value ? `status-${selectedServer.value.status}` : "");
const serverStatusText = computed(() => selectedServer.value ? statusText(selectedServer.value.status) : "未选择");
const runningServerCount = computed(() => servers.value.filter((server) => server.status === "running").length);
const crashedServerCount = computed(() => servers.value.filter((server) => server.status === "crashed" || server.status === "orphaned").length);
const erroredServerIds = computed(() => {
  const ids = new Set<string>();
  for (const server of servers.value) {
    if (serverErrorStates.value[server.id]?.hasError || server.status === "crashed" || server.status === "orphaned") ids.add(server.id);
  }
  return ids;
});
const selectedServerErrorState = computed(() => selectedServerId.value ? serverErrorStates.value[selectedServerId.value] ?? null : null);
const selectedServerHasError = computed(() => Boolean(selectedServerId.value && erroredServerIds.value.has(selectedServerId.value)));
const agentBusy = computed(() => ["thinking", "running", "waiting_confirmation", "retrying"].includes(agentStatus.value)
  || delivery.pending.value.some((item) => item.scopeId === selectedServerId.value));
const contextRemainingPercent = computed(() => Math.max(0, Math.min(100, agentContextUsage.value.remainingPercent)));
const contextRingStyle = computed(() => {
  const remaining = contextRemainingPercent.value;
  const color = remaining > 40 ? "var(--green)" : remaining > 15 ? "var(--blue)" : "#e57373";
  return {
    background: `conic-gradient(${color} ${remaining * 3.6}deg, rgba(255, 255, 255, 0.12) 0deg)`
  };
});
const contextRemainingLabel = computed(() => {
  const used = agentContextUsage.value.usedTokens;
  const remaining = agentContextUsage.value.remainingTokens;
  const max = agentContextUsage.value.maxTokens;
  const maxK = agentContextUsage.value.contextSizeK;
  return [
    `剩余 ${contextRemainingPercent.value}%`,
    `已用 ${used.toLocaleString()} tokens`,
    `剩余 ${remaining.toLocaleString()} tokens`,
    `上限 ${max.toLocaleString()} tokens (${maxK}K)`
  ].join("\n");
});
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
  const completed = workflow.steps.length > 0 && workflow.steps.every((step) => step.status === "completed");
  if (!failedRun || workflow.status === "failed" || completed) return workflow;

  const fallbackStep = workflow.steps.find((step) => step.status === "running")
    ?? workflow.steps.find((step) => step.id === workflow.currentStepId && step.status !== "completed")
    ?? workflow.steps.find((step) => step.status !== "completed");
  const failedStepId = fallbackStep?.id || "";
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
    && workflow.steps.length > 0
    && workflow.steps.every((step) => step.status === "completed");
  if (!workflow) return serverSlot.value?.occupied ? "ready" : "not_started";
  if (workflow.status === "failed") return agentStatus.value === "cancelled" ? "cancelled" : "failed";
  if (workflowCompleted) return "completed";
  if (agentStatus.value === "waiting_confirmation") return "waiting_confirmation";
  if (agentStatus.value === "retrying") return "retrying";
  if (agentBusy.value) return "running";
  return "progress";
});
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

function openSettings(tab?: SettingsTab) {
  if (tab) settingsTab.value = tab;
  dashboardOpen.value = false;
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
  openSettings(settingsOpen.value ? undefined : "tools");
}

function openProxyTestDialog() {
  proxyTestTarget.value = proxyTestTarget.value.trim() || "www.google.com";
  proxyTestResult.value = null;
  proxyTestDialogOpen.value = true;
  openSettings("agent");
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

function toolNeedsConfig(tool: AgentToolRecord) {
  return Boolean(tool.configRequirements?.some((requirement) => requirement.required && !requirement.configured));
}

function toolConfigSummary(tool: AgentToolRecord) {
  if (!tool.configRequirements?.length) return "无需额外配置";
  const missing = tool.configRequirements.filter((requirement) => requirement.required && !requirement.configured);
  if (missing.length) return `待配置：${missing.map((item) => item.label).join("、")}`;
  return "所需配置已就绪";
}

function closeProviderKeyDialog() {
  providerKeyDialogOpen.value = false;
  pendingToolConfig.value = null;
}

function providerKeyPlaceholder(key: ToolConfigKey) {
  const hint = key === "searxngBaseUrl" ? "" : providerKeySettings.value[key === "curseForgeApiKey" ? "curseForgeApiKeyHint" : key === "modrinthApiKey" ? "modrinthApiKeyHint" : key === "braveSearchApiKey" ? "braveSearchApiKeyHint" : "tavilyApiKeyHint"];
  return hint && hint !== "未配置" ? `${hint}（留空保留）` : "留空保留，输入后覆盖";
}

function handleStatusBubbleAction(item: StatusBubbleItem) {
  if (item.actionKey === "provider-keys") openProviderKeyDialog(pendingToolConfig.value ?? undefined);
}

function openFileDialog(path?: string) {
  const openedFromMapEditor = path !== undefined;
  if (path) currentPath.value = path;
  fileDialogOpen.value = true;
  configDialogOpen.value = false;
  mapEditorDialogOpen.value = false;
  restoreMapEditorFocus.value = false;
  fileDialogFocusTarget.value = openedFromMapEditor ? "map" : "files";
  void nextTick(() => fileManagerDialog.value?.focusInitialAction());
  void loadFiles().catch(() => undefined);
}

function closeFileDialog() {
  fileDialogOpen.value = false;
}

function handleFileDialogAfterLeave() {
  if (fileDialogFocusTarget.value === "map") instanceTopbar.value?.focusMapEditorTrigger();
  if (fileDialogFocusTarget.value === "files") instanceTopbar.value?.focusFilesTrigger();
  fileDialogFocusTarget.value = null;
}

function openConfigDialog() {
  configDialogOpen.value = true;
  fileDialogOpen.value = false;
  mapEditorDialogOpen.value = false;
  void loadJavaState().catch(() => undefined);
}

async function retryServerConfig() {
  await Promise.allSettled([loadSettings(), loadJavaState()]);
}

function openMapEditorDialog() {
  restoreMapEditorFocus.value = false;
  mapEditorDialogOpen.value = true;
  fileDialogOpen.value = false;
  configDialogOpen.value = false;
}

function closeMapEditorDialog() {
  restoreMapEditorFocus.value = true;
  mapEditorDialogOpen.value = false;
}

function handleMapEditorAfterLeave() {
  if (restoreMapEditorFocus.value) instanceTopbar.value?.focusMapEditorTrigger();
  restoreMapEditorFocus.value = false;
}

function openInstanceMenu() {
  restoreInstanceMenuFocus.value = true;
  instanceMenuOpen.value = true;
}

function closeInstanceMenu(restoreFocus = true) {
  instanceMenuOpen.value = false;
  restoreInstanceMenuFocus.value = restoreFocus;
}

function handleInstanceMenuAfterLeave() {
  const action = pendingInstanceMenuAction.value;
  pendingInstanceMenuAction.value = null;
  if (action) {
    action();
    return;
  }
  if (restoreInstanceMenuFocus.value) void nextTick(() => serverSidebar.value?.focusInstanceMenuTrigger());
}

async function selectServerWithFeedback(id: string) {
  try {
    dashboardOpen.value = false;
    await selectServer(id);
  } catch (error) {
    showStatusBubble("error", `切换实例失败：${getErrorMessage(error)}`, 6200);
  }
}

async function selectServerFromMenu(id: string) {
  closeInstanceMenu(false);
  await selectServerWithFeedback(id);
}

function openCreateServerDialogFromMenu() {
  pendingInstanceMenuAction.value = openCreateServerDialog;
  closeInstanceMenu(false);
}

function openDeleteServerFromMenu(server: ServerRecord) {
  pendingInstanceMenuAction.value = () => openDeleteServer(server);
  closeInstanceMenu(false);
}

function toggleWorkspaceSettings() {
  if (settingsOpen.value) {
    settingsOpen.value = false;
    // Closing settings returns to the dashboard (the login landing view).
    if (!selectedServerId.value) dashboardOpen.value = true;
    return;
  }
  openSettings();
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
  mobileWorkspaceTab.value = "console";
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

watch(deploymentWorkflow, (workflow, previous) => {
  // Reveal the first workflow update; subsequent updates respect the user's choice.
  if (workflow && !previous) deploymentProgressDismissed.value = false;
});

function openDeploymentAgent() {
  deploymentProgressDismissed.value = true;
  void nextTick(() => {
    agentPanel.value?.focusPanel();
    agentPanel.value?.focusInput();
  });
}

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
  const list = agentPanel.value?.getMessageList();
  showAgentScrollToBottom.value = Boolean(list && !isNearListBottom(list));
}

function shouldStickAgentToBottom(role?: AgentMessage["role"]) {
  if (role === "user") return true;
  const list = agentPanel.value?.getMessageList();
  return !list || isNearListBottom(list);
}

function shouldStickConsoleToBottom() {
  const list = consolePanel.value?.getLogList();
  return !list || isNearListBottom(list);
}

function scrollConsoleHistoryToBottom() {
  scrollHistoryListToBottom(() => consolePanel.value?.getLogList() ?? null);
}

function scrollAgentHistoryToBottom() {
  scrollHistoryListToBottom(() => agentPanel.value?.getMessageList() ?? null);
  showAgentScrollToBottom.value = false;
}

function resetHistoryScrollPositions() {
  if (!process.client) return;
  void nextTick(() => {
    const list = consolePanel.value?.getLogList();
    if (list) list.scrollTop = 0;
    const messages = agentPanel.value?.getMessageList();
    if (messages) messages.scrollTop = 0;
  });
}

function appendAgentMessage(role: AgentMessage["role"], content: string, status: AgentStatus | null = null, serverId = selectedServerId.value) {
  if (serverId !== selectedServerId.value) return;
  agentMessageRevision += 1;
  const shouldScroll = shouldStickAgentToBottom(role);
  agentMessages.value.push({ id: localMessageId(), serverId, role, content, status, createdAt: new Date().toISOString() });
  if (shouldScroll) scrollAgentHistoryToBottom();
  else updateAgentScrollState();
}

function upsertAgentMessage(id: string, role: AgentMessage["role"], content: string, status: AgentStatus | null, serverId = selectedServerId.value) {
  if (serverId !== selectedServerId.value) return;
  agentMessageRevision += 1;
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

function appendAgentMessageDelta(id: string, delta: string, serverId = selectedServerId.value) {
  if (!delta) return;
  agentMessageRevision += 1;
  const shouldScroll = shouldStickAgentToBottom("agent");
  const existingIndex = agentMessages.value.findIndex((message) => message.id === id);
  if (existingIndex >= 0) {
    const existing = agentMessages.value[existingIndex];
    if (!existing) return;
    existing.content += delta;
    existing.status = existing.status ?? "running";
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

function updateAgentActivity(id: string, content: string, activity: AgentActivity, createdAt: string | undefined, delta: boolean, serverId: string) {
  const shouldScroll = shouldStickAgentToBottom();
  agentMessageRevision += 1;
  const existing = agentMessages.value.find((message) => message.id === id);
  if (existing) {
    existing.content = delta ? existing.content + content : content;
    existing.activity = activity;
    existing.status = activity.status;
  } else {
    agentMessages.value.push({ id, serverId, role: "system", content, activity, status: activity.status, createdAt: createdAt ?? activity.startedAt });
  }
  if (shouldScroll) scrollAgentHistoryToBottom();
  else updateAgentScrollState();
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
  await Promise.all([loadAgentMessages(), loadPendingConfirmation(), loadServerSlotStatus(), loadServerDetail(), loadFiles(), loadServerErrorState(serverId)]);
}

async function loadServers() {
  await serverListLoad.run(() => api<ServerRecord[]>("/api/servers"), (data) => {
    servers.value = data;
    if (!selectedServerId.value && data[0]) selectedServerId.value = data[0].id;
  });
  await loadServerErrorStates();
}

async function selectServer(id: string, options: { open?: boolean } = {}) {
  saveWorkspaceState();
  switchingDraft = true;
  const selection = ++selectionGeneration;
  closeSockets();
  consoleLoad.reset();
  historyLoad.reset();
  contextLoad.reset();
  fileLoad.reset();
  textLoad.reset();
  logs.value = [];
  files.value = [];
  fileDataPath.value = "";
  textEditor.open = false;
  if (options.open !== false) dashboardOpen.value = false;
  selectedServerId.value = id;
  consoleCommand.value = "";
  currentPath.value = ".";
  if (options.open !== false) settingsOpen.value = false;
  fileDialogOpen.value = false;
  configDialogOpen.value = false;
  mapEditorDialogOpen.value = false;
  pendingAgentAttachments.value = [];
  agentDownloads.value = [];
  agentWorkflow.value = null;
  serverSlot.value = null;
  serverSlotError.value = "";
  deploymentProgressDismissed.value = true;
  agentRetry.value = null;
  agentRetryNowSending.value = false;
  agentActiveModel.value = modelOverrideByScope.value[id] ?? "";
  agentMessages.value = [];
  resetHistoryScrollPositions();
  const results = await Promise.allSettled([loadServerDetail(), loadLogs(), loadFiles(), loadAgentMessages(), loadPendingConfirmation(), loadServerSlotStatus()]);
  if (id !== selectedServerId.value || selection !== selectionGeneration) return;
  restoreInstanceDraft(id);
  switchingDraft = false;
  saveWorkspaceState();
  connectSockets();
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

/**
 * Global-agent handoff: the backend already queued the task for the instance
 * agent, so here we only move the UI to that instance's console.
 */
async function openInstanceFromDashboard(serverId: string) {
  if (!servers.value.some((server) => server.id === serverId)) {
    try {
      servers.value = await api<ServerRecord[]>("/api/servers");
    } catch {
      showStatusBubble("error", "无法读取实例列表", 4000);
      return;
    }
  }
  const focusId = globalAgent.focus.value?.id;
  dashboardOpen.value = false;
  await selectServer(serverId);
  await globalAgent.acknowledgeFocus(focusId);
  showStatusBubble("success", `已跳转到实例：${selectedServer.value?.name ?? serverId}`, 2600);
}

function openDashboard() {
  dashboardOpen.value = true;
  settingsOpen.value = false;
}

const dashboardContextRemainingPercent = computed(() => Math.max(0, Math.min(100, globalAgent.contextUsage.value.remainingPercent)));
const dashboardContextRingStyle = computed(() => {
  const remaining = dashboardContextRemainingPercent.value;
  const color = remaining > 40 ? "var(--green)" : remaining > 15 ? "var(--blue)" : "#e57373";
  return { background: `conic-gradient(${color} ${remaining * 3.6}deg, rgba(255, 255, 255, 0.12) 0deg)` };
});
const dashboardContextRemainingLabel = computed(() => {
  const usage = globalAgent.contextUsage.value;
  return [
    `剩余 ${dashboardContextRemainingPercent.value}%`,
    `已用 ${usage.usedTokens.toLocaleString()} tokens`,
    `剩余 ${usage.remainingTokens.toLocaleString()} tokens`,
    `上限 ${usage.maxTokens.toLocaleString()} tokens (${usage.contextSizeK}K)`
  ].join("\n");
});
const showDashboardOutputLoading = computed(() => {
  if (!globalAgent.busy.value) return false;
  const messages = globalAgent.messages.value;
  let lastUser = -1;
  let lastOutput = -1;
  messages.forEach((message, index) => {
    if (message.role === "user") lastUser = index;
    if (message.role === "agent" && message.content.trim()) lastOutput = index;
  });
  return lastOutput <= lastUser;
});
const dashboardOutputLoadingText = computed(() => {
  if (globalAgent.status.value === "thinking") return "Agent 正在分析任务";
  if (globalAgent.status.value === "waiting_confirmation") return "等待确认后继续输出";
  return "Agent 正在执行。";
});
function dashboardRetryMessage() {
  const retry = globalAgent.retry.value;
  if (!retry) return "";
  return `模型连接短暂波动，${Math.max(0, Math.ceil((new Date(retry.nextRetryAt).getTime() - Date.now()) / 1000))} 秒后自动重试（第 ${retry.attempt} 次）`;
}

function dashboardShouldStickToBottom(role?: AgentMessage["role"]) {
  if (role === "user") return true;
  const list = dashboardView.value?.getMessageList();
  if (!list) return true;
  return list.scrollHeight - list.scrollTop - list.clientHeight <= 72;
}

function scrollDashboardToBottom() {
  if (!process.client) return;
  void nextTick(() => requestAnimationFrame(() => {
    const list = dashboardView.value?.getMessageList();
    if (list) list.scrollTop = list.scrollHeight;
  }));
  dashboardScrollToBottom.value = false;
}

function updateDashboardScrollState() {
  const list = dashboardView.value?.getMessageList();
  dashboardScrollToBottom.value = Boolean(list && list.scrollHeight - list.scrollTop - list.clientHeight > 72);
}

async function sendDashboardMessage() {
  if (globalAgent.historyLoad.initialLoading.value || !settingsLoad.loaded.value) return;
  const text = dashboardInput.value.trim();
  const attachments = [...dashboardAttachments.value];
  if ((!text && attachments.length === 0) || globalAgent.busy.value) return;
  const attachmentContent = formatAgentAttachmentMessage(attachments);
  const content = [text, attachmentContent].filter(Boolean).join("\n\n");
  const effort = dashboardReasoningEffort.value;
  dashboardInput.value = "";
  dashboardAttachments.value = [];
  scrollDashboardToBottom();
  await globalAgent.send(content, effort);
}

async function uploadDashboardAgentFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const form = new FormData();
  form.append("file", file);
  beginUpload(dashboardAgentUpload, file);
  try {
    const result = await upload<{ id: string; originalName: string }>("/api/uploads/global", form, {
      onProgress: (progress) => updateUploadProgress(dashboardAgentUpload, progress)
    });
    finishUpload(dashboardAgentUpload);
    if (result?.id) dashboardAttachments.value.push({ uploadId: result.id, originalName: result.originalName || file.name });
  } catch (error) {
    failUpload(dashboardAgentUpload);
    showStatusBubble("error", `上传失败：${getErrorMessage(error)}`, 6000);
  } finally {
    input.value = "";
  }
}

function openDashboardUploadPicker() {
  if (globalAgent.busy.value) {
    showStatusBubble("error", "Agent 正在处理任务，请等待完成后再上传文件", 4200);
    return;
  }
  dashboardView.value?.openUploadPicker();
}

function removeDashboardAttachment(uploadId: string) {
  dashboardAttachments.value = dashboardAttachments.value.filter((attachment) => attachment.uploadId !== uploadId);
}

async function clearDashboardContext() {
  if (globalAgent.busy.value) return;
  const confirmed = confirm("确定清除全局 Agent 的对话记录吗？实例与本机文件不会被删除。");
  if (!confirmed) return;
  await globalAgent.clearContext();
  dashboardAttachments.value = [];
}

const dashboardPlaceholder = computed(() => {
  if (globalAgent.status.value === "waiting_confirmation") return "请先处理确认弹窗，Agent 会继续或停止当前任务";
  if (globalAgent.status.value === "retrying") return "模型接口暂时异常，Agent 正在等待重试";
  if (globalAgent.busy.value) return "Agent 正在处理当前任务，可以先整理下一条需求";
  return "描述你想做的事：部署整合包、启动实例、排查崩溃…";
});

function openCreateFromDashboard() {
  // The ghost card is labelled "用对话创建", so start a real agent conversation.
  dashboardInput.value = "帮我创建一个新的 Minecraft 实例，用 1.20.1 的生存服";
  void nextTick(() => sendDashboardMessage());
}

/**
 * The global agent can create instances / change their state. Refresh the list
 * after each run so the dashboard reflects what the agent just did.
 */
watch(() => globalAgent.busy.value, (busy, wasBusy) => {
  if (busy || !wasBusy) return;
  void loadServers().catch(() => undefined);
});

// Route the UI when the global agent hands a task to an instance.
watch(() => globalAgent.focus.value, (focus) => {
  if (!focus) return;
  void openInstanceFromDashboard(focus.serverId).catch(() => undefined);
});

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
  if (!settingsLoad.loaded.value || !javaLoad.loaded.value) return;
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
  const serverId = selectedServerId.value;
  await consoleLoad.run(() => api<ConsoleLogEntry[]>(`/api/servers/${serverId}/logs?limit=500`), (data) => { logs.value = data; });
  scrollConsoleHistoryToBottom();
  await loadServerErrorState();
}

async function refreshConsoleLogs() {
  if (consoleRefreshing.value) return;
  consoleRefreshing.value = true;
  try {
    await safe(() => loadLogs());
  } finally {
    consoleRefreshing.value = false;
  }
}

async function loadServerErrorStates() {
  try {
    const states = await api<ServerErrorState[]>("/api/server-errors");
    serverErrorStates.value = Object.fromEntries(states.map((state) => [state.serverId, state]));
  } catch {
    // The red markers are advisory; keep the previous snapshot if the probe fails.
  }
}

async function loadServerErrorState(serverId = selectedServerId.value) {
  if (!serverId) return;
  try {
    const state = await api<ServerErrorState>(`/api/servers/${serverId}/errors`);
    serverErrorStates.value = { ...serverErrorStates.value, [state.serverId]: state };
  } catch {
    // Ignore: status-derived fallback still marks crashed instances red.
  }
}

/**
 * Pulls the error-relevant slice of the terminal from the backend and hands it to the
 * Agent as a normal task, so the analysis lands in the Agent conversation.
 */
async function analyzeConsoleErrors() {
  if (!selectedServerId.value || errorAnalysisSending.value) return;
  if (agentBusy.value) {
    showStatusBubble("error", "Agent 正在处理其他任务，请等待完成后再分析错误", 4200);
    return;
  }
  const serverId = selectedServerId.value;
  errorAnalysisSending.value = true;
  try {
    const digest = await api<ServerErrorDigest>(`/api/servers/${serverId}/errors/digest`);
    if (serverId !== selectedServerId.value) return;
    if (!digest.excerpt && !digest.hasError) {
      showStatusBubble("error", "终端里没有检测到报错内容", 3600);
      return;
    }
    agentInput.value = digest.prompt;
    pendingAgentAttachments.value = [];
    agentPanel.value?.focusPanel();
    await sendAgentMessage();
    if (digest.truncated) showStatusBubble("success", "错误日志较长，已截取报错相关片段发送给模型", 4200);
  } catch (error) {
    showStatusBubble("error", `分析错误失败：${getErrorMessage(error)}`, 6200);
  } finally {
    errorAnalysisSending.value = false;
  }
}

async function sendCommand() {
  const serverId = selectedServerId.value;
  if (!serverId || !consoleCommand.value.trim()) return;
  const command = consoleCommand.value.trim();
  consoleCommand.value = "";
  const history = consoleCommandHistories.value[serverId] ??= [];
  if (history.at(-1) !== command) history.push(command);
  if (consoleSocket?.readyState === WebSocket.OPEN) {
    try {
      consoleSocket.send(JSON.stringify({ type: "command", command }));
      return;
    } catch {
      // The socket can transition to CLOSING between the readyState check and send().
    }
  }
  try {
    await api(`/api/servers/${serverId}/command`, { method: "POST", body: { command } });
  } catch (error) {
    if (serverId === selectedServerId.value) {
      consoleCommand.value = command;
      showStatusBubble("error", `发送指令失败：${getErrorMessage(error)}`, 6200);
    }
  }
}

async function loadFiles() {
  if (!selectedServerId.value) return;
  const serverId = selectedServerId.value;
  const path = currentPath.value;
  if (fileDataPath.value !== path) {
    fileLoad.reset();
    files.value = [];
  }
  await fileLoad.run(() => api<FileEntry[]>(`/api/servers/${serverId}/files?path=${encodeURIComponent(path)}`), (nextFiles) => {
    files.value = nextFiles;
    fileDataPath.value = path;
    const visiblePaths = new Set(nextFiles.map((file) => file.path));
    selectedFilePaths.value = selectedFilePaths.value.filter((path) => visiblePaths.has(path));
    if (fileSelectionAnchorPath.value && !visiblePaths.has(fileSelectionAnchorPath.value)) fileSelectionAnchorPath.value = selectedFilePaths.value.at(-1) ?? "";
  });
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

async function createFolder(name: string) {
  if (!selectedServerId.value || !name.trim()) return;
  const path = currentPath.value === "." ? name : `${currentPath.value}/${name}`;
  await safe(() => api(`/api/servers/${selectedServerId.value}/files/folder`, { method: "POST", body: { path } }));
  await loadFiles();
}

async function createFile(name: string) {
  if (!selectedServerId.value || !name.trim()) return;
  const path = currentPath.value === "." ? name : `${currentPath.value}/${name}`;
  await safe(() => api(`/api/servers/${selectedServerId.value}/files`, { method: "POST", body: { path, content: "" } }));
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
  const serverId = selectedServerId.value;
  textLoad.reset();
  textEditor.path = path;
  textEditor.content = "";
  textEditor.open = true;
  await textLoad.run(() => api<{ content: string }>(`/api/servers/${serverId}/files/text?path=${encodeURIComponent(path)}`), (result) => { textEditor.content = result.content; });
}

async function saveTextFile() {
  if (!selectedServerId.value || textLoad.loading.value || !textLoad.loaded.value) return;
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

async function uploadServerSlot(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file || !selectedServerId.value || serverSlotUpload.active) return;
  const serverId = selectedServerId.value;
  const form = new FormData();
  form.append("file", file);
  serverSlotUploadServerId.value = serverId;
  serverSlotError.value = "";
  beginUpload(serverSlotUpload, file);
  try {
    const result = await safe(() => upload<ServerSlotStatus>(`/api/servers/${serverId}/agent/server-slot/upload`, form, {
      onProgress: (progress) => updateUploadProgress(serverSlotUpload, progress)
    }), serverId);
    finishUpload(serverSlotUpload);
    if (serverId === selectedServerId.value && result) serverSlot.value = result;
  } catch (error) {
    failUpload(serverSlotUpload);
    if (serverId === selectedServerId.value) serverSlotError.value = `上传失败：${getErrorMessage(error)}`;
  } finally {
    input.value = "";
  }
}

async function loadAgentMessages() {
  if (!selectedServerId.value) return;
  const serverId = selectedServerId.value;
  const revision = agentMessageRevision;
  await Promise.all([
    historyLoad.run(() => api<AgentMessage[]>(`/api/servers/${serverId}/agent/messages`), (messages) => {
      if (serverId !== selectedServerId.value || revision !== agentMessageRevision) return;
      const shouldScroll = shouldStickAgentToBottom();
      agentMessages.value = messages;
      if (shouldScroll) scrollAgentHistoryToBottom();
    }),
    loadAgentContextUsage()
  ]);
}

/** Persist a per-conversation model choice and notify the backend. */
async function setInstanceModel(modelName: string) {
  const serverId = selectedServerId.value;
  if (!serverId || !modelName) return;
  modelOverrideByScope.value = { ...modelOverrideByScope.value, [serverId]: modelName };
  agentActiveModel.value = modelName;
  if (agentSocket?.readyState === WebSocket.OPEN) {
    agentSocket.send(JSON.stringify({ type: "set-model", modelName }));
  } else {
    await api(`/api/servers/${serverId}/agent/model`, { method: "POST", body: { modelName } }).catch(() => undefined);
  }
  showStatusBubble("success", `本会话已切换模型：${modelName}`, 2400);
}

async function setGlobalModel(modelName: string) {
  if (!modelName) return;
  modelOverrideByScope.value = { ...modelOverrideByScope.value, global: modelName };
  dashboardActiveModel.value = modelName;
  await globalAgent.setModel(modelName);
  showStatusBubble("success", `全局会话已切换模型：${modelName}`, 2400);
}

async function loadAgentContextUsage() {
  if (!selectedServerId.value) {
    const maxTokens = (modelForm.contextSizeK || 120) * 1000;
    agentContextUsage.value = {
      contextSizeK: modelForm.contextSizeK || 120,
      maxTokens,
      usedTokens: 0,
      remainingTokens: maxTokens,
      remainingRatio: 1,
      remainingPercent: 100
    };
    return;
  }
  try {
    const serverId = selectedServerId.value;
    await contextLoad.run(() => api<AgentContextUsage>(`/api/servers/${serverId}/agent/context-usage`), (data) => { agentContextUsage.value = data; });
  } catch {
    // keep previous estimate if endpoint is temporarily unavailable
  }
}

async function loadPendingConfirmation() {
  if (!selectedServerId.value) return;
  const serverId = selectedServerId.value;
  const selection = selectionGeneration;
  const result = await api<{ confirmation: AgentConfirmationRequest | null }>(`/api/servers/${serverId}/agent/confirmation`);
  if (serverId !== selectedServerId.value || selection !== selectionGeneration) return;
  pendingConfirmation.value = result.confirmation;
}

async function loadServerSlotStatus() {
  if (!selectedServerId.value) return;
  const serverId = selectedServerId.value;
  const selection = selectionGeneration;
  serverSlotLoading.value = true;
  serverSlotError.value = "";
  try {
    const slot = await api<ServerSlotStatus>(`/api/servers/${serverId}/agent/server-slot`);
    if (serverId === selectedServerId.value && selection === selectionGeneration) serverSlot.value = slot;
  } catch (error) {
    if (serverId === selectedServerId.value && selection === selectionGeneration) serverSlotError.value = `无法读取服务端包：${getErrorMessage(error)}`;
  } finally {
    if (serverId === selectedServerId.value && selection === selectionGeneration) serverSlotLoading.value = false;
  }
}

async function sendAgentMessage() {
  if (historyLoad.initialLoading.value || !settingsLoad.loaded.value) return;
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

  await delivery.send(serverId, content, reasoningEffort);
}

function formatAgentAttachmentMessage(attachments: PendingAgentAttachment[]) {
  if (attachments.length === 0) return "";
  return [
    "本条消息附带以下已上传给当前 Agent 的临时文件：",
    ...attachments.map((attachment) => `- ${attachment.originalName}，uploadId=${attachment.uploadId}`),
    "这些文件尚未放入服务端目录。请先使用 list_uploaded_files 确认，再根据任务调用 save_upload_to_server_slot 或 move_upload_to_server；不要把 uploadId 当作服务端路径。"
  ].join("\n");
}

async function resolveAgentConfirmation(approved: boolean) {
  if (dashboardOpen.value) {
    await safe(() => globalAgent.resolveConfirmation(approved));
    return;
  }
  if (!selectedServerId.value || !pendingConfirmation.value) return;
  const confirmationId = pendingConfirmation.value.id;
  const serverId = selectedServerId.value;
  await safe(() => api(`/api/servers/${serverId}/agent/confirmation`, { method: "POST", body: { confirmationId, approved } }));
  if (serverId === selectedServerId.value && pendingConfirmation.value?.id === confirmationId) pendingConfirmation.value = null;
}

async function cancelAgentRun() {
  if (!selectedServerId.value || !agentBusy.value) return;
  const serverId = selectedServerId.value;
  delivery.discardScope(serverId);
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

async function compressAgentContext() {
  if (!selectedServerId.value || agentBusy.value) return;
  const serverId = selectedServerId.value;
  const result = await safe(() => api<{ ok: boolean; compressed: number }>(`/api/servers/${serverId}/agent/context/compress`, { method: "POST" }), serverId);
  if (serverId !== selectedServerId.value) return;
  if (result?.compressed) {
    appendAgentMessage("system", `已压缩 ${result.compressed} 条历史消息为摘要。`, "completed", serverId);
  }
  await loadAgentMessages();
  await loadServerSlotStatus();
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
  agentMessages.value = [];
  pendingConfirmation.value = null;
  pendingAgentAttachments.value = [];
  agentDownloads.value = [];
  agentWorkflow.value = null;
  agentRetry.value = null;
  agentRetryNowSending.value = false;
  agentStatus.value = "idle";
  await loadAgentContextUsage();
}

async function uploadAgentFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file || !selectedServerId.value) return;
  const form = new FormData();
  form.append("file", file);
  beginUpload(agentUpload, file);
  try {
    const result = await safe(() => upload<{ id: string; originalName: string }>(`/api/uploads/${selectedServerId.value}`, form, {
      onProgress: (progress) => updateUploadProgress(agentUpload, progress)
    }));
    finishUpload(agentUpload);
    if (result?.id) {
      pendingAgentAttachments.value.push({ uploadId: result.id, originalName: result.originalName || file.name });
    }
  } catch (error) {
    failUpload(agentUpload);
    throw error;
  } finally {
    input.value = "";
  }
}

function removePendingAgentAttachment(uploadId: string) {
  pendingAgentAttachments.value = pendingAgentAttachments.value.filter((attachment) => attachment.uploadId !== uploadId);
}

function openAgentUploadPicker() {
  if (agentBusy.value) {
    appendAgentMessage("system", "Agent 正在处理当前任务，请等待完成后再上传文件。", null);
    return;
  }
  agentPanel.value?.openUploadPicker();
}

async function loadSettings() {
  await settingsLoad.run(() => Promise.all([
    api<ModelConfig[]>("/api/models"),
    api<SkillRecord[]>("/api/skills"),
    api<AgentToolRecord[]>("/api/tools"),
    api<{ prompt: string }>("/api/prompts/global"),
    api<AgentSettings>("/api/settings/agent"),
    api<AgentToolSettings>("/api/settings/provider-keys"),
    api<JavaManagementState>("/api/java")
  ]), ([modelData, skillData, toolData, promptData, agentSettings, providerKeys, javaData]) => {
    models.value = modelData;
    const model = modelData[0];
    if (model) {
      Object.assign(modelForm, {
        displayName: fixedModelDisplayName,
        baseUrl: model.baseUrl,
        modelName: model.modelName,
        apiKey: "",
        apiType: model.apiType ?? "chat_completions",
        availableModels: model.availableModels ?? [],
        isDefault: true,
        contextSizeK: model.contextSizeK || 120
      });
      agentContextUsage.value = {
        ...agentContextUsage.value,
        contextSizeK: model.contextSizeK || 120,
        maxTokens: (model.contextSizeK || 120) * 1000,
        remainingTokens: Math.max(0, (model.contextSizeK || 120) * 1000 - agentContextUsage.value.usedTokens),
        remainingRatio: Math.max(0, 1 - agentContextUsage.value.usedTokens / ((model.contextSizeK || 120) * 1000)),
        remainingPercent: Math.round(Math.max(0, 1 - agentContextUsage.value.usedTokens / ((model.contextSizeK || 120) * 1000)) * 100)
      };
    }
    skills.value = skillData;
    agentTools.value = toolData;
    globalPrompt.value = promptData.prompt;
    providerKeySettings.value = providerKeys;
    providerKeyForm.curseForgeApiKey = "";
    providerKeyForm.modrinthApiKey = "";
    providerKeyForm.braveSearchApiKey = "";
    providerKeyForm.tavilyApiKey = "";
    agentAutoConfirm.value = agentSettings.autoConfirm;
    agentDownloadProxyEnabled.value = agentSettings.downloadProxyEnabled;
    agentDownloadProxyUrl.value = agentSettings.downloadProxyUrl;
    agentPythonPackageIndexUrl.value = agentSettings.pythonPackageIndexUrl;
    agentMemoryMb.value = agentSettings.memoryMb;
    systemMemoryMb.value = agentSettings.systemMemoryMb;
    applyJavaState(javaData);
    javaLoad.acceptSnapshot();
  });
}

async function loadJavaState() {
  await javaLoad.run(() => api<JavaManagementState>("/api/java"), applyJavaState);
}

function applyJavaState(state: JavaManagementState) {
  javaVersions.value = state.versions;
  javaInstalls.value = state.installed;
  javaTasks.value = state.tasks;
  javaDownloadSources.value = state.sources;
  if (!javaVersions.value.some((version) => version.version === javaVersionToInstall.value)) {
    javaVersionToInstall.value = javaVersions.value.find((version) => version.version === "21")?.version ?? javaVersions.value[0]?.version ?? javaVersionToInstall.value;
  }
  if (!serverForm.javaVersion) {
    serverForm.javaVersion = javaVersions.value.find((version) => version.installed && version.installPath)?.version ?? "";
  }
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
    apiType: modelForm.apiType,
    availableModels: modelForm.availableModels,
    isDefault: true,
    contextSizeK: Math.min(2000, Math.max(8, Math.round(Number(modelForm.contextSizeK) || 120)))
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
        apiType: saved.apiType ?? modelForm.apiType,
        availableModels: saved.availableModels ?? [],
        isDefault: true,
        contextSizeK: saved.contextSizeK || 120
      });
      await loadAgentContextUsage();
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

async function listAvailableModels() {
  if (modelListBusy.value || modelBusy.value) return;
  modelListBusy.value = true;
  showModelStatus("loading", "正在拉取上游模型列表...");
  try {
    const result = await safe(() => api<{ models: string[]; config?: ModelConfig }>("/api/models/available", {
      method: "POST",
      body: {
        id: models.value[0]?.id,
        baseUrl: modelForm.baseUrl,
        apiKey: modelForm.apiKey || undefined,
        apiType: modelForm.apiType,
        persist: true
      }
    }));
    const list = result?.models ?? [];
    modelForm.availableModels = list;
    if (result?.config) models.value = [result.config];
    if (list.length > 0 && !list.includes(modelForm.modelName)) modelForm.modelName = list[0] ?? modelForm.modelName;
    showModelStatus("success", `已拉取 ${list.length} 个可用模型`);
  } catch (error) {
    showModelStatus("error", `拉取失败：${getErrorMessage(error)}`);
  } finally {
    modelListBusy.value = false;
  }
}

async function testModel(id?: string) {
  if (modelBusy.value || (!id && hasUnsavedApiKey.value)) return;
  modelTesting.value = true;
  showModelStatus("loading", "正在测试模型连接...");
  const body = id ? { id } : {
    baseUrl: modelForm.baseUrl,
    modelName: modelForm.modelName,
    apiType: modelForm.apiType,
    apiKey: modelForm.apiKey || undefined
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

function openPromptEditor() {
  promptEditor.draft = globalPrompt.value;
  promptEditor.saving = false;
  promptEditor.open = true;
}

function closePromptEditor() {
  if (promptEditor.saving) return;
  promptEditor.open = false;
}

async function savePromptFromEditor() {
  if (promptEditor.saving) return;
  promptEditor.saving = true;
  try {
    const result = await safe(() => api<{ prompt: string }>("/api/prompts/global", {
      method: "PUT",
      body: { prompt: promptEditor.draft }
    }));
    if (!result) return;
    globalPrompt.value = result.prompt;
    promptEditor.open = false;
  } finally {
    promptEditor.saving = false;
  }
}

async function resetGlobalPrompt() {
  const result = await safe(() => api<{ prompt: string }>("/api/prompts/global/reset", { method: "POST" }));
  globalPrompt.value = result?.prompt ?? globalPrompt.value;
  if (promptEditor.open) promptEditor.draft = globalPrompt.value;
}

async function saveAgentSettings() {
  const result = await safe(() => api<AgentSettings>("/api/settings/agent", {
    method: "PUT",
    body: {
      autoConfirm: agentAutoConfirm.value,
      downloadProxyEnabled: agentDownloadProxyEnabled.value,
      downloadProxyUrl: agentDownloadProxyUrl.value,
      pythonPackageIndexUrl: agentPythonPackageIndexUrl.value,
      memoryMb: agentMemoryMb.value
    }
  }));
  if (!result) return;
  agentAutoConfirm.value = result.autoConfirm;
  agentDownloadProxyEnabled.value = result.downloadProxyEnabled;
  agentDownloadProxyUrl.value = result.downloadProxyUrl;
  agentPythonPackageIndexUrl.value = result.pythonPackageIndexUrl;
  agentMemoryMb.value = result.memoryMb;
  systemMemoryMb.value = result.systemMemoryMb;
}

function updateAgentMemorySetting(value: number) {
  agentMemoryMb.value = value;
  void saveAgentSettings();
}

function updateAgentProxyEnabled(value: boolean) {
  agentDownloadProxyEnabled.value = value;
  void saveAgentSettings();
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
        modrinthApiKey: providerKeyForm.modrinthApiKey || undefined,
        braveSearchApiKey: providerKeyForm.braveSearchApiKey || undefined,
        tavilyApiKey: providerKeyForm.tavilyApiKey || undefined,
        searxngBaseUrl: providerKeyForm.searxngBaseUrl || undefined
      }
    }));
    if (result) providerKeySettings.value = result;
    providerKeyForm.curseForgeApiKey = "";
    providerKeyForm.modrinthApiKey = "";
    providerKeyForm.braveSearchApiKey = "";
    providerKeyForm.tavilyApiKey = "";
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

function clampServerMemoryMb(value: number) {
  const max = serverMemoryMaxMb.value || systemMemoryMb.value || minimumServerMemoryMb;
  return Math.min(max, Math.max(minimumServerMemoryMb, Math.round(value / 512) * 512));
}

function memoryConfigValue(valueMb: number) {
  return formatMemoryConfig(clampServerMemoryMb(valueMb));
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

async function logout() {
  if (loggingOut.value) return;
  loggingOut.value = true;
  closeSockets();
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    // Clear the client-visible token even if the server is unavailable.
  } finally {
    document.cookie = "mcsa_token=; path=/; max-age=0; SameSite=Lax";
    await router.replace("/login");
    loggingOut.value = false;
  }
}

function scheduleSocketReconnect(serverId: string, generation: number) {
  if (!process.client || socketsClosedIntentionally || serverId !== selectedServerId.value || generation !== socketReconnectGeneration) return;
  // Console and agent sockets often close together; they share one reconnect attempt.
  if (socketReconnectTimer) return;
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
  const handleSocketClose = (socket: WebSocket) => {
    // A previous connection can finish closing after its replacement is open.
    if (socket !== consoleSocket && socket !== agentSocket) return;
    if (serverId !== selectedServerId.value || generation !== socketReconnectGeneration || socketsClosedIntentionally) return;
    scheduleSocketReconnect(serverId, generation);
  };
  const nextConsoleSocket = new WebSocket(`${wsBase}/ws/console/${serverId}${wsQuery}`);
  consoleSocket = nextConsoleSocket;
  nextConsoleSocket.onopen = () => {
    if (consoleSocket !== nextConsoleSocket) return;
    consoleConnected = true;
    markSocketOpen();
  };
  nextConsoleSocket.onmessage = (event) => {
    if (consoleSocket !== nextConsoleSocket || serverId !== selectedServerId.value) return;
    const payload = JSON.parse(event.data);
    if (payload.type === "clear") logs.value = [];
    if (payload.type === "error_state" && payload.errorState?.serverId) {
      serverErrorStates.value = { ...serverErrorStates.value, [payload.errorState.serverId]: payload.errorState };
    }
    if (payload.type === "snapshot" && Array.isArray(payload.entries)) {
      consoleLoad.acceptSnapshot();
      const shouldScroll = shouldStickConsoleToBottom();
      logs.value = payload.entries;
      if (logs.value.length > 800) logs.value.splice(0, logs.value.length - 800);
      if (shouldScroll) scrollConsoleHistoryToBottom();
    }
    if (payload.type === "log" && payload.entry) {
      // Deduplicate: REST loadLogs + WS snapshot/reconnect must not replay the same lines.
      if (logs.value.some((log) => log.id === payload.entry.id)) return;
      const shouldScroll = shouldStickConsoleToBottom();
      logs.value.push(payload.entry);
      if (logs.value.length > 800) logs.value.splice(0, logs.value.length - 800);
      if (shouldScroll) scrollConsoleHistoryToBottom();
    }
    if (payload.type === "status") {
      loadServers();
      loadServerErrorState(serverId).catch(() => undefined);
    }
    if (payload.type === "error" && payload.content) {
      showStatusBubble("error", `发送指令失败：${payload.content}`, 6200);
    }
  };
  nextConsoleSocket.onclose = () => handleSocketClose(nextConsoleSocket);
  nextConsoleSocket.onerror = () => nextConsoleSocket.close();
  const nextAgentSocket = new WebSocket(`${wsBase}/ws/agent/${serverId}${wsQuery}`);
  agentSocket = nextAgentSocket;
  nextAgentSocket.onopen = () => {
    if (agentSocket !== nextAgentSocket) return;
    agentConnected = true;
    markSocketOpen();
  };
  nextAgentSocket.onmessage = (event) => {
    if (agentSocket !== nextAgentSocket || serverId !== selectedServerId.value) return;
    const payload = JSON.parse(event.data) as { type?: string; status?: AgentStatus; content?: string; messageId?: string; messages?: AgentMessage[]; activity?: AgentActivity; createdAt?: string; confirmation?: AgentConfirmationRequest; toolConfigRequired?: AgentToolConfigRequired; retry?: AgentRetryState; download?: AgentDownloadProgress; downloads?: AgentDownloadProgress[]; workflow?: AgentWorkflowProgress; serverSlot?: ServerSlotStatus; modelName?: string | null };
    if (payload.type === "snapshot" && payload.messages) {
      historyLoad.acceptSnapshot();
      const shouldScroll = shouldStickAgentToBottom();
      agentMessageRevision += 1;
      agentMessages.value = payload.messages;
      agentRetry.value = payload.retry ?? null;
      pendingConfirmation.value = payload.confirmation ?? null;
      agentDownloads.value = payload.downloads ?? [];
      agentWorkflow.value = payload.workflow ?? null;
      pendingToolConfig.value = payload.toolConfigRequired ?? null;
      if (payload.toolConfigRequired) showProviderKeyStatus("error", payload.toolConfigRequired.message, true);
      if (payload.status) agentStatus.value = payload.status;
      if (payload.modelName) agentActiveModel.value = payload.modelName;
      if (shouldScroll) scrollAgentHistoryToBottom();
    }
    if (payload.type === "model") agentActiveModel.value = payload.modelName ?? "";
    if ((payload.type === "activity" || payload.type === "activity_delta") && payload.messageId && payload.activity) {
      updateAgentActivity(payload.messageId, payload.content ?? "", payload.activity, payload.createdAt, payload.type === "activity_delta", serverId);
    }
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
      openSettings("agent");
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
    if (payload.type === "server_slot" && payload.serverSlot) {
      serverSlot.value = payload.serverSlot;
      serverSlotError.value = "";
    }
    if (payload.type === "log" && payload.content) {
      if (payload.messageId) upsertAgentMessage(payload.messageId, "system", payload.content, null, serverId);
      else appendAgentMessage("system", payload.content, null, serverId);
    }
    if (payload.type === "message" && payload.messageId) {
      if (isTerminalAgentStatus(payload.status)) agentRetry.value = null;
      const existing = agentMessages.value.find((message) => message.id === payload.messageId);
      // Empty content is intentional for clearing the shared streaming bubble between tool rounds.
      // For terminal statuses, never replace a non-empty bubble with an empty string.
      const nextContent = payload.content === undefined || payload.content === null
        ? (existing?.content ?? "")
        : (isTerminalAgentStatus(payload.status) && !payload.content && existing?.content
          ? existing.content
          : payload.content);
      upsertAgentMessage(payload.messageId, "agent", nextContent, payload.status ?? "completed", serverId);
    } else if (payload.type === "message" && payload.content) {
      if (isTerminalAgentStatus(payload.status)) agentRetry.value = null;
      appendAgentMessage("agent", payload.content, payload.status ?? "completed", serverId);
    }
    if (payload.type === "message_delta" && payload.messageId && payload.content) {
      appendAgentMessageDelta(payload.messageId, payload.content, serverId);
    }
    if (payload.type === "error" && payload.content && payload.messageId) {
      agentRetry.value = null;
      upsertAgentMessage(payload.messageId, "agent", payload.content, payload.status ?? "failed", serverId);
      if (payload.status) agentStatus.value = payload.status;
    } else if (payload.type === "error" && payload.content) {
      appendAgentMessage("agent", payload.content, payload.status ?? "failed", serverId);
      if (payload.status) agentStatus.value = payload.status;
    }
    if (payload.type === "done") {
      agentRetry.value = null;
      agentRetryNowSending.value = false;
      if (payload.status) agentStatus.value = payload.status;
      window.setTimeout(clearTerminalAgentDownloads, 1600);
      refreshAfterAgentRun().catch(() => undefined);
      loadAgentContextUsage().catch(() => undefined);
    }
  };
  nextAgentSocket.onclose = () => handleSocketClose(nextAgentSocket);
  nextAgentSocket.onerror = () => nextAgentSocket.close();
}

interface InstanceDraft {
  input: string;
  attachments: PendingAgentAttachment[];
  path: string;
  command: string;
  editor: typeof textEditor;
  config?: ServerConfigForm;
  configOpen?: boolean;
}
interface WorkspaceState {
  selectedServerId: string;
  dashboardOpen: boolean;
  settingsOpen?: boolean;
  settingsTab?: SettingsTab;
  mobileWorkspaceTab: "console" | "deployment" | "agent";
  dashboardInput: string;
  dashboardAttachments: PendingAgentAttachment[];
  instances: Record<string, InstanceDraft>;
  commandHistories?: Record<string, string[]>;
  promptEditor?: typeof promptEditor;
}
let workspaceReady = false;
let switchingDraft = false;
let instanceDrafts: Record<string, InstanceDraft> = {};
let deliveryTimer: ReturnType<typeof setInterval> | undefined;

function saveWorkspaceState() {
  if (!workspaceReady || switchingDraft) return;
  if (selectedServerId.value) instanceDrafts[selectedServerId.value] = {
    input: agentInput.value, attachments: [...pendingAgentAttachments.value], path: currentPath.value,
    command: consoleCommand.value, editor: { ...textEditor }, config: { ...serverForm }, configOpen: configDialogOpen.value
  };
  writeBrowserState("workspace", {
    selectedServerId: selectedServerId.value, dashboardOpen: dashboardOpen.value, mobileWorkspaceTab: mobileWorkspaceTab.value,
    settingsOpen: settingsOpen.value, settingsTab: settingsTab.value,
    dashboardInput: dashboardInput.value, dashboardAttachments: dashboardAttachments.value, instances: instanceDrafts,
    commandHistories: consoleCommandHistories.value, promptEditor: { ...promptEditor, saving: false }
  } satisfies WorkspaceState);
}

function restoreInstanceDraft(id: string) {
  const draft = instanceDrafts[id];
  agentInput.value = draft?.input ?? "";
  pendingAgentAttachments.value = draft?.attachments ?? [];
  consoleCommand.value = draft?.command ?? "";
  Object.assign(textEditor, draft?.editor ?? { open: false, path: "", content: "" });
  if (draft?.editor.open) textLoad.acceptSnapshot();
  if (draft?.configOpen && draft.config) {
    Object.assign(serverForm, draft.config);
    configDialogOpen.value = true;
  }
  if (draft?.path && draft.path !== currentPath.value) {
    currentPath.value = draft.path;
    void loadFiles().catch(() => undefined);
  }
}

watch([dashboardInput, dashboardAttachments, agentInput, pendingAgentAttachments, currentPath, consoleCommand,
  () => ({ ...textEditor }), () => ({ ...serverForm }), configDialogOpen, () => ({ ...promptEditor }), consoleCommandHistories,
  dashboardOpen, settingsOpen, settingsTab, mobileWorkspaceTab], saveWorkspaceState, { deep: true, flush: "sync" });

function beforePageExit(event: BeforeUnloadEvent) {
  saveWorkspaceState();
  if (deploymentWorkflowDirty.value || [serverUpload, serverSlotUpload, agentUpload, dashboardAgentUpload].some((item) => item.active && !item.done)) {
    event.preventDefault();
    event.returnValue = "";
  }
}

onMounted(async () => {
  const saved = readBrowserState<WorkspaceState>("workspace");
  if (saved) {
    instanceDrafts = saved.instances ?? {};
    selectedServerId.value = saved.selectedServerId ?? "";
    dashboardOpen.value = saved.dashboardOpen ?? true;
    settingsOpen.value = saved.settingsOpen ?? false;
    if (saved.settingsTab && settingsNavItems.some((item) => item.id === saved.settingsTab)) settingsTab.value = saved.settingsTab;
    if (!selectedServerId.value && !dashboardOpen.value && !settingsOpen.value) dashboardOpen.value = true;
    mobileWorkspaceTab.value = saved.mobileWorkspaceTab ?? "console";
    dashboardInput.value = saved.dashboardInput ?? "";
    dashboardAttachments.value = saved.dashboardAttachments ?? [];
    consoleCommandHistories.value = saved.commandHistories ?? {};
    if (saved.promptEditor) Object.assign(promptEditor, saved.promptEditor, { saving: false });
  }
  delivery.restore();
  deliveryTimer = setInterval(() => void delivery.flush(), 3000);
  void delivery.flush();
  window.addEventListener("beforeunload", beforePageExit);
  window.addEventListener("pagehide", saveWorkspaceState);
  window.addEventListener("mouseup", endFileDragSelection);
  globalAgent.connect();
  void globalAgent.loadMessages().catch(() => undefined);
  await Promise.allSettled([
    safe(async () => {
      await loadServers();
      if (!servers.value.some((server) => server.id === selectedServerId.value)) selectedServerId.value = servers.value[0]?.id ?? "";
      // Navigation or a focus handoff may already have selected an instance while loading.
      if (selectedServerId.value && selectionGeneration === 0) await selectServer(selectedServerId.value, { open: !dashboardOpen.value && !settingsOpen.value });
    }),
    safe(loadSettings)
  ]);
  workspaceReady = true;
  saveWorkspaceState();
  startJavaPolling();
  startAgentRetryClock();
});

onBeforeUnmount(() => {
  saveWorkspaceState();
  window.removeEventListener("beforeunload", beforePageExit);
  window.removeEventListener("pagehide", saveWorkspaceState);
  if (deliveryTimer) clearInterval(deliveryTimer);
  window.removeEventListener("mouseup", endFileDragSelection);
  clearStatusBubbles();
  closeSockets();
  globalAgent.close();
  if (javaPollTimer) clearInterval(javaPollTimer);
  if (agentRetryClockTimer) clearInterval(agentRetryClockTimer);
});
</script>

<template>
  <div class="app-shell">
    <div class="background-field" aria-hidden="true">
      <div class="orb orb-a" />
      <div class="orb orb-b" />
      <div class="circuit-plane" />
    </div>

    <StatusBubble :items="statusBubbles" @action="handleStatusBubbleAction" />
    <div v-if="delivery.pending.value.length" class="card stack" role="status">
      <strong>有 {{ delivery.pending.value.length }} 条消息等待服务器确认接收，将自动重试；不会重复创建任务。</strong>
      <p class="muted">关闭页面后会保留待发送消息。移除仅停止重试，不会取消可能已经接收的任务。</p>
      <div v-for="item in delivery.pending.value" :key="item.requestId" class="row">
        <span>{{ item.content.slice(0, 100) }}</span>
        <button type="button" @click="delivery.discard(item.requestId)">移除待发送</button>
      </div>
    </div>

    <ProviderKeyDialog
      :form="providerKeyForm"
      :open="providerKeyDialogOpen"
      :pending-config="pendingToolConfig"
      :placeholder="providerKeyPlaceholder"
      :saving="providerKeySaving"
      :settings="providerKeySettings"
      @close="closeProviderKeyDialog"
      @save="saveProviderKeys"
      @update:curse-forge-api-key="providerKeyForm.curseForgeApiKey = $event"
      @update:modrinth-api-key="providerKeyForm.modrinthApiKey = $event"
      @update:brave-search-api-key="providerKeyForm.braveSearchApiKey = $event"
      @update:tavily-api-key="providerKeyForm.tavilyApiKey = $event"
      @update:searxng-base-url="providerKeyForm.searxngBaseUrl = $event"
    />

    <ProxyTestDialog
      :mode-label="proxyTestModeLabel"
      :open="proxyTestDialogOpen"
      :result="proxyTestResult"
      :result-text="proxyTestResultText"
      :target="proxyTestTarget"
      :testing="proxyTesting"
      @close="closeProxyTestDialog"
      @test="testProxyConnectivity"
      @update:target="proxyTestTarget = $event"
    />

    <CreateServerDialog v-model:name="newServerName" :open="createDialogOpen" @close="closeCreateServerDialog" @create="createServer" />

    <EmptyWorkspaceLanding v-if="showEmptyLanding && !dashboardOpen && !settingsOpen" @create="openCreateServerDialog" />

    <InstanceSwitcherDialog
      :open="instanceMenuOpen"
      :selected-server="selectedServer"
      :selected-server-id="selectedServerId"
      :servers="servers"
      :status-text="statusText"
      @close="closeInstanceMenu"
      @after-leave="handleInstanceMenuAfterLeave"
      @create="openCreateServerDialogFromMenu"
      @delete="openDeleteServerFromMenu"
      @select="selectServerFromMenu"
    />

    <ServerSidebar
      v-if="hasServers || dashboardOpen || settingsOpen"
      ref="serverSidebar"
       :loading="serverListLoad.initialLoading.value"
       :loaded="serversLoaded"
       :servers="servers"
       :selected-server-id="selectedServerId"
       :errored-server-ids="erroredServerIds"
       :settings-open="settingsOpen"
       :dashboard-open="dashboardOpen"
       @create="openCreateServerDialog"
       @open-dashboard="openDashboard"
       @open-instance-menu="openInstanceMenu"
       @open-settings="toggleWorkspaceSettings"
       @logout="logout"
       @select="selectServerWithFeedback"
    />

    <main v-if="hasServers || dashboardOpen || settingsOpen" class="main">
      <AgentConfirmationDialog :confirmation="dashboardOpen ? globalAgent.confirmation.value : pendingConfirmation" @resolve="resolveAgentConfirmation" />
      <AgentQuestionDialog :scope-id="dashboardOpen ? 'global' : selectedServerId" />

      <DeleteServerDialog
        v-model:confirm-name="deleteDialog.confirmName"
        :open="deleteDialog.open"
        :server="deleteDialog.server"
        :deleting="deleteDialog.deleting"
        :error="deleteDialog.error"
        :blocked="deleteServerBlocked"
        :confirmation-matches="deleteConfirmMatches"
        @close="closeDeleteServer"
        @confirm="deleteServer"
      />

      <div class="content-stage">
       <Transition name="server-switch" mode="out-in">
        <DashboardView
          v-if="dashboardOpen"
          key="dashboard"
          ref="dashboardView"
          :attachments="dashboardAttachments"
          :auto-confirm="agentAutoConfirm"
          :busy="globalAgent.busy.value"
          :context-remaining-label="dashboardContextRemainingLabel"
          :context-ring-style="dashboardContextRingStyle"
          :context-usage="globalAgent.contextUsage.value"
          :input="dashboardInput"
          :messages="globalAgent.messages.value"
           :history-loading="globalAgent.historyLoad.initialLoading.value"
           :context-loading="globalAgent.contextLoad.initialLoading.value"
           :context-error="!globalAgent.contextLoad.loaded.value ? globalAgent.contextLoad.error.value : ''"
           :history-error="globalAgent.historyLoad.error.value"
           :config-loading="settingsLoad.initialLoading.value"
           :config-error="!settingsLoad.loaded.value ? settingsLoad.error.value : ''"
           :servers-error="serverListLoad.error.value"
          :model-name="dashboardActiveModel || models.find(model => model.isDefault)?.modelName || models[0]?.modelName"
          :model-options="availableModelOptions"
          :output-loading="showDashboardOutputLoading"
          :output-loading-text="dashboardOutputLoadingText"
          :reasoning-effort="dashboardReasoningEffort"
          :retry="globalAgent.retry.value"
          :retry-message="dashboardRetryMessage()"
          :retry-now-sending="false"
          :scroll-to-bottom-visible="dashboardScrollToBottom"
          :servers="servers"
          :servers-loaded="serversLoaded"
          :status="globalAgent.status.value"
          :status-text="statusText"
          :upload="dashboardAgentUpload"
          :upload-detail="uploadDetail"
          @cancel="globalAgent.cancel()"
          @clear="clearDashboardContext"
          @compress="globalAgent.compressContext()"
          @create="openCreateFromDashboard"
           @reload-history="globalAgent.loadMessages().catch(() => undefined)"
           @reload-servers="loadServers().catch(() => undefined)"
          @message-scroll="updateDashboardScrollState"
          @open-instance="openInstanceFromDashboard"
          @remove-attachment="removeDashboardAttachment"
          @retry="globalAgent.retryNow()"
          @reuse-message="dashboardInput = $event"
          @scroll-to-bottom="scrollDashboardToBottom"
          @send="sendDashboardMessage"
          @update:auto-confirm="agentAutoConfirm = $event; saveAgentSettings()"
          @update:input="dashboardInput = $event"
          @update:model-name="setGlobalModel"
          @update:reasoning-effort="dashboardReasoningEffort = $event"
          @upload="uploadDashboardAgentFile"
          @upload-requested="openDashboardUploadPicker"
        />

        <WorkspaceSettingsPanel
          v-else-if="settingsOpen"
          key="settings"
           :loading="settingsLoad.loading.value"
           :loaded="settingsLoad.loaded.value"
           :load-error="settingsLoad.error.value"
           :agent-memory-label="agentMemoryLabel"
           :agent-memory-mb="agentMemoryMb"
           :agent-memory-warning="agentMemoryWarning"
           :auto-confirm="agentAutoConfirm"
          :agent-tools="agentTools"
          :api-key-placeholder="apiKeyPlaceholder"
          :fixed-model-display-name="fixedModelDisplayName"
          :global-prompt="globalPrompt"
          :has-unsaved-api-key="hasUnsavedApiKey"
          :java-download-source="javaDownloadSource"
          :java-download-sources="javaDownloadSources"
          :java-version-to-install="javaVersionToInstall"
          :java-versions="javaVersions"
          :model-busy="modelBusy"
          :model-form="modelForm"
          :model-list-busy="modelListBusy"
          :model-saving="modelSaving"
          :model-testing="modelTesting"
          :provider-key-settings="providerKeySettings"
          :proxy-enabled="agentDownloadProxyEnabled"
          :proxy-url="agentDownloadProxyUrl"
          :python-package-index-url="agentPythonPackageIndexUrl"
          :selected-java-busy="selectedJavaBusy"
          :selected-java-installed="selectedJavaInstalled"
          :selected-java-task="selectedJavaTask"
          :settings-nav-items="settingsNavItems"
          :settings-tab="settingsTab"
          :skills="skills"
          :system-memory-label="systemMemoryLabel"
          :system-memory-mb="systemMemoryMb"
          :tool-config-summary="toolConfigSummary"
          :tool-needs-config="toolNeedsConfig"
          :is-java-task-active="isJavaTaskActive"
          :is-java-task-cancellable="isJavaTaskCancellable"
          :java-status-class="javaStatusClass"
          :java-status-text="javaStatusText"
          :java-task-detail="javaTaskDetail"
          @cancel-java="cancelJavaInstall"
          @edit-prompt="openPromptEditor"
          @install-java="installJava"
          @open-provider-keys="openProviderKeyDialog"
          @open-proxy-test="openProxyTestDialog"
           @refresh="loadSettings().catch(() => undefined)"
          @reset-prompt="resetGlobalPrompt"
          @save-agent-settings="saveAgentSettings"
          @save-model="saveModel"
          @list-models="listAvailableModels"
          @test-model="testModel()"
          @toggle-skill="toggleSkill"
           @update:agent-memory-mb="updateAgentMemorySetting"
           @update:auto-confirm="agentAutoConfirm = $event; saveAgentSettings()"
          @update:java-download-source="javaDownloadSource = $event"
          @update:java-version-to-install="javaVersionToInstall = $event"
          @update:model-api-key="modelForm.apiKey = $event"
          @update:model-api-type="modelForm.apiType = $event"
          @update:model-base-url="modelForm.baseUrl = $event"
          @update:model-context-size-k="modelForm.contextSizeK = $event"
          @update:model-name="modelForm.modelName = $event"
          @update:proxy-enabled="updateAgentProxyEnabled"
          @update:proxy-url="agentDownloadProxyUrl = $event"
          @update:python-package-index-url="agentPythonPackageIndexUrl = $event"
          @update:settings-tab="settingsTab = $event"
        />

        <section v-else-if="selectedServer" :key="selectedServer.id" class="workspace single-workspace">
          <InstanceTopbar
            ref="instanceTopbar"
            :server="selectedServer"
            :status-class="statusClass"
            :status-text="serverStatusText"
            :can-run-action="canRunAction"
            @action="serverAction($event)"
            @open-config="openConfigDialog"
            @open-files="openFileDialog"
            @open-map-editor="openMapEditorDialog"
          />

          <nav class="mobile-workspace-nav" role="group" aria-label="服务端面板">
            <button type="button" :aria-pressed="mobileWorkspaceTab === 'console'" @click="mobileWorkspaceTab = 'console'">控制台</button>
            <button type="button" :aria-pressed="mobileWorkspaceTab === 'deployment'" @click="mobileWorkspaceTab = 'deployment'">部署</button>
            <button type="button" :aria-pressed="mobileWorkspaceTab === 'agent'" @click="mobileWorkspaceTab = 'agent'">Agent</button>
          </nav>

          <div id="server-mobile-workspace" class="operation-grid" :data-mobile-tab="mobileWorkspaceTab">
            <div class="left-operation-stack">
              <ConsolePanel
                ref="consolePanel"
                v-model:command="consoleCommand"
                :analyzing="errorAnalysisSending"
                :refreshing="consoleRefreshing"
                :loading="consoleLoad.initialLoading.value"
                :load-error="consoleLoad.error.value"
                :command-history="consoleCommandHistory"
                :error-state="selectedServerErrorState"
                :has-error="selectedServerHasError"
                :logs="logs"
                :rendered-logs="renderedConsoleLogs"
                @analyze="analyzeConsoleErrors"
                @refresh="refreshConsoleLogs"
                @send="sendCommand"
              />

              <DeploymentProgressPanel
                v-if="showDeploymentProgressCard"
                :key="selectedServerId"
                :dismissed="deploymentProgressDismissed"
                :loading="historyLoad.initialLoading.value || (serverSlotLoading && !serverSlot)"
                :load-error="historyLoad.error.value || serverSlotError"
                :server-name="selectedServer?.name ?? ''"
                :state="deploymentProgressState"
                :slot="serverSlot"
                :slot-loading="serverSlotLoading"
                :slot-error="serverSlotError"
                :slot-size="formatBytes"
                :slot-upload="selectedServerSlotUpload"
                :upload-busy="serverSlotUpload.active"
                :slot-upload-detail="uploadDetail"
                :workflow="deploymentWorkflow"
                @refresh="loadServerSlotStatus"
                @open-agent="openDeploymentAgent"
                @upload-server-slot="uploadServerSlot"
                @toggle-dismissed="deploymentProgressDismissed = !deploymentProgressDismissed"
              />

            </div>

            <AgentPanel
              ref="agentPanel"
              :attachments="pendingAgentAttachments"
              :auto-confirm="agentAutoConfirm"
              :busy="agentBusy"
              :context-remaining-label="contextRemainingLabel"
              :context-ring-style="contextRingStyle"
              :context-usage="agentContextUsage"
              :input="agentInput"
              :messages="agentMessages"
              :history-loading="historyLoad.initialLoading.value"
              :context-loading="contextLoad.initialLoading.value"
              :context-error="!contextLoad.loaded.value ? contextLoad.error.value : ''"
              :history-error="historyLoad.error.value"
              :config-loading="settingsLoad.initialLoading.value"
              :config-error="!settingsLoad.loaded.value ? settingsLoad.error.value : ''"
              :model-name="agentActiveModel || models.find(model => model.isDefault)?.modelName || models[0]?.modelName"
              :model-options="instanceModelOptions"
              :output-loading="showAgentOutputLoading"
              :output-loading-text="agentOutputLoadingText"
              :placeholder="agentPlaceholder"
              :reasoning-effort="agentReasoningEffort"
              :retry="agentRetry"
              :retry-message="agentRetryMessage"
              :retry-now-sending="agentRetryNowSending"
              :scroll-to-bottom-visible="showAgentScrollToBottom"
              :status="agentStatus"
              :upload="agentUpload"
              :upload-detail="uploadDetail"
              :upload-session-id="selectedServerId"
              @cancel="cancelAgentRun"
              @reload-history="loadAgentMessages().catch(() => undefined)"
              @clear="clearAgentContext"
              @compress="compressAgentContext"
              @message-scroll="updateAgentScrollState"
              @remove-attachment="removePendingAgentAttachment"
              @retry="retryAgentNow"
              @scroll-to-bottom="scrollAgentHistoryToBottom"
              @send="sendAgentMessage"
              @reuse-message="agentInput = $event"
              @update:auto-confirm="agentAutoConfirm = $event; saveAgentSettings()"
              @update:input="agentInput = $event"
              @update:model-name="setInstanceModel"
              @update:reasoning-effort="agentReasoningEffort = $event"
              @upload="uploadAgentFile"
              @upload-requested="openAgentUploadPicker"
            />
          </div>
        </section>
      </Transition>
      </div>

      <Transition name="modal" @after-leave="handleMapEditorAfterLeave">
        <div v-if="mapEditorDialogOpen && selectedServer" class="modal-backdrop" @click.self="closeMapEditorDialog">
          <MapEditorDialog
            :server="selectedServer"
            @close="closeMapEditorDialog"
          />
        </div>
      </Transition>

      <Transition name="modal" @after-leave="handleFileDialogAfterLeave">
        <div v-if="fileDialogOpen && selectedServer" class="modal-backdrop" @click.self="closeFileDialog">
          <FileManagerDialog
            ref="fileManagerDialog"
            :current-path="currentPath"
            :download-url="downloadUrl"
            :files="sortedFiles"
            :format-bytes="formatBytes"
            :loading="filesLoading"
            :load-error="fileLoad.error.value"
            :parent-directory-path="parentDirectoryPath"
            :selected-file="selectedFile ?? null"
            :selected-file-paths="selectedFilePaths"
            :selected-files="selectedFiles"
            :server="selectedServer"
            :upload="serverUpload"
            :upload-detail="uploadDetail"
            @begin-selection="beginFileDragSelection"
            @close="closeFileDialog"
            @create-file="createFile"
            @create-folder="createFolder"
            @drag-select="dragSelectFile"
            @go-up="goUp"
            @open-entry="openFileEntry"
            @open-folder="openFolder"
            @refresh="loadFiles().catch(() => undefined)"
            @remove-selected="removeSelectedFiles"
            @rename-file="renameFile"
            @show-properties="showFileProperties"
            @toggle-selected="toggleSelectedFile"
            @upload="uploadServerFile"
          />
        </div>
      </Transition>

      <Transition name="modal">
        <div v-if="configDialogOpen && selectedServer" class="modal-backdrop">
          <ServerConfigDialog
            :form="serverForm"
            :loading="settingsLoad.initialLoading.value || javaLoad.initialLoading.value"
            :load-error="!settingsLoad.loaded.value ? settingsLoad.error.value : !javaLoad.loaded.value ? javaLoad.error.value : ''"
            :format-memory="formatMemoryMb"
            :java-versions="configJavaVersionOptions"
            :memory-label="serverMemoryLabel"
            :memory-max-mb="serverMemoryMaxMb"
            :memory-mb="serverMemoryMb"
            :memory-warning="serverMemoryWarning"
            :minimum-memory-mb="minimumServerMemoryMb"
            :system-memory-label="systemMemoryLabel"
            @close="configDialogOpen = false"
            @save="saveServerConfig"
            @retry="retryServerConfig"
            @select-java="applyServerJavaSelection"
            @update:memory-mb="serverMemoryMb = $event"
          />
        </div>
      </Transition>

      <TextFileEditorDialog
        :content="textEditor.content"
        :loading="textLoad.loading.value"
        :load-error="textLoad.error.value"
        :open="textEditor.open"
        :path="textEditor.path"
        @close="textEditor.open = false"
        @save="saveTextFile"
        @retry="editFile(textEditor.path).catch(() => undefined)"
        @update:content="textEditor.content = $event"
      />

      <GlobalPromptEditorDialog
        :draft="promptEditor.draft"
        :open="promptEditor.open"
        :saving="promptEditor.saving"
        @close="closePromptEditor"
        @save="savePromptFromEditor"
        @update:draft="promptEditor.draft = $event"
      />
    </main>
  </div>
</template>
