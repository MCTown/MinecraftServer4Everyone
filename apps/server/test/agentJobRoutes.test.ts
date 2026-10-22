import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { registerAgentRoutes } from "../src/http/routes/agent.js";
import { registerGlobalAgentRoutes } from "../src/http/routes/globalAgent.js";
import type { RouteServices } from "../src/http/types.js";

test("instance/global job and inbox routes bind scope, validate cursors and preserve admission options", async (t) => {
  const calls: unknown[][] = [];
  const service = new Proxy({}, { get: (_target, method: string) => (...args: unknown[]) => { calls.push([method, ...args]); return { ok: true }; } });
  const app = Fastify(); t.after(() => app.close());
  const services = { agentService: service, serverService: { requireServer: async () => ({}) } } as unknown as RouteServices;
  registerAgentRoutes(app, services); registerGlobalAgentRoutes(app, services);
  for (const [base, scope] of [["/api/agent", "global"], ["/api/servers/instance/agent", "instance"]]) {
    assert.equal((await app.inject({ method: "GET", url: `${base}/tools/jobs/job/output?cursor=42` })).statusCode, 200);
    assert.deepEqual(calls.at(-1), ["getToolOutput", scope, "job", 42]);
    assert.equal((await app.inject({ method: "DELETE", url: `${base}/tools/jobs/job` })).statusCode, 200);
    assert.deepEqual(calls.at(-1), ["cancelToolJob", scope, "job"]);
    await app.inject({ method: "GET", url: `${base}/inbox/events?after=7` });
    assert.deepEqual(calls.at(-1), ["listInboxEvents", scope, 7]);
    await app.inject({ method: "POST", url: `${base}/inbox`, payload: { id: "stable-id", text: "task", kind: "user", delivery: "queue", resume: false } });
    assert.deepEqual(calls.at(-1), ["steer", scope, "task", "queue", "stable-id", "user", false]);
    const count = calls.length;
    assert.notEqual((await app.inject({ method: "GET", url: `${base}/tools/jobs/job/output?cursor=-1` })).statusCode, 200);
    assert.equal(calls.length, count);
    assert.equal((await app.inject({ method: "POST", url: `${base}/tools/output/prune`, payload: { before: "2026-10-01T00:00:00Z" } })).statusCode, 200);
    assert.deepEqual(calls.at(-1), ["pruneToolOutput", scope, "2026-10-01T00:00:00Z"]);
  }
});
