export type ServerStatus = "stopped" | "starting" | "running" | "stopping" | "crashed";

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
  type: "status" | "message" | "message_delta" | "log" | "error" | "done" | "confirmation_required" | "confirmation_resolved" | "download_progress" | "workflow_progress" | "server_slot" | "retry_scheduled" | "retry_cleared";
  status?: AgentStatus;
  content?: string;
  messageId?: string;
  retry?: AgentRetryEvent;
  download?: AgentDownloadProgress;
  workflow?: AgentWorkflowProgress;
  serverSlot?: ServerSlotStatus;
  confirmation?: AgentConfirmationRequest;
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
