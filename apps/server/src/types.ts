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
  memory: string;
  memoryMb: number;
  systemMemoryMb: number;
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

export interface AgentRetryEvent {
  attempt: number;
  delayMs: number;
  nextRetryAt: string;
  message: string;
}

export interface AgentEvent {
  type: "status" | "message" | "message_delta" | "log" | "error" | "done" | "confirmation_required" | "confirmation_resolved" | "download_progress" | "workflow_progress" | "server_slot" | "retry_scheduled" | "retry_cleared" | "tool_config_required";
  status?: AgentStatus;
  content?: string;
  messageId?: string;
  retry?: AgentRetryEvent;
  download?: AgentDownloadProgress;
  workflow?: AgentWorkflowProgress;
  serverSlot?: ServerSlotStatus;
  confirmation?: AgentConfirmationRequest;
  toolConfigRequired?: AgentToolConfigRequired;
  confirmationId?: string;
  approved?: boolean;
}

export interface AgentConfirmationRequest {
  id: string;
  serverId: string;
  title: string;
  description: string;
  risk: "medium" | "high";
  createdAt: string;
}
