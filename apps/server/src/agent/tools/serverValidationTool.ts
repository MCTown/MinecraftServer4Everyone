import { inspectServerValidation } from "../../services/serverValidation.js";
import { objectSchema, stringArrayInput, type AgentTool, type AgentToolContext, type AgentToolInfo } from "../toolKit.js";

export const serverValidationToolInfo: AgentToolInfo = {
  name: "inspect_current_server_validation",
  description: "一次只读汇总当前实例本次启动的运行、插件、日志告警、进程归属、监听和内存证据；日志异常不等于游戏故障。",
  category: "服务端验收", controllable: false
};

export function createServerValidationTool(ctx: AgentToolContext): AgentTool {
  return {
    definition: { type: "function", function: {
      name: serverValidationToolInfo.name,
      description: `${serverValidationToolInfo.description} 在 wait_for_server_startup 后优先调用，替代多轮 grep/pgrep。各项 passed/failed/unknown；unknown 只补查缺失项。独立报告游戏运行、插件与日志告警，不能仅凭 ERROR/FATAL 禁模组或重启。无文件写入、不运行插件代码、不发游戏命令。`,
      parameters: objectSchema({ expectedPluginIds: { type: "array", items: { type: "string" }, maxItems: 200,
        description: "可选，已知必须加载的插件 ID；未提供则从 config.yml 的插件目录读取元数据，不用文件名猜 ID。提供时仅验证指定范围。" } })
    } },
    execute: async (input) => {
      if (input.expectedPluginIds !== undefined && (!Array.isArray(input.expectedPluginIds) || !input.expectedPluginIds.every((id) => typeof id === "string"))) throw new Error("expectedPluginIds 必须是插件 ID 字符串数组");
      const expectedPluginIds = input.expectedPluginIds === undefined ? undefined : stringArrayInput(input, "expectedPluginIds");
      if (expectedPluginIds && (expectedPluginIds.length > 200 || !expectedPluginIds.every((id) => /^[a-z][a-z0-9_]{0,63}$/.test(id)))) throw new Error("expectedPluginIds 需要合法的插件 ID，最多 200 个");
      const result = await inspectServerValidation(ctx.serverService, ctx.processManager, ctx.getServerId(), { expectedPluginIds, signal: ctx.signal });
      const full = JSON.stringify(result);
      if (full.length <= 11000) return full;
      // AgentService has a general 12k result cap. Preserve parseable JSON and
      // every check status rather than letting that cap cut through the evidence.
      const compact = { ...result, outputTruncated: true,
        checks: Object.fromEntries(Object.entries(result.checks).map(([key, value]) => [key, { ...value, detail: value.detail?.slice(0, 300),
          evidence: JSON.stringify(value.evidence).length > 450
            ? { truncated: true, preview: JSON.stringify(value.evidence).slice(0, 400), sourceCursor: result.cursor }
            : value.evidence }])),
        logAlerts: result.logAlerts ? { ...result.logAlerts, samples: result.logAlerts.samples.slice(-3).map((item) => ({ ...item, text: item.text.slice(0, 300) })), excerpt: result.logAlerts.excerpt.slice(-1000), truncated: true } : null };
      const encoded = JSON.stringify(compact);
      if (encoded.length <= 11000) return encoded;
      return JSON.stringify({ ...compact,
        checks: Object.fromEntries(Object.entries(result.checks).map(([key, value]) => [key, {
          status: value.status, detail: value.detail?.slice(0, 180), evidence: { truncated: true, sourceCursor: result.cursor }
        }])), logAlerts: result.logAlerts ? { count: result.logAlerts.count, truncated: true, interpretation: result.logAlerts.interpretation } : null });
    }
  };
}
