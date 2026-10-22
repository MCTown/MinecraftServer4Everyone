import { test } from "node:test";
import assert from "node:assert/strict";
import { observeWorkflow, executionTimings } from "./benchmark-timing.mjs";

test("workflow timing is stable across polls and ignores future nodes", () => {
  const timings = new Map();
  const turn = { createdAt: "2026-10-21T00:00:00Z", workflowProgress: { turn: { stepIds: ["a"] }, steps: [
    { id: "a", label: "A", status: "running" }, { id: "b", status: "pending" }
  ] } };
  assert.equal(observeWorkflow(timings, turn, "2026-10-21T00:00:05Z")[0].durationMs, 5000);
  turn.workflowProgress.steps[0].status = "completed";
  observeWorkflow(timings, turn, "2026-10-21T00:00:07Z");
  assert.equal(observeWorkflow(timings, turn, "2026-10-21T00:00:09Z")[0].durationMs, 7000);
  assert.equal(timings.size, 1);
});

test("persisted step and tool durations are separate, not summed", () => {
  const result = executionTimings([{ id: "turn", status: "completed", createdAt: "2026-10-21T00:00:00Z", updatedAt: "2026-10-21T00:00:10Z",
    steps: [{ id: "step", startedAt: "2026-10-21T00:00:01Z", finishedAt: "2026-10-21T00:00:09Z" }],
    toolCalls: [{ id: "tool", startedAt: "2026-10-21T00:00:04Z", finishedAt: "2026-10-21T00:00:09Z" }] }]);
  assert.equal(result[0].durationMs, 10000);
  assert.equal(result[0].steps[0].durationMs, 8000);
  assert.equal(result[0].toolCalls[0].durationMs, 5000);
});
