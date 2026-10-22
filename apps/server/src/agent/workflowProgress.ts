import { deploymentRounds, type DeploymentWorkflow } from "../services/deploymentWorkflow.js";
import type { AgentWorkflowProgress } from "../types.js";

export function buildWorkflowProgress(workflow: DeploymentWorkflow, previous: AgentWorkflowProgress | null | undefined,
  update: { stepId: string; status: "pending" | "running" | "completed" | "failed"; progress: number; detail: string; title: string }, legacyRounds = Boolean(previous?.turn)): AgentWorkflowProgress {
  const rounds = deploymentRounds(workflow);
  const steps = workflow.steps.filter((step) => step.enabled).map(({ id, label, parallelGroup }) => {
    const old = previous?.steps.find((step) => step.id === id);
    const metadata = { ...(legacyRounds ? { roundIndex: rounds.findIndex((round) => round.steps.some((step) => step.id === id)) } : {}), ...(parallelGroup ? { parallelGroup } : {}) };
    if (id !== update.stepId) return { id, label, ...metadata, status: old?.status ?? "pending" as const, progress: old?.progress ?? 0, detail: old?.detail ?? "" };
    return { id, label, ...metadata, status: update.status, progress: update.status === "completed" ? 100 : Math.max(0, Math.min(100, Math.round(update.progress))), detail: update.detail };
  });
  const completed = steps.every((step) => step.status === "completed");
  const measured = Math.round(steps.reduce((sum, step) => sum + (step.status === "completed" ? 100 : Math.min(99, step.progress)), 0) / Math.max(steps.length, 1));
  const overallProgress = completed ? 100 : Math.min(99, measured);
  return { ...(previous?.turn ? { turn: previous.turn } : {}), ...(previous?.run ? { run: previous.run } : {}), title: update.title, currentStepId: update.stepId, steps, overallProgress,
    status: completed ? "completed" : steps.some((step) => step.status === "failed") ? "failed" : "running" };
}
