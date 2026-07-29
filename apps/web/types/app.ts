export type ServerStatus = "stopped" | "starting" | "running" | "stopping" | "crashed" | "orphaned";
export type AgentStatus = "idle" | "thinking" | "running" | "waiting_confirmation" | "retrying" | "completed" | "failed" | "cancelled";

export interface ServerRecord {
  id: string;
  name: string;
  directory: string;
  status: ServerStatus;
  javaPath: string | null;
  javaVersion: string | null;
  minMemory: string;
  maxMemory: string;
  jarFile: string;
  startArgs: string;
  startupCommand: string | null;
  serverType: string | null;
  minecraftVersion: string | null;
  modpackName: string | null;
  promptOverride: string | null;
  useGlobalPrompt: number;
  createdAt: string;
  updatedAt: string;
}

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number;
  modifiedAt: string;
  editable: boolean;
}

export interface ConsoleLogEntry {
  id: string;
  serverId: string;
  stream: "stdout" | "stderr" | "system";
  text: string;
  createdAt: string;
}

export type ServerErrorLevel = "error" | "fatal";

export interface ServerErrorState {
  serverId: string;
  hasError: boolean;
  level: ServerErrorLevel | null;
  count: number;
  latestText: string;
  firstAt: string | null;
  lastAt: string | null;
}

export interface ServerErrorDigest {
  serverId: string;
  hasError: boolean;
  level: ServerErrorLevel | null;
  errorLineCount: number;
  truncated: boolean;
  excerpt: string;
  prompt: string;
}

export interface AgentMessage {
  id: string;
  serverId: string;
  role: "user" | "agent" | "system";
  content: string;
  status: AgentStatus | null;
  createdAt: string;
}

export interface AgentConfirmationRequest {
  id: string;
  serverId: string;
  title: string;
  description: string;
  risk: "medium" | "high";
  createdAt: string;
}

export type ToolConfigKey = "curseForgeApiKey" | "modrinthApiKey";

export interface AgentToolSettings {
  curseForgeApiKeyConfigured: boolean;
  curseForgeApiKeyHint: string;
  modrinthApiKeyConfigured: boolean;
  modrinthApiKeyHint: string;
}

export interface AgentToolConfigRequirement {
  key: ToolConfigKey;
  label: string;
  required: boolean;
  configured: boolean;
  helpUrl: string;
  secret: boolean;
}

export interface AgentToolConfigRequired {
  key: ToolConfigKey;
  label: string;
  toolName?: string;
  helpUrl: string;
  message: string;
}

export interface AgentDownloadProgress {
  id: string;
  url: string;
  fileName: string;
  destinationPath: string;
  loadedBytes: number;
  totalBytes: number | null;
  percent: number;
  status: "starting" | "downloading" | "completed" | "cancelled" | "failed";
  error?: string;
}

export type AgentWorkflowStepStatus = "pending" | "running" | "completed" | "failed";

export interface AgentWorkflowStep {
  id: string;
  label: string;
  status: AgentWorkflowStepStatus;
  progress: number;
  detail: string;
}

export interface AgentWorkflowProgress {
  title: string;
  currentStepId: string;
  overallProgress: number;
  status: AgentWorkflowStepStatus;
  steps: AgentWorkflowStep[];
}

export interface ServerSlotStatus {
  occupied: boolean;
  directory: string;
  fileName: string | null;
  filePath: string | null;
  size: number | null;
  modifiedAt: string | null;
}

export interface AgentSettings {
  autoConfirm: boolean;
  downloadProxyEnabled: boolean;
  downloadProxyUrl: string;
  memory: string;
  memoryMb: number;
  systemMemoryMb: number;
}

export interface ProxyTestResult {
  ok: boolean;
  targetUrl: string;
  proxyEnabled: boolean;
  usedProxy: boolean;
  status: number | null;
  statusText: string;
  finalUrl: string;
  elapsedMs: number;
  error: string | null;
}

export interface AgentRetryState {
  attempt: number;
  delayMs: number;
  nextRetryAt: string;
  message: string;
}

export interface ModelConfig {
  id: string;
  displayName: string;
  baseUrl: string;
  modelName: string;
  apiKeyHint: string;
  isDefault: boolean;
  contextSizeK: number;
}

export interface AgentContextUsage {
  contextSizeK: number;
  maxTokens: number;
  usedTokens: number;
  remainingTokens: number;
  remainingRatio: number;
  remainingPercent: number;
}

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  builtIn: boolean;
}

export interface AgentToolRecord {
  name: string;
  description: string;
  category: string;
  controllable: false;
  configRequirements?: AgentToolConfigRequirement[];
}

export interface JavaInstall {
  version: string;
  name: string;
  path: string;
  available: boolean;
}

export type JavaInstallTaskStatus = "pending" | "resolving" | "downloading" | "extracting" | "installing" | "cancelling" | "installed" | "failed" | "cancelled";
export type JavaDownloadSource = "auto-cn" | "tsinghua" | "cernet" | "official";

export interface JavaDownloadSourceOption {
  id: JavaDownloadSource;
  label: string;
  description: string;
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

export interface JavaManagementState {
  versions: JavaVersionRecord[];
  installed: JavaInstall[];
  tasks: JavaInstallTask[];
  sources: JavaDownloadSourceOption[];
}
