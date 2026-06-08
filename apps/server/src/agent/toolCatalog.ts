import type { AgentToolSettings } from "../types.js";
import type { AgentToolInfo } from "./toolKit.js";
import { downloadHttpsFileToServerToolInfo } from "./tools/downloadHttpsFileTool.js";
import { installJavaVersionToolInfo } from "./tools/javaDownloadTool.js";
import { configureBuiltinPythonToolInfo } from "./tools/pythonRuntimeTool.js";

export function downloadModToServerModsToolInfo(settings?: AgentToolSettings): AgentToolInfo {
  return {
    name: "download_mod_to_server_mods",
    description: "从 Modrinth 或 CurseForge 官方 API 下载 .jar 模组到当前服务端的 server/mods/ 目录。",
    category: "模组下载",
    controllable: false,
    configRequirements: [
      {
        key: "curseForgeApiKey",
        label: "CurseForge API Key",
        required: true,
        configured: settings?.curseForgeApiKeyConfigured ?? false,
        helpUrl: "https://console.curseforge.com/?#/api-keys",
        secret: true
      },
      {
        key: "modrinthApiKey",
        label: "Modrinth Personal Access Token",
        required: false,
        configured: settings?.modrinthApiKeyConfigured ?? false,
        helpUrl: "https://modrinth.com/settings/pats",
        secret: true
      }
    ]
  };
}

export function listAgentToolInfos(settings?: AgentToolSettings) {
  return [installJavaVersionToolInfo, configureBuiltinPythonToolInfo, downloadHttpsFileToServerToolInfo, downloadModToServerModsToolInfo(settings)];
}
