import path from "node:path";
import type { ChatToolDefinition } from "../services/modelService.js";
import type { FileService } from "../services/fileService.js";
import type { JavaService } from "../services/javaService.js";
import type { ProcessManager } from "../services/processManager.js";
import type { ServerService } from "../services/serverService.js";
import type { UploadService } from "../services/uploadService.js";
import type { AgentConfirmationRequest, AgentDownloadProgress, AgentToolConfigRequired, AgentToolConfigRequirement, AgentWorkflowProgress, ConsoleLogEntry, ServerSlotStatus } from "../types.js";

export const stringProperty = { type: "string" };

export const installableCapabilities = {
  zip_extract: {
    name: "服务端压缩包解压能力",
    description: "解压当前服务端目录内已经存在的 .zip/.tar.gz/.tgz 文件。",
    tools: ["extract_server_zip"]
  },
  forge_server_setup: {
    name: "Forge 服务端安装能力",
    description: "运行当前服务端目录内的 Forge installer，生成 libraries 参数文件，并写入可启动配置。",
    tools: ["setup_forge_server"]
  }
} as const;

export type AgentCapabilityId = keyof typeof installableCapabilities;

export interface AgentToolContext {
  serverId: string;
  serverService: ServerService;
  fileService: FileService;
  processManager: ProcessManager;
  uploadService: UploadService;
  javaService: JavaService;
  signal?: AbortSignal;
  downloadProxyUrl?: () => string | undefined;
  getCurseForgeApiKey?: () => string;
  getModrinthApiKey?: () => string;
  toolConfigRequired?: (requirement: AgentToolConfigRequired) => void;
  installedCapabilities?: ReadonlySet<AgentCapabilityId>;
  installCapability?: (capability: AgentCapabilityId) => void;
  confirm?: (request: Omit<AgentConfirmationRequest, "id" | "serverId" | "createdAt">) => Promise<void>;
  progress?: (progress: AgentDownloadProgress) => void;
  workflowProgress?: (progress: AgentWorkflowProgress) => void;
  serverSlotStatus?: (status: ServerSlotStatus) => void;
  consoleLog?: (text: string, stream?: ConsoleLogEntry["stream"]) => void;
}

export interface AgentTool {
  definition: ChatToolDefinition;
  execute: (input: Record<string, unknown>) => Promise<string>;
}

export interface AgentToolInfo {
  name: string;
  description: string;
  category: string;
  controllable: false;
  configRequirements?: AgentToolConfigRequirement[];
}

export function objectSchema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

export async function requireConfirmation(ctx: AgentToolContext, request: { title: string; description: string; risk: "medium" | "high" }) {
  if (!ctx.confirm) return;
  await ctx.confirm(request);
}

export function stringInput(input: Record<string, unknown>, key: string, fallback = "") {
  const value = input[key];
  return typeof value === "string" ? value : fallback;
}

export function booleanInput(input: Record<string, unknown>, key: string, fallback = false) {
  const value = input[key];
  return typeof value === "boolean" ? value : fallback;
}

export function stringArrayInput(input: Record<string, unknown>, key: string, fallback: string[] = []) {
  const value = input[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : fallback;
}

export function safeDownloadName(url: string, fallback: string) {
  try {
    const name = path.basename(new URL(url).pathname).replace(/[<>:"/\\|?*]/g, "_");
    return name || fallback;
  } catch {
    return fallback;
  }
}

export function isAbortError(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || error.message === "Agent 操作已中断");
}
