import { createServer } from "node:http";
import { createProxyServer } from "httpxy";

const host = process.env.PROXY_HOST ?? process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PROXY_PORT ?? process.env.PORT ?? 3000);
const apiTarget = process.env.PROXY_API_TARGET ?? `http://127.0.0.1:${process.env.APP_PORT ?? 8787}`;
const webTarget = process.env.PROXY_WEB_TARGET ?? `http://127.0.0.1:${process.env.NUXT_PORT ?? process.env.NITRO_PORT ?? 3001}`;

const apiProxy = createProxyServer({ target: apiTarget, changeOrigin: true, xfwd: true, ws: true });
const webProxy = createProxyServer({ target: webTarget, changeOrigin: true, xfwd: true, ws: true });

function targetFor(url = "/") {
  const path = new URL(url, "http://proxy.local").pathname;
  return path === "/api" || path.startsWith("/api/") || path === "/ws" || path.startsWith("/ws/") || path === "/health" ? apiProxy : webProxy;
}

function onProxyError(error, label) {
  console.error(`[proxy] ${label} proxy error:`, error.message);
}

function sendProxyUnavailable(res, label) {
  if (res.destroyed || res.writableEnded) return;
  if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
  res.end(`${label} proxy unavailable`);
}

const server = createServer(async (req, res) => {
  const proxy = targetFor(req.url);
  const label = proxy === apiProxy ? "api" : "web";

  try {
    await proxy.web(req, res);
  } catch (error) {
    sendProxyUnavailable(res, label);
    onProxyError(error instanceof Error ? error : new Error(String(error)), label);
  }
});

server.on("upgrade", (req, socket, head) => {
  const proxy = targetFor(req.url);
  const label = proxy === apiProxy ? "api" : "web";

  proxy.ws(req, socket, {}, head).catch((error) => {
    socket.destroy();
    onProxyError(error instanceof Error ? error : new Error(String(error)), label);
  });
});

server.listen(port, host, () => {
  console.log(`[proxy] listening on http://${host}:${port}`);
  console.log(`[proxy] /api and /ws -> ${apiTarget}`);
  console.log(`[proxy] other requests -> ${webTarget}`);
});
