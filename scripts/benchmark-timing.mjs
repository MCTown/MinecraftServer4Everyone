export function durationMs(start, end) {
  return Math.max(0, Date.parse(end) - Date.parse(start));
}

/** Workflow timestamps are polling observations; execution/tool timestamps are persisted. */
export function observeWorkflow(timings, execution, now = new Date().toISOString()) {
  const active = new Set(execution.workflowProgress?.turn?.stepIds ?? []);
  for (const step of execution.workflowProgress?.steps ?? []) {
    if (!active.has(step.id)) continue;
    let record = timings.get(step.id);
    if (!record && step.status !== "pending") {
      record = { id: step.id, label: step.label, startedAt: execution.createdAt, status: step.status, timestampSource: "poll_observation" };
      timings.set(step.id, record);
    }
    if (!record) continue;
    record.status = step.status;
    if (["completed", "failed", "cancelled"].includes(step.status) && !record.finishedAt) record.finishedAt = now;
    record.durationMs = durationMs(record.startedAt, record.finishedAt ?? now);
  }
  return [...timings.values()];
}

export function executionTimings(executions, now = new Date().toISOString()) {
  return executions.map((turn) => ({
    id: turn.id, status: turn.status, startedAt: turn.createdAt,
    durationMs: durationMs(turn.createdAt, ["completed", "failed", "cancelled", "interrupted"].includes(turn.status) ? turn.updatedAt : now),
    steps: (turn.steps ?? []).map((step) => ({ id: step.id, index: step.index, status: step.status,
      startedAt: step.startedAt, finishedAt: step.finishedAt, durationMs: durationMs(step.startedAt, step.finishedAt ?? now) })),
    toolCalls: (turn.toolCalls ?? []).map((call) => ({ id: call.id, name: call.name, status: call.status,
      startedAt: call.startedAt, finishedAt: call.finishedAt, durationMs: durationMs(call.startedAt, call.finishedAt ?? now) }))
  }));
}
