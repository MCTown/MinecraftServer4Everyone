import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { createProxyServer } from "httpxy";

const host = process.env.PROXY_HOST ?? process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PROXY_PORT ?? process.env.PORT ?? 3000);
const apiTarget = process.env.PROXY_API_TARGET ?? `http://127.0.0.1:${process.env.APP_PORT ?? 8787}`;
const webTarget = process.env.PROXY_WEB_TARGET ?? `http://127.0.0.1:${process.env.NUXT_PORT ?? process.env.NITRO_PORT ?? 3001}`;
const appPassword = process.env.APP_PASSWORD ?? "ilovemct";
const secretKey = process.env.APP_SECRET_KEY ?? "dev-secret-change-me";

const apiProxy = createProxyServer({ target: apiTarget, changeOrigin: true, xfwd: true, ws: true });
const webProxy = createProxyServer({ target: webTarget, changeOrigin: true, xfwd: true, ws: true });

const AUTH_COOKIE_NAME = "mcsa_token";
const TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function verifyAuthToken(token) {
  try {
    const dot = token.indexOf(".");
    if (dot <= 0) return false;
    const tsB64 = token.slice(0, dot);
    const hmac = token.slice(dot + 1);
    const timestamp = Buffer.from(tsB64, "base64url").toString();
    const expected = createHmac("sha256", secretKey).update(timestamp).digest("hex");

    if (hmac.length !== expected.length) return false;
    if (!timingSafeEqual(Buffer.from(hmac, "hex"), Buffer.from(expected, "hex"))) return false;

    const age = Date.now() - Number(timestamp);
    if (Number.isNaN(age) || age < 0 || age > TOKEN_MAX_AGE_MS) return false;

    return true;
  } catch {
    return false;
  }
}

function getCookieValue(cookieHeader, name) {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.split("=");
    if (key?.trim() === name) return rest.join("=").trim();
  }
  return undefined;
}

function isAuthBypassPath(pathname) {
  return pathname.startsWith("/api/auth/")
    || pathname.startsWith("/_nuxt/")
    || pathname.startsWith("/__nuxt_devtools")
    || pathname === "/login"
    || pathname === "/login/"
    || pathname === "/health";
}

function isPasswordProtected() {
  return appPassword.length > 0;
}

function hasValidAuth(req) {
  const cookieToken = getCookieValue(req.headers.cookie, AUTH_COOKIE_NAME);
  if (cookieToken && verifyAuthToken(cookieToken)) return true;

  const url = new URL(req.url ?? "/", "http://proxy.local");
  const queryToken = url.searchParams.get("token");
  if (queryToken && verifyAuthToken(queryToken)) return true;

  return false;
}

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

function redirectToLogin(res) {
  res.writeHead(302, { location: "/login" });
  res.end();
}

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url ?? "/", "http://proxy.local").pathname;

  if (isPasswordProtected() && !isAuthBypassPath(pathname) && !hasValidAuth(req)) {
    redirectToLogin(res);
    return;
  }

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
  if (isPasswordProtected() && !hasValidAuth(req)) {
    socket.destroy();
    return;
  }

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
  if (isPasswordProtected()) {
    console.log(`[proxy] password protection enabled`);
  }
});
