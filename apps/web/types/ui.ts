import type { AgentDownloadProgress } from "~/types/app";

export type SettingsTab = "model" | "skills" | "tools" | "agent" | "java";

export type StatusBubbleType = "idle" | "loading" | "success" | "error";

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
  path: string;
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
