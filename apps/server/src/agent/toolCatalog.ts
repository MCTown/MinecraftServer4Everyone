import { downloadHttpsFileToServerToolInfo } from "./tools/downloadHttpsFileTool.js";
import { installJavaVersionToolInfo } from "./tools/javaDownloadTool.js";

export function listAgentToolInfos() {
  return [installJavaVersionToolInfo, downloadHttpsFileToServerToolInfo];
}
