import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { appConfig } from "../src/config.js";
import { registerErrorHandling } from "../src/http/errors.js";
import { generateAuthToken, registerAuthRoutes } from "../src/http/routes/auth.js";

test("connector-only backends reject panel sessions, query tokens and direct login, accepting only their node key", async (t) => {
  const previous = { requireConnector: appConfig.requireConnector, accessKey: appConfig.accessKey };
  Object.assign(appConfig, { requireConnector: true, accessKey: "dedicated-node-key" });
  const app = Fastify();
  t.after(async () => { await app.close(); Object.assign(appConfig, previous); });
  registerErrorHandling(app);
  registerAuthRoutes(app);
  app.get("/health", async () => ({ ok: true }));
  app.get("/api/test", async () => ({ ok: true }));
  const token = generateAuthToken(appConfig.secretKey);
  for (const headers of [{}, { cookie: `mcsa_token=${token}` }, { authorization: `Bearer ${token}` }, { "x-app-key": "wrong-key" }]) {
    assert.equal((await app.inject({ url: `/api/test?token=${token}`, headers })).statusCode, 401);
  }
  assert.equal((await app.inject({ url: "/api/test", headers: { "x-app-key": "dedicated-node-key" } })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: appConfig.password } })).statusCode, 404);
  assert.equal((await app.inject({ url: "/health?probe=true" })).statusCode, 200);
});
