import assert from "node:assert/strict";
import test from "node:test";
import type { AgentWorkflowProgress } from "../types/app";
import { resolveDeploymentStage } from "../utils/deploymentProgress";

function workflow(): AgentWorkflowProgress {
  return {
    title: "部署流程", currentStepId: "install", overallProgress: 45, status: "running",
    steps: [
      { id: "download", label: "获取服务端包", status: "completed", progress: 100, detail: "已下载" },
      { id: "install", label: "安装运行环境", status: "running", progress: 35, detail: "正在安装 Java" },
      { id: "start", label: "启动验证", status: "pending", progress: 0, detail: "" }
    ]
  };
}

test("current deployment stage and next stage use actual workflow steps", () => {
  const source = workflow();
  for (const state of ["running", "waiting_confirmation", "retrying", "progress", "cancelled"] as const) {
    const stage = resolveDeploymentStage(source, state);
    assert.equal(stage.current?.id, "install");
    assert.equal(stage.index, 1);
    assert.equal(stage.next?.id, "start");
  }
  assert.equal(source.steps[1]?.status, "running");
});

test("stale or missing current step IDs fall back without highlighting a completed step", () => {
  const source = workflow();
  source.currentStepId = "download";
  assert.equal(resolveDeploymentStage(source, "running").current?.id, "install");
  source.currentStepId = "missing";
  source.steps[1]!.status = "completed";
  assert.equal(resolveDeploymentStage(source, "progress").current?.id, "start");
});

test("failure highlights the failed stage, while completion has no active or next stage", () => {
  const source = workflow();
  source.currentStepId = "start";
  source.steps[1]!.status = "failed";
  assert.equal(resolveDeploymentStage(source, "failed").current?.id, "install");
  assert.deepEqual(resolveDeploymentStage(source, "completed"), { current: null, index: -1, next: null });
});

test("absent and empty workflows do not invent deployment stages", () => {
  assert.deepEqual(resolveDeploymentStage(null, "ready"), { current: null, index: -1, next: null });
  assert.deepEqual(resolveDeploymentStage({ ...workflow(), steps: [] }, "running"), { current: null, index: -1, next: null });
});

test("parallel branches remain in the active turn until joined and never label a future node as current", () => {
  const source = workflow();
  source.steps.splice(2, 0, { id: "python", label: "独立分支", status: "pending", progress: 0, detail: "" });
  source.turn = { runId: "run", turnId: "turn", index: 1, total: 3, stepIds: ["install", "python"] };
  assert.equal(resolveDeploymentStage(source, "running").next?.id, "start");
  source.steps[1]!.status = "completed";
  assert.equal(resolveDeploymentStage(source, "running").current?.id, "python");
  source.steps[2]!.status = "completed";
  assert.equal(resolveDeploymentStage(source, "running").current?.id, "python");
  assert.equal(resolveDeploymentStage(source, "running").next?.id, "start");
});
