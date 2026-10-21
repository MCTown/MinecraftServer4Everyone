import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeWorkflowGraph, normalizeGraphWorkflow, withWorkflowCanvas } from "../src/services/deploymentGraph.js";
import { compileDeploymentWorkflow, defaultDeploymentWorkflow as parallelDeploymentWorkflow, deploymentStageCatalog, deploymentRounds, deploymentWorkflowSchema, workflowIssues, type DeploymentWorkflow } from "../src/services/deploymentWorkflow.js";

// Explicit legacy serial fixture; defaults now include a sparse parallel graph.
const defaultDeploymentWorkflow = (): DeploymentWorkflow => ({ version: 1, steps: deploymentStageCatalog.map(({ id, label, prompt }) => ({ id, label, prompt, enabled: true })) });

test("old serial and parallel workflows gain an editable graph without changing their turns", () => {
  const serial = defaultDeploymentWorkflow();
  const graph = withWorkflowCanvas(serial);
  assert.equal(graph.canvas.edges.length, 6);
  assert.deepEqual(analyzeWorkflowGraph(graph).issues, []);
  assert.deepEqual(normalizeGraphWorkflow(graph).steps, serial.steps);
  const python = serial.steps.splice(4, 1)[0]!; serial.steps.splice(2, 0, python);
  serial.steps[2]!.parallelGroup = python.parallelGroup = "parallel_java_python";
  const parallel = withWorkflowCanvas(serial);
  assert.deepEqual(workflowIssues(parallel), []);
  assert.deepEqual(deploymentRounds(parallel).map((round) => round.steps.map((step) => step.id)), [
    ["identify_modpack"], ["prepare_server_slot"], ["configure_python"], ["check_java_dependencies"], ["extract_to_workspace"], ["configure_mcdr"], ["final_mcdr_test"]
  ]);
  assert.equal(parallel.canvas.edges.filter(edge => edge.from === "prepare_server_slot").length, 1);
});

test("positions are presentation only; valid edges determine canonical execution order", () => {
  const original = defaultDeploymentWorkflow(), graph = withWorkflowCanvas(structuredClone(original));
  graph.canvas.positions.identify_modpack = { x: -5000, y: 5000 };
  graph.canvas.positions.final_mcdr_test = { x: 400, y: -4000 };
  graph.steps.reverse(); // Direct API clients cannot override topology with stale step order.
  assert.deepEqual(workflowIssues(graph), []);
  assert.equal(compileDeploymentWorkflow(graph), compileDeploymentWorkflow(original));
  assert.deepEqual(deploymentRounds(graph).map(round => round.steps[0]!.id), original.steps.map(step => step.id));
  assert.equal(deploymentWorkflowSchema.safeParse(graph).success, true);
  graph.canvas.positions.identify_modpack = { x: Infinity, y: 0 };
  assert.equal(deploymentWorkflowSchema.safeParse(graph).success, false);
});

test("cycle, self loop, duplicate edges, dangling references, disconnected and unclosed branches are rejected", () => {
  const base = withWorkflowCanvas(defaultDeploymentWorkflow());
  for (const [edit, expected] of [
    [(graph: typeof base) => graph.canvas.edges.push({ id: "loop", from: "extract_to_workspace", to: "prepare_server_slot" }), /闭环/],
    [(graph: typeof base) => graph.canvas.edges.push({ id: "self", from: "configure_python", to: "configure_python" }), /自身/],
    [(graph: typeof base) => graph.canvas.edges.push({ ...graph.canvas.edges[0]!, id: "duplicate" }), /重复/],
    [(graph: typeof base) => graph.canvas.edges.push({ id: "unknown", from: "unknown", to: "identify_modpack" }), /不存在/],
     [(graph: typeof base) => graph.canvas.edges.splice(2, 1), /入口|出口/]
  ] as const) {
    const graph = structuredClone(base); edit(graph);
    assert.ok(workflowIssues(graph).some(issue => expected.test(issue)), JSON.stringify(workflowIssues(graph)));
    assert.ok(analyzeWorkflowGraph(graph).issues.some(issue => issue.nodeIds.length));
    assert.deepEqual(normalizeGraphWorkflow(graph), graph, "invalid draft is preserved, not silently repaired");
  }
});

