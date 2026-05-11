import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { appConfig } from "../config.js";

export function registerErrorHandling(app: FastifyInstance) {
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
    const statusCode = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    reply.status(statusCode).send({ error: error.message || "Internal server error" });
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!appConfig.accessKey || request.url === "/health") return;
    if (request.headers["x-app-key"] !== appConfig.accessKey) {
      reply.status(401).send({ error: "Unauthorized" });
    }
  });
}
