import path from "node:path";
import { createId } from "../../utils/id.js";
import type { AgentDownloadProgress } from "../../types.js";
import { booleanInput, isAbortError, objectSchema, requireConfirmation, safeDownloadName, stringInput, stringProperty, type AgentTool, type AgentToolContext, type AgentToolInfo } from "../toolKit.js";

export const downloadHttpsFileToServerToolInfo: AgentToolInfo = {
  name: "download_https_file_to_server",
  description: "从 HTTPS URL 下载文件到当前服务端目录，可选自动解压 zip。只能写入当前服务端沙箱目录。下载整合包服务端文件时使用。",
  category: "文件下载",
  controllable: false
};

export function createDownloadHttpsFileToServerTool(ctx: AgentToolContext): AgentTool {
  return {
    definition: {
      type: "function",
      function: {
        name: downloadHttpsFileToServerToolInfo.name,
        description: downloadHttpsFileToServerToolInfo.description,
        parameters: objectSchema({ url: stringProperty, destinationPath: stringProperty, extract: { type: "boolean" } }, ["url"])
      }
    },
    execute: async (input) => {
      const url = stringInput(input, "url");
      const destinationPath = stringInput(input, "destinationPath", safeDownloadName(url, "download.bin"));
      const extract = booleanInput(input, "extract");
      const downloadId = createId("download");
      const fileName = path.basename(destinationPath) || safeDownloadName(url, "download.bin");
      const emitProgress = (progress: Omit<AgentDownloadProgress, "id" | "url" | "fileName" | "destinationPath">) => {
        ctx.progress?.({ id: downloadId, url, fileName, destinationPath, ...progress });
      };
      await requireConfirmation(ctx, {
        title: "下载外部文件到服务端目录",
        description: `Agent 准备从 ${url} 下载到 ${destinationPath}${extract ? " 并解压" : ""}。`,
        risk: "high"
      });
      emitProgress({ loadedBytes: 0, totalBytes: null, percent: 0, status: "starting" });
      const proxyUrl = ctx.downloadProxyUrl?.();
      try {
        const savedPath = await ctx.fileService.downloadIntoServer(ctx.serverId, url, destinationPath, {
          signal: ctx.signal,
          proxyUrl,
          onProgress: (progress) => emitProgress({ ...progress, status: progress.percent >= 100 ? "completed" : "downloading" })
        });
        if (!extract) return `已下载到 ${savedPath}`;
        if (!savedPath.toLowerCase().endsWith(".zip")) return `已下载到 ${savedPath}，但文件不是 zip，未解压。`;
        const download = await ctx.fileService.resolveDownload(ctx.serverId, savedPath);
        const extractPath = path.dirname(savedPath) === "." ? "." : path.dirname(savedPath);
        await ctx.fileService.extractZipIntoServer(ctx.serverId, download.absolutePath, extractPath);
        return `已下载 ${savedPath} 并解压到 ${extractPath}`;
      } catch (error) {
        emitProgress({
          loadedBytes: 0,
          totalBytes: null,
          percent: 0,
          status: isAbortError(error) ? "cancelled" : "failed",
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
    }
  };
}
