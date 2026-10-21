import { analyzeWorkflowGraph, normalizeGraphWorkflow, orderedWorkflowRounds, withWorkflowCanvas, workflowGraphEdges, workflowGraphLayout, type WorkflowCanvas, type WorkflowEdge, type WorkflowPoint } from "../../server/src/services/deploymentGraph";
import { workflowIssues as workflowRuleIssues } from "../../server/src/services/deploymentRules";
export { analyzeWorkflowGraph, normalizeGraphWorkflow, withWorkflowCanvas, workflowGraphLayout };
export type { WorkflowCanvas, WorkflowEdge, WorkflowPoint };
export interface DeploymentWorkflowStep { id: string; label: string; prompt: string; enabled: boolean; parallelGroup?: string }
export interface DeploymentWorkflow { version: 1; steps: DeploymentWorkflowStep[]; canvas?: WorkflowCanvas }
export interface DeploymentStage { id: string; label: string; prompt: string; requires: string[] }
export interface DeploymentWorkflowState {
  workflow: DeploymentWorkflow;
  defaults: DeploymentWorkflow;
  catalog: DeploymentStage[];
  prompt: string;
}

export function workflowRounds(steps: DeploymentWorkflowStep[], includeDisabled = false) {
  const rounds = orderedWorkflowRounds(steps);
  return includeDisabled ? rounds : rounds.map((round) => ({ ...round, steps: round.steps.filter((step) => step.enabled) })).filter((round) => round.steps.length);
}

/** Same rule set as the save gate and the prompt preview; keep one implementation only. */
export function workflowIssues(workflow: DeploymentWorkflow, catalog: DeploymentStage[]) {
  return workflowRuleIssues(workflow, catalog);
}

export function moveWorkflowStep(workflow: DeploymentWorkflow, id: string, to: number): DeploymentWorkflow {
  workflow = normalizeGraphWorkflow(workflow);
  const steps = [...workflow.steps];
  const from = steps.findIndex((step) => step.id === id);
  if (from < 0) return workflow;
  const moving = steps[from]!;
  const target = steps[Math.max(0, Math.min(steps.length - 1, to))]!;
  if (moving.parallelGroup && moving.parallelGroup !== target.parallelGroup) {
    const block = steps.filter((step) => step.parallelGroup === moving.parallelGroup);
    const remaining = steps.filter((step) => step.parallelGroup !== moving.parallelGroup);
    const targetBlock = remaining.filter((step) => target.parallelGroup ? step.parallelGroup === target.parallelGroup : step.id === target.id);
    const index = to < from ? remaining.indexOf(targetBlock[0]!) : remaining.indexOf(targetBlock.at(-1)!) + 1;
    remaining.splice(Math.max(0, index), 0, ...block);
    return rebuildWorkflowEdges({ ...workflow, steps: remaining });
  }
  const [step] = steps.splice(from, 1);
  if (step) steps.splice(Math.max(0, Math.min(steps.length, to)), 0, step);
  return rebuildWorkflowEdges({ ...workflow, steps });
}

/** Move a branch into a closed group; dissolve leftover single-node groups. */
export function groupWorkflowStep(workflow: DeploymentWorkflow, id: string, targetId: string | null, groupId = `parallel_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`): DeploymentWorkflow {
  workflow = normalizeGraphWorkflow(workflow);
  const steps = workflow.steps.map((step) => ({ ...step }));
  const moving = steps.find((step) => step.id === id), target = steps.find((step) => step.id === targetId);
  if (!moving || target === moving) return workflow;
  delete moving.parallelGroup;
  if (target) {
    const group = target.parallelGroup ?? groupId;
    target.parallelGroup = group; moving.parallelGroup = group;
    steps.splice(steps.indexOf(moving), 1);
    const end = steps.findLastIndex((step) => step.parallelGroup === group);
    steps.splice(end + 1, 0, moving);
  } else {
    const originalGroup = workflow.steps.find((step) => step.id === id)?.parallelGroup;
    if (originalGroup) {
      steps.splice(steps.indexOf(moving), 1);
      const end = steps.findLastIndex((step) => step.parallelGroup === originalGroup);
      steps.splice(end + 1, 0, moving);
    }
  }
  for (const step of steps) if (step.parallelGroup && steps.filter((other) => other.parallelGroup === step.parallelGroup).length === 1) delete step.parallelGroup;
  return rebuildWorkflowEdges({ ...workflow, steps });
}

export function rebuildWorkflowEdges(workflow: DeploymentWorkflow): DeploymentWorkflow {
  return workflow.canvas ? { ...workflow, canvas: { ...workflow.canvas, edges: workflowGraphEdges(workflow.steps) } } : workflow;
}
export function setWorkflowPosition(workflow: DeploymentWorkflow, id: string, point: WorkflowPoint): DeploymentWorkflow {
  const next = withWorkflowCanvas(workflow);
  return { ...next, canvas: { ...next.canvas, positions: { ...next.canvas.positions, [id]: { x: Math.round(Math.max(-10000, Math.min(10000, point.x))), y: Math.round(Math.max(-10000, Math.min(10000, point.y))) } } } };
}
export function connectWorkflowNodes(workflow: DeploymentWorkflow, from: string, to: string): DeploymentWorkflow {
  const next = withWorkflowCanvas(workflow);
  if (next.canvas.edges.some((edge) => edge.from === from && edge.to === to)) return workflow;
  return normalizeGraphWorkflow({ ...next, canvas: { ...next.canvas, edges: [...next.canvas.edges, { id: `edge_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`, from, to }] } });
}
export function removeWorkflowEdge(workflow: DeploymentWorkflow, id: string): DeploymentWorkflow {
  const next = withWorkflowCanvas(workflow);
  return normalizeGraphWorkflow({ ...next, canvas: { ...next.canvas, edges: next.canvas.edges.filter((edge) => edge.id !== id) } });
}

export function toggleWorkflowStep(workflow: DeploymentWorkflow, id: string): DeploymentWorkflow {
  if (!workflow.steps.some((step) => step.id === id)) return workflow;
  return { ...workflow, steps: workflow.steps.map((step) => step.id === id ? { ...step, enabled: !step.enabled } : step) };
}

// Adapted from ChatHub-Server/web/app.js topology camera: anchor-preserving zoom.
export interface WorkflowCamera { x: number; y: number; scale: number }
export const workflowScale = (value: number) => Math.max(.25, Math.min(1.8, value));
export function zoomWorkflowCamera(camera: WorkflowCamera, scale: number, x: number, y: number): WorkflowCamera {
  const next = workflowScale(scale), ratio = next / camera.scale;
  return { x: x - (x - camera.x) * ratio, y: y - (y - camera.y) * ratio, scale: next };
}
