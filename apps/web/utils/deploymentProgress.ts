import type { AgentWorkflowProgress } from "../types/app";
import type { DeploymentProgressState } from "../types/ui";

export function resolveDeploymentStage(workflow: AgentWorkflowProgress | null, state: DeploymentProgressState) {
  const steps = workflow?.steps ?? [];
  const current = state === "completed" ? null
    : (state === "failed" ? steps.find((step) => step.status === "failed") : undefined)
      ?? steps.find((step) => step.id === workflow?.currentStepId && step.status !== "completed")
      ?? steps.find((step) => step.status === "running")
      ?? steps.find((step) => step.status === "failed")
      ?? steps.find((step) => step.status === "pending")
      ?? null;
  const index = current ? steps.indexOf(current) : -1;
  const next = index < 0 ? null : steps.slice(index + 1).find((step) => step.status === "pending") ?? null;
  return { current, index, next };
}
