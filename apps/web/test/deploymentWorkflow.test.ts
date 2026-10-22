import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeWorkflowGraph, connectWorkflowNodes, groupWorkflowStep, moveWorkflowStep, normalizeGraphWorkflow, removeWorkflowEdge, setWorkflowPosition, toggleWorkflowStep, withWorkflowCanvas, workflowIssues, workflowRounds, zoomWorkflowCamera } from "../utils/deploymentWorkflow";
import { compileDeploymentWorkflow, deploymentStageCatalog, workflowIssues as serverIssues, type DeploymentWorkflow } from "../../server/src/services/deploymentWorkflow";

const defaultDeploymentWorkflow = (): DeploymentWorkflow => ({ version: 1, steps: deploymentStageCatalog.map(({ id, label, prompt }) => ({ id, label, prompt, enabled: true })) });

test("editor reorder is immutable and frontend/server dependency validation agree", () => {
  const original = defaultDeploymentWorkflow();
  const catalog = deploymentStageCatalog.map((step) => ({ ...step, requires: [...step.requires] }));
  const moved = moveWorkflowStep(original, "configure_python", 1);
  assert.equal(original.steps[1]!.id, "prepare_server_slot");
  assert.equal(moved.steps[1]!.id, "configure_python");
  assert.deepEqual(workflowIssues(moved, catalog), []);
  assert.deepEqual(workflowIssues(moved, catalog), serverIssues(moved));
  const invalid = moveWorkflowStep(original, "final_mcdr_test", 0);
  assert.deepEqual(workflowIssues(invalid, catalog), serverIssues(invalid));
  assert.ok(workflowIssues(invalid, catalog).length);
  const blank = moveWorkflowStep(original, "configure_python", 1);
  blank.steps = [...blank.steps]; blank.steps[1] = { ...blank.steps[1]!, prompt: "" };
  assert.deepEqual(workflowIssues(blank, catalog), serverIssues(blank));
  const javaAfterExtract = moveWorkflowStep(original, "check_java_dependencies", 5);
  assert.deepEqual(workflowIssues(javaAfterExtract, catalog), []);
  assert.deepEqual(workflowIssues(javaAfterExtract, catalog), serverIssues(javaAfterExtract));
  const old = structuredClone(original);
  old.steps[2] = { ...old.steps[2]!, id: "apply_mcdr_template" };
  assert.deepEqual(workflowIssues(old, catalog), serverIssues(old));
});

test("free movement leaves topology unchanged; invalid connections remain editable and agree with server validation", () => {
  const catalog = deploymentStageCatalog.map(step => ({ ...step, requires: [...step.requires] }));
  const original = withWorkflowCanvas(defaultDeploymentWorkflow());
  const moved = setWorkflowPosition(original, "identify_modpack", { x: 720, y: 333 });
  assert.deepEqual(moved.canvas!.positions.identify_modpack, { x: 720, y: 333 });
  assert.deepEqual(moved.canvas!.edges, original.canvas.edges);
  assert.deepEqual(moved.steps, original.steps);
  const invalid = connectWorkflowNodes(moved, "final_mcdr_test", "identify_modpack");
  assert.equal(invalid.canvas!.edges.length, 8);
  assert.ok(workflowIssues(invalid, catalog).some(issue => issue.includes("闭环")));
  assert.deepEqual(workflowIssues(invalid, catalog), serverIssues(invalid));
  const restored = removeWorkflowEdge(invalid, invalid.canvas!.edges.at(-1)!.id);
  assert.deepEqual(workflowIssues(restored, catalog), []);
  assert.equal(connectWorkflowNodes(restored, "identify_modpack", "prepare_server_slot"), restored, "duplicate link is a no-op");
});

