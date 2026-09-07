import { fetch } from "undici";
import { fetchDispatcher } from "../../services/proxySupport.js";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProviderContext {
  signal?: AbortSignal;
  proxyUrl?: () => string | undefined;
  braveApiKey?: string;
  tavilyApiKey?: string;
  searxngBaseUrl?: string;
}

interface SearchProvider {
  name: string;
  run: (query: string, maxResults: number) => Promise<WebSearchResult[]>;
}

const requestUserAgent = "MinecraftServerAgent/0.1";

function cleanText(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function decodeXmlEntities(value: string) {
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

function stripXmlTags(value: string) {
  return decodeXmlEntities(value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]*>/g, " "));
}

function xmlField(item: string, name: string) {
  const match = item.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i"));
  return match?.[1] ? cleanText(stripXmlTags(match[1])) : "";
}

function parseRssItems(xml: string, maxResults: number): WebSearchResult[] {
  return (xml.match(/<item>[\s\S]*?<\/item>/gi) ?? [])
    .slice(0, maxResults)
    .map((item) => ({
      title: xmlField(item, "title"),
      url: xmlField(item, "link"),
      snippet: xmlField(item, "description")
    }))
    .filter((item) => item.title && item.url);
}

function decodeRedirectUrl(href: string) {
  try {
    const url = new URL(href, "https://duckduckgo.com");
    const target = url.searchParams.get("uddg");
    return target ? decodeURIComponent(target) : url.toString();
  } catch {
    return "";
  }
}

function parseDuckDuckGoLite(html: string, maxResults: number): WebSearchResult[] {
  const links = [...html.matchAll(/<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  const snippets = [...html.matchAll(/<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi)];
  const results: WebSearchResult[] = [];
  for (const [index, link] of links.entries()) {
    const url = decodeRedirectUrl(link[1] ?? "");
    const title = cleanText(stripXmlTags(link[2] ?? ""));
    if (!url || !title) continue;
    results.push({ title, url, snippet: cleanText(snippets[index]?.[1] ? stripXmlTags(snippets[index][1]) : "") });
    if (results.length >= maxResults) break;
  }
  return results;
}

async function fetchText(url: string, init: { headers?: Record<string, string>; method?: string; body?: string; signal?: AbortSignal; proxyUrl?: string }) {
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: { "user-agent": requestUserAgent, ...init.headers },
    body: init.body,
    signal: init.signal,
    dispatcher: fetchDispatcher(init.proxyUrl)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 200)}`);
  return text;
}

function braveProvider(apiKey: string, ctx: SearchProviderContext): SearchProvider {
  return {
    name: "brave",
    run: async (query, maxResults) => {
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(maxResults));
      const text = await fetchText(url.toString(), {
        headers: { accept: "application/json", "x-subscription-token": apiKey },
        signal: ctx.signal,
        proxyUrl: ctx.proxyUrl?.()
      });
      const data = JSON.parse(text) as { web?: { results?: Array<{ title?: unknown; url?: unknown; description?: unknown }> } };
      return (data.web?.results ?? [])
        .map((item) => ({ title: cleanText(item.title), url: cleanText(item.url), snippet: cleanText(item.description) }))
        .filter((item) => item.title && item.url)
        .slice(0, maxResults);
    }
  };
}

function tavilyProvider(apiKey: string, ctx: SearchProviderContext): SearchProvider {
  return {
    name: "tavily",
    run: async (query, maxResults) => {
      const text = await fetchText("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ query, max_results: maxResults }),
        signal: ctx.signal,
        proxyUrl: ctx.proxyUrl?.()
      });
      const data = JSON.parse(text) as { results?: Array<{ title?: unknown; url?: unknown; content?: unknown }> };
      return (data.results ?? [])
        .map((item) => ({ title: cleanText(item.title), url: cleanText(item.url), snippet: cleanText(item.content) }))
        .filter((item) => item.title && item.url)
        .slice(0, maxResults);
    }
  };
}

function searxngProvider(baseUrl: string, ctx: SearchProviderContext): SearchProvider {
  return {
    name: "searxng",
    run: async (query, maxResults) => {
      const url = new URL("/search", baseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("SearXNG 地址仅支持 HTTP 或 HTTPS");
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      const text = await fetchText(url.toString(), {
        headers: { accept: "application/json" },
        signal: ctx.signal,
        proxyUrl: ctx.proxyUrl?.()
      });
      const data = JSON.parse(text) as { results?: Array<{ title?: unknown; url?: unknown; content?: unknown }> };
      return (data.results ?? [])
        .map((item) => ({ title: cleanText(item.title), url: cleanText(item.url), snippet: cleanText(item.content) }))
        .filter((item) => item.title && item.url)
        .slice(0, maxResults);
    }
  };
}

function duckDuckGoProvider(ctx: SearchProviderContext): SearchProvider {
  return {
    name: "duckduckgo",
    run: async (query, maxResults) => {
      const url = new URL("https://lite.duckduckgo.com/lite/");
      url.searchParams.set("q", query);
      const html = await fetchText(url.toString(), { signal: ctx.signal, proxyUrl: ctx.proxyUrl?.() });
      return parseDuckDuckGoLite(html, maxResults);
    }
  };
}

function bingRssProvider(ctx: SearchProviderContext): SearchProvider {
  return {
    name: "bing-rss",
    run: async (query, maxResults) => {
      const url = new URL("https://www.bing.com/search");
      url.searchParams.set("format", "rss");
      url.searchParams.set("q", query);
      const xml = await fetchText(url.toString(), {
        headers: { accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8" },
        signal: ctx.signal,
        proxyUrl: ctx.proxyUrl?.()
      });
      return parseRssItems(xml, maxResults);
    }
  };
}

export function buildSearchProviderChain(ctx: SearchProviderContext): SearchProvider[] {
  const providers: SearchProvider[] = [];
  if (ctx.braveApiKey?.trim()) providers.push(braveProvider(ctx.braveApiKey.trim(), ctx));
  if (ctx.tavilyApiKey?.trim()) providers.push(tavilyProvider(ctx.tavilyApiKey.trim(), ctx));
  const searxngBase = ctx.searxngBaseUrl?.trim();
  if (searxngBase) providers.push(searxngProvider(searxngBase, ctx));
  providers.push(duckDuckGoProvider(ctx));
  providers.push(bingRssProvider(ctx));
  return providers;
}

export interface WebSearchChainResult {
  provider: string;
  attemptedProviders: string[];
  errors: Array<{ provider: string; message: string }>;
  results: WebSearchResult[];
}

export async function runWebSearchChain(ctx: SearchProviderContext, query: string, maxResults: number): Promise<WebSearchChainResult> {
  const chain = buildSearchProviderChain(ctx);
  const errors: Array<{ provider: string; message: string }> = [];
  for (const provider of chain) {
    if (ctx.signal?.aborted) break;
    try {
      const results = await provider.run(query, maxResults);
      if (results.length > 0) {
        return { provider: provider.name, attemptedProviders: [provider.name], errors, results };
      }
      errors.push({ provider: provider.name, message: "无结果" });
    } catch (error) {
      errors.push({ provider: provider.name, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { provider: "", attemptedProviders: [], errors, results: [] };
}
