import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { appConfig } from "../../config.js";

const COOKIE_NAME = "mcsa_token";
const TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function generateAuthToken(secret: string): string {
  const timestamp = Date.now().toString();
  const hmac = createHmac("sha256", secret).update(timestamp).digest("hex");
  return `${Buffer.from(timestamp).toString("base64url")}.${hmac}`;
}

export function verifyAuthToken(token: string, secret: string): boolean {
  try {
    const dot = token.indexOf(".");
    if (dot <= 0) return false;
    const tsB64 = token.slice(0, dot);
    const hmac = token.slice(dot + 1);
    const timestamp = Buffer.from(tsB64, "base64url").toString();
    const expected = createHmac("sha256", secret).update(timestamp).digest("hex");

    if (hmac.length !== expected.length) return false;
    if (!timingSafeEqual(Buffer.from(hmac, "hex"), Buffer.from(expected, "hex"))) return false;

    const age = Date.now() - Number(timestamp);
    if (Number.isNaN(age) || age < 0 || age > TOKEN_MAX_AGE_MS) return false;

    return true;
  } catch {
    return false;
  }
}

function getCookieValue(request: { headers: Record<string, string | undefined> }, name: string): string | undefined {
  const cookie = request.headers.cookie;
  if (!cookie) return undefined;
  const parts = cookie.split(";");
  for (const part of parts) {
    const [key, ...rest] = part.split("=");
    if (key?.trim() === name) return rest.join("=").trim();
  }
  return undefined;
}

export function registerAuthRoutes(app: FastifyInstance) {
  app.post("/api/auth/login", async (request, reply) => {
    if (!appConfig.password) {
      reply.status(403).send({ error: "未设置面板密码，无法登录" });
      return;
    }

    const body = request.body as { password?: string } | undefined;
    const input = body?.password ?? "";

    if (input !== appConfig.password) {
      reply.status(401).send({ error: "密码错误" });
      return;
    }

    const token = generateAuthToken(appConfig.secretKey);
    const maxAge = TOKEN_MAX_AGE_MS / 1000;
    reply.header("set-cookie", `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
    reply.send({ success: true, token });
  });

  app.get("/api/auth/verify", async (request, reply) => {
    const cookieToken = getCookieValue(request as never, COOKIE_NAME);
    if (cookieToken && verifyAuthToken(cookieToken, appConfig.secretKey)) {
      reply.send({ success: true });
      return;
    }

    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith("Bearer ") && verifyAuthToken(authHeader.slice(7), appConfig.secretKey)) {
      reply.send({ success: true });
      return;
    }

    reply.status(401).send({ error: "未登录或令牌已过期" });
  });

  app.post("/api/auth/logout", async (_request, reply) => {
    reply.header("set-cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    reply.send({ success: true });
  });
}
