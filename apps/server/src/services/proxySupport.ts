import { ProxyAgent } from "undici";

export function normalizeProxyUrl(proxyUrl?: string | null) {
  const trimmed = proxyUrl?.trim();
  if (!trimmed) return undefined;
  const parsed = new URL(trimmed);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("代理地址仅支持 HTTP 或 HTTPS");
  return parsed.href;
}

export function fetchDispatcher(proxyUrl?: string | null) {
  const normalized = normalizeProxyUrl(proxyUrl);
  return normalized ? new ProxyAgent(normalized) : undefined;
}

export function proxyEnv(proxyUrl?: string | null) {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) return process.env;
  return {
    ...process.env,
    HTTP_PROXY: normalized,
    HTTPS_PROXY: normalized,
    ALL_PROXY: normalized,
    http_proxy: normalized,
    https_proxy: normalized,
    all_proxy: normalized
  };
}

export function javaProxyArgs(proxyUrl?: string | null) {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) return [];

  const url = new URL(normalized);
  const host = url.hostname;
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const args = [
    `-Dhttp.proxyHost=${host}`,
    `-Dhttp.proxyPort=${port}`,
    `-Dhttps.proxyHost=${host}`,
    `-Dhttps.proxyPort=${port}`
  ];
  if (url.username) {
    args.push(`-Dhttp.proxyUser=${decodeURIComponent(url.username)}`);
    args.push(`-Dhttps.proxyUser=${decodeURIComponent(url.username)}`);
  }
  if (url.password) {
    args.push(`-Dhttp.proxyPassword=${decodeURIComponent(url.password)}`);
    args.push(`-Dhttps.proxyPassword=${decodeURIComponent(url.password)}`);
  }
  return args;
}

export function isJavaExecutable(executable: string) {
  return /(^|[\\/])java(?:\.exe)?$/i.test(executable) || /^java(?:\.exe)?$/i.test(executable);
}
