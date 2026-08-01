import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { appConfig } from "../config.js";
import { verifyAuthToken } from "./routes/auth.js";

const AUTH_COOKIE_NAME = "mcsa_token";

function getCookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.split("=");
    if (key?.trim() === name) return rest.join("=").trim();
  }
  return undefined;
}

export function registerErrorHandling(app: FastifyInstance) {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const statusCode = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (statusCode >= 500) {
      const params = request.params as { id?: string };
      request.log.error({ err: error, statusCode, serverId: params.id }, "request failed");
    }
    reply.status(statusCode).send({ error: error.message || "Internal server error" });
  });

  app.addHook("onRequest", async (request, reply) => {
    const url = request.url;

    if (url === "/health") return;

    if (url.startsWith("/api/auth/")) return;

    if (appConfig.accessKey && request.headers["x-app-key"] === appConfig.accessKey) return;

    if (appConfig.password) {
      const cookieToken = getCookieValue(request.headers.cookie, AUTH_COOKIE_NAME);
      if (cookieToken && verifyAuthToken(cookieToken, appConfig.secretKey)) return;

      const authHeader = request.headers.authorization;
      if (authHeader?.startsWith("Bearer ")) {
        const headerToken = authHeader.slice(7);
        if (verifyAuthToken(headerToken, appConfig.secretKey)) return;
      }

      const queryToken = (request.query as Record<string, string | undefined>).token;
      if (queryToken && verifyAuthToken(queryToken, appConfig.secretKey)) return;

      reply.status(401).send({ error: "Unauthorized" });
      return;
    }
  });
}
