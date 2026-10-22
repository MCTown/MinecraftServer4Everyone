import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { profiles, transformPrompt, leanRuntime, compactStatic } from "./benchmark-ablation-transforms.mjs";

const example = JSON.parse(readFileSync("exp/the-pixelmon-modpack/MCT-full/model-requests.jsonl", "utf8").split("\n")[0]);
const system = example.request.messages.find(message => message.role === "system").content;
const workflow = JSON.parse(readFileSync("exp/the-pixelmon-modpack/MCT-full/workflow-snapshot.json", "utf8")).workflow;

test("control and skill ablation do not rewrite unrelated system text", () => {
  assert.equal(transformPrompt(system, "control"), system);
  assert.equal(transformPrompt(system, "no-skill"), system);
  assert.equal(profiles.length, 6);
});
test("no-progress removes the mandated reporting instruction, not workflow start", () => {
  const result = transformPrompt(system, "no-progress");
  assert.ok(!result.includes("每阶段开始、完成或失败都调用 update_agent_workflow_progress"));
  assert.ok(result.includes("完整部署必须先调用 begin_deployment_workflow"));
  assert.ok(result.includes("wait_for_server_stopped"));
});
test("single-turn removes mandatory scheduler and turn round list, retaining checks and progress", () => {
  const result = transformPrompt(system, "single-turn");
  assert.ok(!result.includes("完整部署必须先调用 begin_deployment_workflow"));
  assert.ok(!result.includes("完整部署调用 begin_deployment_workflow"));
  assert.ok(!result.includes("Turn 1:"));
  assert.ok(result.includes("update_agent_workflow_progress"));
  for (const step of workflow.steps) assert.ok(result.includes(step.id));
});
test("lean runtime preserves facts, removes only policy lines", () => {
  assert.equal(leanRuntime("- Java 路径：/safe/java\n配置策略：重复\n当前服务端根目录文件：\nserver/\n对话要求：重复"), "- Java 路径：/safe/java\n当前服务端根目录文件：\nserver/");
});
test("compact-static retains stages and critical tool safety contract", () => {
  const result = compactStatic(workflow);
  assert.ok(result.length < system.length * .5);
  for (const step of workflow.steps) assert.ok(result.includes(step.id));
  for (const term of ["begin_deployment_workflow", "update_agent_workflow_progress", "wait_for_server_stopped", "inspect_current_server_validation", "凭据", "ERROR/FATAL", "server/"]) assert.ok(result.includes(term));
});
