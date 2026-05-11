import { appConfig } from "../../config.js";
import { objectSchema, requireConfirmation, stringInput, stringProperty, type AgentTool, type AgentToolContext, type AgentToolInfo } from "../toolKit.js";

export const installJavaVersionToolInfo: AgentToolInfo = {
  name: "install_java_version",
  description: "下载安装到 workspace/jdks 的 Java 版本，并保存到当前服务端配置。仅安装应用工作区内 Java，不使用系统 Java。",
  category: "Java 下载",
  controllable: false
};

export function createInstallJavaVersionTool(ctx: AgentToolContext): AgentTool {
  return {
    definition: {
      type: "function",
      function: {
        name: installJavaVersionToolInfo.name,
        description: installJavaVersionToolInfo.description,
        parameters: objectSchema({ version: stringProperty }, ["version"])
      }
    },
    execute: async (input) => {
      const version = stringInput(input, "version");
      await requireConfirmation(ctx, {
        title: `安装 Java ${version}`,
        description: `Agent 准备下载并安装 Java ${version} 到应用工作区 ${appConfig.jdksDir}，然后写入当前服务端配置。`,
        risk: "high"
      });
      const result = await ctx.javaService.installVersion(version);
      await ctx.serverService.updateServer(ctx.serverId, { javaPath: result.path, javaVersion: version });
      return JSON.stringify(result, null, 2);
    }
  };
}
