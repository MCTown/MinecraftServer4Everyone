import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWorkflowToolProgress } from "../src/agent/workflowToolProgress.js";
import { compileDeploymentWorkflow, defaultDeploymentWorkflow } from "../src/services/deploymentWorkflow.js";

test("merged progress validates all enabled IDs and evidence before side effects", () => {
  const workflow = defaultDeploymentWorkflow();
  assert.deepEqual(parseWorkflowToolProgress({}, workflow), { stepId: undefined, updates: [] });
  const update = { stepId: "identify_modpack", status: "completed", detail: "用户已确认版本" };
  assert.equal(parseWorkflowToolProgress({ workflowUpdates: [update] }, workflow).updates[0]!.status, "completed");
  for (const args of [
    { workflowStepId: "missing" }, { workflowUpdates: {} }, { workflowUpdates: [update, update] },
    { workflowUpdates: [{ ...update, status: "done" }] }, { workflowUpdates: [{ ...update, detail: "" }] },
    { workflowUpdates: [{ ...update, detail: "x".repeat(2001) }] }
  ]) assert.throws(() => parseWorkflowToolProgress(args, workflow));
  workflow.steps[0]!.enabled = false;
  assert.throws(() => parseWorkflowToolProgress({ workflowStepId: workflow.steps[0]!.id }, workflow));
});

test("workflow policy removes mandatory standalone reports without removing gates", () => {
  const prompt = compileDeploymentWorkflow(defaultDeploymentWorkflow());
  assert.match(prompt, /workflowUpdates/);
  assert.match(prompt, /本轮门禁、用户确认与后台结果检查/);
  assert.doesNotMatch(prompt, /每阶段开始、完成或失败都调用/);
});
