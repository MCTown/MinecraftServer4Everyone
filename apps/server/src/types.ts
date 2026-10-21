export type ServerStatus = "stopped" | "starting" | "running" | "stopping" | "crashed" | "orphaned";

export type AgentStatus = "idle" | "thinking" | "running" | "waiting_confirmation" | "retrying" | "completed" | "failed" | "cancelled";

export type AgentRole = "user" | "agent" | "system";

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

export interface AgentSettings {
  autoConfirm: boolean;
  downloadProxyEnabled: boolean;
  downloadProxyUrl: string;
  pythonPackageIndexUrl: string;
  memory: string;
  memoryMb: number;
  systemMemoryMb: number;
}

export type ToolConfigKey = "curseForgeApiKey" | "modrinthApiKey" | "braveSearchApiKey" | "tavilyApiKey" | "searxngBaseUrl";

export interface AgentToolSettings {
  curseForgeApiKeyConfigured: boolean;
  curseForgeApiKeyHint: string;
  modrinthApiKeyConfigured: boolean;
  modrinthApiKeyHint: string;
  braveSearchApiKeyConfigured: boolean;
  braveSearchApiKeyHint: string;
  tavilyApiKeyConfigured: boolean;
  tavilyApiKeyHint: string;
  searxngBaseUrl: string;
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

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number;
  modifiedAt: string;
  editable: boolean;
}

export type MapWorldDimension = "overworld" | "nether" | "end" | "custom";

export interface MapWorldDirectory {
  id: string;
  dimension: MapWorldDimension;
  label: string;
  worldPath: string;
  regionPath: string;
  regionFileCount: number;
}

export interface MapWorldDiscovery {
  worlds: MapWorldDirectory[];
  truncated: boolean;
}

export interface McaRegionFile {
  path: string;
  name: string;
  regionX: number;
  regionZ: number;
  size: number;
  modifiedAt: string;
}

export interface McaRegionPage {
  regions: McaRegionFile[];
  offset: number;
  limit: number;
  total: number;
}

export interface McaHeaderChunk {
  localX: number;
  localZ: number;
  chunkX: number;
  chunkZ: number;
  sectorOffset: number;
  sectorCount: number;
  timestamp: string | null;
  valid: boolean;
}

export interface McaHeaderScan {
  region: McaRegionFile & {
    occupiedChunkCount: number;
    invalidChunkCount: number;
  };
  chunks: McaHeaderChunk[];
}

export interface MapChunkPreviewCell {
  localX: number;
  localZ: number;
  height: number;
  block: string;
  color: string;
  /** Color of the first opaque block beneath the translucent run; null when the surface is dry. */
  below: string | null;
  /** Block id of the first opaque block beneath the translucent run; null when the surface is dry. */
  belowBlock: string | null;
  /** Number of translucent blocks between the surface and `below`; 0 means the column is dry. */
  water: number;
  /** Combined light (max of sky and block) at the cell above the surface; 15 when light data is absent. */
  light: number;
  /** Combined light at the cell above `below`; only meaningful under translucent surfaces. */
  belowLight: number;
}

export interface MapChunkPreview {
  path: string;
  regionX: number;
  regionZ: number;
  localX: number;
  localZ: number;
  chunkX: number;
  chunkZ: number;
  dataVersion: number | null;
  cells: MapChunkPreviewCell[];
  unsupportedReason: string | null;
}

export type MapMutationMode = "chunks" | "rectangle" | "region";

export interface MapMutationSelection {
  regionPath: string;
  regionFilePath: string;
  mode: MapMutationMode;
  chunks?: Array<{ localX: number; localZ: number }>;
  rectangle?: { minX: number; minZ: number; maxX: number; maxZ: number };
}

export interface MapMutationPlan {
  mode: MapMutationMode;
  confirmationPhrase: string;
  selectionToken: string;
  affectedPaths: string[];
  affectedChunkCount: number | null;
  externalChunkFiles: string[];
  requiresStoppedServer: true;
  serverStatus: ServerStatus;
}

