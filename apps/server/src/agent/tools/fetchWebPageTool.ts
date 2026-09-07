import { fetch } from "undici";
import { fetchDispatcher } from "../../services/proxySupport.js";
import { objectSchema, stringInput, stringProperty, type AgentTool, type AgentToolContext, type AgentToolInfo } from "../toolKit.js";

export const fetchWebPageToolInfo: AgentToolInfo = {
  name: "fetch_web_page",
  description: "读取一个 HTTPS 网页的正文文本：抓取页面、剥离脚本/导航等标记、保留标题和正文，返回纯文本。用于跟进 web_search 返回的链接阅读具体内容。只读 GET，不执行 JavaScript，不能访问需要登录的页面。",
  category: "网络检索",
  controllable: false
};

const defaultMaxChars = 20000;
const maxResponseBytes = 3 * 1024 * 1024;
const requestTimeoutMs = 30000;

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(hex, 16))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(dec, 10))
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function safeCodePoint(code: string, radix: number) {
  const point = parseInt(code, radix);
  if (!Number.isFinite(point) || point < 0x20 || point > 0x10ffff) return "";
  try {
    return String.fromCodePoint(point);
  } catch {
    return "";
  }
}

const blockTags = new Set([
  "address", "article", "aside", "blockquote", "br", "center", "dd", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "tbody", "td",
  "tfoot", "th", "thead", "tr", "ul"
]);

function extractTitle(html: string) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return "";
  return decodeHtmlEntities(match[1]?.replace(/\s+/g, " ").trim() ?? "");
}

function htmlToText(html: string) {
  const withoutHidden = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|iframe|head)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  let text = "";
  let cursor = 0;
  const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g;
  for (const match of withoutHidden.matchAll(tagPattern)) {
    text += decodeHtmlEntities(withoutHidden.slice(cursor, match.index));
    cursor = (match.index ?? 0) + match[0].length;
    const tagName = match[1]?.toLowerCase() ?? "";
    if (!blockTags.has(tagName)) continue;
    if (tagName === "li") {
      text += "\n- ";
      continue;
    }
    text += "\n";
  }
  text += decodeHtmlEntities(withoutHidden.slice(cursor));
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateMiddle(text: string, maxChars: number) {
  if (text.length <= maxChars) return text;
  const marker = `\n\n...（页面共 ${text.length} 字符，已截断中间内容；如需其他部分请用更具体的关键词重新搜索或抓取子页面）...\n\n`;
  const head = Math.max(0, Math.floor((maxChars - marker.length) / 2));
  const tail = Math.max(0, maxChars - marker.length - head);
  return `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ""}`;
}

export function createFetchWebPageTool(ctx: AgentToolContext): AgentTool {
  return {
    definition: {
      type: "function",
      function: {
        name: fetchWebPageToolInfo.name,
        description: fetchWebPageToolInfo.description,
        parameters: objectSchema({
          url: stringProperty,
          maxChars: { type: "number", minimum: 500, maximum: 60000 }
        }, ["url"])
      }
    },
    execute: async (input) => {
      const rawUrl = stringInput(input, "url").trim();
      if (!rawUrl) throw new Error("url 不能为空");
      const url = new URL(rawUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("仅支持 HTTP 或 HTTPS 链接");
      }
      const requestedMaxChars = typeof input.maxChars === "number" && Number.isFinite(input.maxChars)
        ? Math.floor(input.maxChars)
        : defaultMaxChars;
      const maxChars = Math.max(500, Math.min(60000, requestedMaxChars));

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      timeout.unref();
      const onOuterAbort = () => controller.abort();
      ctx.signal?.addEventListener("abort", onOuterAbort, { once: true });
      try {
        const response = await fetch(url.toString(), {
          headers: { "user-agent": "MinecraftServerAgent/0.1", accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" },
          signal: controller.signal,
          redirect: "follow",
          dispatcher: fetchDispatcher(ctx.downloadProxyUrl?.())
        });
        const contentType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() || "";
        const contentLength = Number(response.headers.get("content-length") ?? 0);
        if (contentLength > maxResponseBytes) {
          throw new Error(`响应过大（${Math.round(contentLength / 1024 / 1024)}MB），超过 3MB 上限`);
        }
        const bodyText = await response.text();
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}: ${bodyText.slice(0, 200)}`);
        }
        if (bodyText.length > maxResponseBytes) {
          throw new Error("响应过大，超过 3MB 上限");
        }

        let content: string;
        if (contentType === "text/html" || contentType === "application/xhtml+xml") {
          content = htmlToText(bodyText);
        } else if (contentType.startsWith("text/") || contentType === "application/json" || contentType === "application/xml" || contentType === "application/rss+xml") {
          content = bodyText.trim();
        } else {
          throw new Error(`不支持的内容类型：${contentType || "未知"}。只能读取网页/文本/JSON 内容。`);
        }
        if (!content) {
          throw new Error("页面没有可提取的正文（可能由 JavaScript 渲染或需要登录）。");
        }
        const title = contentType.includes("html") ? extractTitle(bodyText) : "";
        const headerLines = [
          url.toString(),
          response.url !== url.toString() ? `最终地址：${response.url}` : "",
          `content-type：${contentType}`,
          title ? `标题：${title}` : ""
        ].filter(Boolean);
        return `${headerLines.join("\n")}\n\n${truncateMiddle(content, maxChars)}`;
      } catch (error) {
        if (controller.signal.aborted && !ctx.signal?.aborted && !(error instanceof Error && error.name === "AbortError")) {
          throw new Error(`抓取超时（${requestTimeoutMs / 1000} 秒），可稍后重试或改用其他来源。`);
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        ctx.signal?.removeEventListener("abort", onOuterAbort);
      }
    }
  };
}
