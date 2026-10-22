import type { AgentStatus, AgentWorkflowProgress } from "../types/app";
import type { DeploymentProgressState } from "../types/ui";

export function resolveDeploymentProgressState(workflow: AgentWorkflowProgress | null, status: AgentStatus, busy: boolean, packageReady: boolean): DeploymentProgressState {
  if (!workflow) return packageReady ? "ready" : "not_started";
  if (workflow.status === "failed") return status === "cancelled" ? "cancelled" : "failed";
  if (workflow.run) {
    if (status === "cancelled") return "cancelled";
    if (status === "failed") return "failed";
    if (status === "waiting_confirmation") return "waiting_confirmation";
    if (status === "retrying") return "retrying";
    if (busy || workflow.run.waitingForJobs) return "running";
  }
  if (workflow.steps.length > 0 && workflow.steps.every((step) => step.status === "completed")) return "completed";
  if (status === "waiting_confirmation") return "waiting_confirmation";
  if (status === "retrying") return "retrying";
  return busy ? "running" : "progress";
}

export function resolveDeploymentStage(workflow: AgentWorkflowProgress | null, state: DeploymentProgressState) {
  const steps = workflow?.steps ?? [];
  const candidates = workflow?.turn ? steps.filter((step) => workflow.turn!.stepIds.includes(step.id)) : steps;
  const current = state === "completed" ? null
    : (state === "failed" ? candidates.find((step) => step.status === "failed") : undefined)
      ?? candidates.find((step) => step.id === workflow?.currentStepId && step.status !== "completed")
      ?? candidates.find((step) => step.status === "running")
      ?? candidates.find((step) => step.status === "failed")
      ?? candidates.find((step) => step.status === "pending")
      ?? (workflow?.turn ? candidates.at(-1) : null)
      ?? null;
  const index = current ? steps.indexOf(current) : -1;
  const next = index < 0 ? null : steps.slice(index + 1).find((step) => step.status === "pending" && (!workflow?.turn || !workflow.turn.stepIds.includes(step.id))) ?? null;
  return { current, index, next };
}
