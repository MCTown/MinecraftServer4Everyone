import assert from "node:assert/strict";
import test from "node:test";
import { cacheUsage } from "../src/agent/cacheUsage.js";

test("cache rate uses total input tokens, never fabricates gateway accounting", () => {
  assert.deepEqual(cacheUsage({ promptTokens: 100, completionTokens: 1, totalTokens: 101, cacheHitTokens: 90, cacheMissTokens: 10 }),
    { status: "available", hitTokens: 90, inputTokens: 100, rate: 0.9 });
  assert.equal(cacheUsage({ promptTokens: 100, completionTokens: 1, totalTokens: 101, cacheHitTokens: 0 }).status, "available");
  assert.equal(cacheUsage(null).status, "unavailable");
  assert.equal(cacheUsage({ promptTokens: 100, completionTokens: 1, totalTokens: 101 }).status, "unavailable");
  assert.equal(cacheUsage({ promptTokens: 216, completionTokens: 2, totalTokens: 218, cacheHitTokens: 35968 }).status, "inconsistent");
});
