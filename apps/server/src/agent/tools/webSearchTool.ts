import { fetch } from "undici";
import { fetchDispatcher } from "../../services/proxySupport.js";
import { objectSchema, stringInput, stringProperty, type AgentTool, type AgentToolContext, type AgentToolInfo } from "../toolKit.js";

const maxQueryLength = 500;
const maxResultCount = 10;

export const webSearchToolInfo: AgentToolInfo = {
  name: "web_search",
  description: "搜索公开网页，返回标题、链接和摘要，用于查询 Minecraft 服务端、模组与官方文档的最新信息。",
  category: "网络检索",
  controllable: false
};

function decodeXml(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function xmlField(item: string, name: string) {
  const match = item.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i"));
  return match?.[1] ? decodeXml(match[1]) : "";
}

function parseBingRss(xml: string, maxResults: number) {
  const items = xml.match(/<item>[\s\S]*?<\/item>/gi) ?? [];
  return items.slice(0, maxResults).map((item) => ({
    title: xmlField(item, "title"),
    url: xmlField(item, "link"),
    snippet: xmlField(item, "description")
  })).filter((item) => item.title && item.url);
}

export function createWebSearchTool(ctx: AgentToolContext): AgentTool {
  return {
    definition: {
      type: "function",
      function: {
        name: "web_search",
        description: "搜索公开网页，返回标题、URL 和摘要。用于查询 Minecraft 服务端、模组、兼容性和官方文档等最新公开信息。搜索结果仅供参考，下载前仍需使用 Modrinth、CurseForge 或用户提供的可信链接确认来源。",
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
      const url = new URL("https://www.bing.com/search");
      url.searchParams.set("format", "rss");
      url.searchParams.set("q", query);

      const response = await fetch(url, {
        headers: {
          accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8",
          "user-agent": "MinecraftServerAgent/0.1"
        },
        signal: ctx.signal,
        dispatcher: fetchDispatcher(ctx.downloadProxyUrl?.())
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`网页搜索请求失败：HTTP ${response.status} ${response.statusText}`);

      const results = parseBingRss(body, maxResults);
      if (results.length === 0) return `未找到与“${query}”相关的公开网页结果。`;
      return JSON.stringify({ query, results }, null, 2);
    }
  };
}