test("default graph expresses the requested sparse dependencies and parallel rounds", () => {
  const workflow = withWorkflowCanvas(parallelDeploymentWorkflow());
  assert.deepEqual(workflowIssues(workflow), []);
  assert.deepEqual(workflow.canvas.edges.map(({ from, to }) => [from, to]), [
    ["identify_modpack", "prepare_server_slot"],
    ["identify_modpack", "check_java_dependencies"],
    ["prepare_server_slot", "extract_to_workspace"],
    ["check_java_dependencies", "extract_to_workspace"],
    ["identify_modpack", "configure_python"],
    ["configure_python", "configure_mcdr"],
    ["extract_to_workspace", "final_mcdr_test"],
    ["configure_mcdr", "final_mcdr_test"]
  ]);
  assert.deepEqual(deploymentRounds(workflow).map(round => round.steps.map(step => step.id)), [
    ["identify_modpack"],
    ["prepare_server_slot", "check_java_dependencies", "configure_python"],
    ["extract_to_workspace", "configure_mcdr"],
    ["final_mcdr_test"]
  ]);
});

test("sparse cross-layer edges are legal and stage order needs no hard-coded prerequisite lines", () => {
  const graph = parallelDeploymentWorkflow();
  graph.canvas!.edges = graph.canvas!.edges.filter((edge) => !(edge.from === "check_java_dependencies" && edge.to === "extract_to_workspace"));
  graph.canvas!.edges.push({ id: "java_final", from: "check_java_dependencies", to: "final_mcdr_test" });
  assert.deepEqual(analyzeWorkflowGraph(graph).issues, []);
  assert.deepEqual(workflowIssues(graph), []);
  const serial = defaultDeploymentWorkflow();
  const order = ["identify_modpack", "configure_python", "configure_mcdr", "prepare_server_slot", "check_java_dependencies", "extract_to_workspace", "final_mcdr_test"];
  serial.steps.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  assert.deepEqual(workflowIssues(withWorkflowCanvas(serial)), []);
});

test("well-formed topology still enforces safety gates and the four-branch limit", () => {
  const workflow = defaultDeploymentWorkflow();
  const java = workflow.steps.splice(2, 1)[0]!; workflow.steps.splice(4, 0, java);
  assert.deepEqual(workflowIssues(withWorkflowCanvas(workflow)), []);
  const unsafe = defaultDeploymentWorkflow(); unsafe.steps[0]!.parallelGroup = unsafe.steps[1]!.parallelGroup = "parallel_unsafe";
  assert.ok(workflowIssues(withWorkflowCanvas(unsafe)).some(issue => issue.includes("独占一个 turn")));
  const wide = defaultDeploymentWorkflow();
  for (let index = 0; index < 5; index++) wide.steps.splice(2, 0, { id: `custom_${index}`, label: "分支", prompt: "check", enabled: true, parallelGroup: "parallel_wide" });
  assert.ok(workflowIssues(withWorkflowCanvas(wide)).some(issue => issue.includes("最多包含 4")));
});

test("graph normalization never drops duplicate node IDs or collides group IDs with node IDs", () => {
  const duplicate = withWorkflowCanvas(defaultDeploymentWorkflow());
  duplicate.steps.push({ ...duplicate.steps[1]! });
  assert.ok(workflowIssues(duplicate).some(issue => issue.includes("步骤 ID 重复")));
  assert.equal(normalizeGraphWorkflow(duplicate), duplicate, "an invalid graph must not silently discard a duplicate node");

  const workflow = defaultDeploymentWorkflow();
  const python = workflow.steps.splice(4, 1)[0]!;
  workflow.steps.splice(2, 0, python);
  workflow.steps[2]!.parallelGroup = python.parallelGroup = "parallel_java_python";
  workflow.steps.splice(-1, 0, { id: "parallel_turn_3", label: "检查", prompt: "检查备份", enabled: true });
  const normalized = normalizeGraphWorkflow(withWorkflowCanvas(workflow));
  assert.deepEqual(workflowIssues(normalized), []);
  assert.equal(normalized.steps.some((step) => step.id === "parallel_turn_3"), true);
  assert.deepEqual(normalizeGraphWorkflow(normalized), normalized, "canonicalization stays stable across saves");
});
