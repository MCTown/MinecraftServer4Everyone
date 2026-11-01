import type { AgentDownloadProgress } from "~/types/app";

export type SettingsTab = "overview" | "model" | "workflow" | "skills" | "tools" | "agent" | "java" | "template";

export type StatusBubbleType = "idle" | "loading" | "success" | "error";

export type DeploymentProgressState = "not_started" | "ready" | "running" | "waiting_confirmation" | "retrying" | "progress" | "completed" | "failed" | "cancelled";

export interface StatusBubbleItem {
  id: number;
  message: string;
  type?: StatusBubbleType;
  durationMs?: number;
  progressKey?: number;
  download?: AgentDownloadProgress;
  actionLabel?: string;
  actionKey?: string;
}

export interface UploadState {
  active: boolean;
  fileName: string;
  loaded: number;
  total: number;
  percent: number;
  done: boolean;
}

export interface PendingAgentAttachment {
  uploadId: string;
  originalName: string;
}

export interface SettingsNavItem {
  id: SettingsTab;
  label: string;
  desc: string;
}

export interface ServerConfigForm {
  jarFile: string;
  javaPath: string;
  javaVersion: string;
  maxMemory: string;
  minecraftVersion: string;
  minMemory: string;
  modpackName: string;
  name: string;
  promptOverride: string;
  startArgs: string;
  startupCommand: string;
  useGlobalPrompt: boolean;
}