export interface MapSnapshotFile {
  path: string;
  backupName: string;
  size: number;
  modifiedAt: string;
  missing: boolean;
}

export interface MapSnapshot {
  id: string;
  serverId: string;
  name: string;
  description: string;
  reason: "manual" | "delete";
  createdAt: string;
  files: MapSnapshotFile[];
  rollbackConfirmationPhrase: string;
  deleteConfirmationPhrase: string;
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
  roundIndex?: number;
  parallelGroup?: string;
}

export interface AgentWorkflowProgress {
  turn?: { runId: string; turnId: string; index: number; total: number; stepIds: string[]; waitingForJobs?: boolean };
  title: string;
  currentStepId: string;
  overallProgress: number;
  status: AgentWorkflowStepStatus;
  steps: AgentWorkflowStep[];
}

export type ServerSlotSource = "user_upload" | "agent_upload" | "remote_download";

export interface ServerSlotStatus {
  occupied: boolean;
  directory: string;
  fileName: string | null;
  filePath: string | null;
  size: number | null;
  modifiedAt: string | null;
  source: ServerSlotSource | null;
}

export interface AgentRetryEvent {
  attempt: number;
  delayMs: number;
  nextRetryAt: string;
  message: string;
}

export interface AgentActivity {
  background?: boolean;
  jobId?: string;
  kind: "reasoning" | "tool" | "retry";
  status: "running" | "waiting_confirmation" | "completed" | "failed" | "cancelled";
  title: string;
  startedAt: string;
  finishedAt?: string;
  toolName?: string;
  toolCallId?: string;
  input?: string;
  error?: string;
  attempt?: number;
  nextRetryAt?: string;
}

export interface AgentEvent {
  turnId?: string;
  stepId?: string;
  type: "status" | "message" | "message_delta" | "activity" | "activity_delta" | "log" | "error" | "done" | "confirmation_required" | "confirmation_resolved" | "download_progress" | "workflow_progress" | "server_slot" | "retry_scheduled" | "retry_cleared" | "tool_config_required" | "focus_instance" | "model" | "inbox_updated";
  status?: AgentStatus;
  content?: string;
  messageId?: string;
  activity?: AgentActivity;
  createdAt?: string;
  retry?: AgentRetryEvent;
  download?: AgentDownloadProgress;
  workflow?: AgentWorkflowProgress;
  serverSlot?: ServerSlotStatus;
  confirmation?: AgentConfirmationRequest;
  toolConfigRequired?: AgentToolConfigRequired;
  confirmationId?: string;
  approved?: boolean;
  focus?: AgentFocusInstance;
  /** Active model name for this conversation (per-scope override or default). */
  modelName?: string | null;
}

/**
 * Global-agent handoff: the dashboard agent points the UI at one instance and
 * carries a task summary over, so the instance agent can continue the work.
 */
export interface AgentFocusInstance {
  serverId: string;
  serverName: string;
  task: string;
  reason: string;
}

export interface AgentMessageRecord {
  turnId?: string | null;
  stepId?: string | null;
  id: string;
  serverId: string;
  role: AgentRole;
  content: string;
  status: AgentStatus | null;
  createdAt: string;
  activity?: AgentActivity | null;
}

export interface GlobalAgentMessage extends AgentMessageRecord {
  focusServerId: string | null;
}
export interface AgentQuestionInput {
  question: string;
  multiple: boolean;
  options: { label: string; description?: string }[];
}

export interface AgentQuestionRequest extends AgentQuestionInput {
  id: string;
  serverId: string;
  createdAt: string;
}

export interface AgentQuestionAnswer {
  status: "answered" | "cancelled" | "expired";
  selected: string[];
}

export interface AgentConfirmationRequest {
  id: string;
  serverId: string;
  title: string;
  description: string;
  risk: "medium" | "high";
  createdAt: string;
}
