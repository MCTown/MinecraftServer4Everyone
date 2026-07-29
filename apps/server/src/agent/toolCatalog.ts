import type { AgentToolSettings } from "../types.js";
import type { AgentToolInfo } from "./toolKit.js";
import { downloadHttpsFileToServerToolInfo } from "./tools/downloadHttpsFileTool.js";
import { installJavaVersionToolInfo } from "./tools/javaDownloadTool.js";
import { configureBuiltinPythonToolInfo, installMcdrPluginDependenciesToolInfo } from "./tools/pythonRuntimeTool.js";
import { webSearchToolInfo } from "./tools/webSearchTool.js";
import { deployMrpackServerToolInfo, inspectMrpackServerToolInfo } from "./tools/mrpackDeploymentTool.js";
import { disableClientOnlyServerModsToolInfo, disableServerModsToolInfo, inspectClientOnlyServerModsToolInfo } from "./tools/clientOnlyModsTool.js";

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

export function materializeCurseForgeManifestPackToolInfo(settings?: AgentToolSettings): AgentToolInfo {
  return {
    name: "materialize_curseforge_manifest_pack_from_server_slot",
    description: "将服务端槽位中的 CurseForge manifest.json 清单包还原为 server/mods 模组与 overrides 配置；不会安装 Loader 或启动服务端。",
    category: "整合包部署",
    controllable: false,
    configRequirements: [
      {
        key: "curseForgeApiKey",
        label: "CurseForge API Key",
        required: true,
        configured: settings?.curseForgeApiKeyConfigured ?? false,
        helpUrl: "https://console.curseforge.com/?#/api-keys",
        secret: true
      }
    ]
  };
}

export function listAgentToolInfos(settings?: AgentToolSettings) {
  return [
    webSearchToolInfo,
    installJavaVersionToolInfo,
    configureBuiltinPythonToolInfo,
    installMcdrPluginDependenciesToolInfo,
    downloadHttpsFileToServerToolInfo,
    inspectMrpackServerToolInfo,
    deployMrpackServerToolInfo,
    inspectClientOnlyServerModsToolInfo,
    disableClientOnlyServerModsToolInfo,
    disableServerModsToolInfo,
    downloadModToServerModsToolInfo(settings),
    materializeCurseForgeManifestPackToolInfo(settings)
  ];
}
