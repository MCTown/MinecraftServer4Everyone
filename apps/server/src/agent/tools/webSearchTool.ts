import { runWebSearchChain } from "./searchProviders.js";
import { objectSchema, stringInput, stringProperty, type AgentTool, type AgentToolContext, type AgentToolInfo } from "../toolKit.js";

const maxQueryLength = 500;
const maxResultCount = 10;

export function webSearchToolInfo(settings?: { braveConfigured: boolean; tavilyConfigured: boolean }): AgentToolInfo {
  return {
    name: "web_search",
    description: "搜索公开网页，返回标题、URL 和摘要。后端按配置自动选择：Brave Search / Tavily / 自建 SearXNG，未配置时使用免 Key 抓取（DuckDuckGo → Bing RSS）。用于查询 Minecraft 服务端、模组、兼容性和官方文档等最新公开信息。需要阅读具体页面时，用返回的 URL 调用 fetch_web_page。",
    category: "网络检索",
    controllable: false,
    configRequirements: [
      {
        key: "braveSearchApiKey",
        label: "Brave Search API Key",
        required: false,
        configured: settings?.braveConfigured ?? false,
        helpUrl: "https://api-dashboard.search.brave.com/app/keys",
        secret: true
      },
      {
        key: "tavilyApiKey",
        label: "Tavily API Key",
        required: false,
        configured: settings?.tavilyConfigured ?? false,
        helpUrl: "https://app.tavily.com/home",
        secret: true
      }
    ]
  };
}

export function createWebSearchTool(ctx: AgentToolContext): AgentTool {
  const info = webSearchToolInfo({
    braveConfigured: Boolean(ctx.getBraveSearchApiKey?.() || ""),
    tavilyConfigured: Boolean(ctx.getTavilyApiKey?.() || "")
  });
  return {
    definition: {
      type: "function",
      function: {
        name: info.name,
        description: info.description,
        parameters: objectSchema({
          query: stringProperty,
          maxResults: { type: "number", minimum: 1, maximum: maxResultCount }
        }, ["query"])
      }
    },
    execute: async (input) => {
      const query = stringInput(input, "query").trim();
      if (!query) throw new Error("搜索关键词不能为空");
      if (query.length > maxQueryLength) throw new Error(`搜索关键词不能超过 ${maxQueryLength} 个字符`);

      const requestedResults = typeof input.maxResults === "number" ? Math.floor(input.maxResults) : 5;
      const maxResults = Math.max(1, Math.min(maxResultCount, requestedResults));
      const chainResult = await runWebSearchChain({
        signal: ctx.signal,
        proxyUrl: ctx.downloadProxyUrl,
        braveApiKey: ctx.getBraveSearchApiKey?.(),
        tavilyApiKey: ctx.getTavilyApiKey?.(),
        searxngBaseUrl: ctx.getSearxngBaseUrl?.()
      }, query, maxResults);

      if (chainResult.results.length === 0) {
        const errorDetail = chainResult.errors.map((item) => `${item.provider}: ${item.message}`).join("；");
        throw new Error(`所有搜索后端均未返回结果${errorDetail ? `（${errorDetail}）` : ""}。可更换关键词重试，或改用 Modrinth/CurseForge 官方 API 工具。`);
      }
      return JSON.stringify({
        query,
        provider: chainResult.provider,
        resultCount: chainResult.results.length,
        hint: "以上为搜索摘要；如需页面完整内容，请用 fetch_web_page 抓取对应 URL。",
        results: chainResult.results
      }, null, 2);
    }
  };
}