test("manually drawn fork/join compiles to one turn and disabled nodes do not break structural validation", () => {
  const graph = withWorkflowCanvas(defaultDeploymentWorkflow());
  const pairs = [["identify_modpack", "prepare_server_slot"], ["prepare_server_slot", "check_java_dependencies"], ["prepare_server_slot", "configure_python"],
    ["check_java_dependencies", "extract_to_workspace"], ["configure_python", "extract_to_workspace"], ["extract_to_workspace", "configure_mcdr"],
    ["configure_mcdr", "install_modloader"], ["install_modloader", "final_mcdr_test"]];
  graph.canvas.edges = pairs.map(([from, to], index) => ({ id: `edge_${index}`, from: from!, to: to! }));
  const result = normalizeGraphWorkflow(graph);
  assert.deepEqual(analyzeWorkflowGraph(result).issues, []);
  assert.deepEqual(result.steps.slice(2, 4).map(step => step.id), ["check_java_dependencies", "configure_python"]);
  assert.equal(result.steps[2]!.parallelGroup, result.steps[3]!.parallelGroup);
  assert.equal(workflowRounds(result.steps).length, 7);
  result.steps.splice(1, 0, { id: "custom_disabled", label: "停用", prompt: "", enabled: false });
  // An unconnected disabled node is still structurally visible and must be wired or deleted.
  assert.ok(analyzeWorkflowGraph(result).issues.some(issue => issue.message.includes("入口")));
});

test("disabling a custom step preserves its connections but excludes it from turns and prompt", () => {
  const workflow = defaultDeploymentWorkflow();
  workflow.steps.splice(-1, 0, { id: "custom_backup", label: "备份检查", prompt: "核对世界备份", enabled: true });
  const original = withWorkflowCanvas(workflow);
  const disabled = toggleWorkflowStep(original, "custom_backup");
  assert.equal(original.steps.find(step => step.id === "custom_backup")!.enabled, true);
  assert.equal(disabled.steps.find(step => step.id === "custom_backup")!.enabled, false);
  assert.deepEqual(disabled.canvas, original.canvas);
  assert.deepEqual(serverIssues(disabled), []);
  assert.equal(workflowRounds(normalizeGraphWorkflow(disabled).steps).some(round => round.steps.some(step => step.id === "custom_backup")), false);
  assert.equal(compileDeploymentWorkflow(disabled).includes("custom_backup"), false);
  const restored = toggleWorkflowStep(disabled, "custom_backup");
  assert.deepEqual(restored, original);
  assert.ok(compileDeploymentWorkflow(restored).includes("核对世界备份"));
});

test("zoom preserves the world point under the cursor and clamps scale", () => {
  const before = { x: 80, y: 65, scale: .7 }, anchor = { x: 130, y: 240 };
  const after = zoomWorkflowCamera(before, 1.2, anchor.x, anchor.y);
  assert.ok(Math.abs((anchor.x - after.x) / after.scale - (anchor.x - before.x) / before.scale) < 1e-9);
  assert.ok(Math.abs((anchor.y - after.y) / after.scale - (anchor.y - before.y) / before.scale) < 1e-9);
  assert.equal(zoomWorkflowCamera(before, 100, 0, 0).scale, 1.8);
  assert.equal(zoomWorkflowCamera(before, .0001, 0, 0).scale, .25);
});

test("editor creates explicit fork/join groups, moves groups atomically and dissolves single branches", () => {
  const original = defaultDeploymentWorkflow();
  const catalog = deploymentStageCatalog.map((step) => ({ ...step, requires: [...step.requires] }));
  const grouped = groupWorkflowStep(original, "configure_python", "check_java_dependencies", "parallel_test");
  assert.deepEqual(original, defaultDeploymentWorkflow());
  assert.equal(workflowRounds(grouped.steps).length, 7);
  assert.deepEqual(workflowIssues(grouped, catalog), []);
  assert.deepEqual(workflowIssues(grouped, catalog), serverIssues(grouped));
  const moved = moveWorkflowStep(grouped, "configure_python", 1);
  assert.equal(moved.steps[1]!.id, "check_java_dependencies");
  assert.equal(moved.steps[2]!.id, "configure_python");
  assert.deepEqual(workflowIssues(moved, catalog), [], "Java and Python may move ahead of the download");
  const separate = groupWorkflowStep(grouped, "configure_python", null);
  assert.equal(separate.steps.some((step) => step.parallelGroup), false);
  assert.equal(workflowRounds(separate.steps).length, 8);
  const sameTurn = groupWorkflowStep(original, "check_java_dependencies", "extract_to_workspace", "parallel_bad");
  assert.deepEqual(workflowIssues(sameTurn, catalog), []);
  assert.deepEqual(workflowIssues(sameTurn, catalog), serverIssues(sameTurn));
  const split = structuredClone(grouped); split.steps.at(-1)!.parallelGroup = "parallel_test";
  assert.deepEqual(workflowIssues(split, catalog), serverIssues(split));
  assert.ok(workflowIssues(split, catalog).some((issue) => issue.includes("收束")));
});
