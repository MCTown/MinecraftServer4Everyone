import type { AgentWorkflowProgress } from "../types/app";
import type { DeploymentProgressState } from "../types/ui";

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
