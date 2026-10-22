import type { DeploymentWorkflow } from "../services/deploymentWorkflow.js";

export interface WorkflowToolUpdate {
  stepId: string;
  status: "pending" | "running" | "completed" | "failed";
  detail: string;
}

// Validate the whole envelope before executing external side effects.
export function parseWorkflowToolProgress(args: Record<string, unknown>, workflow: DeploymentWorkflow) {
  const enabled = new Set(workflow.steps.filter((step) => step.enabled).map((step) => step.id));
  const checkId = (id: unknown): string => {
    if (typeof id !== "string" || !enabled.has(id)) throw new Error(`Unknown or disabled workflow step: ${String(id)}`);
    return id;
  };
  const stepId = args.workflowStepId === undefined ? undefined : checkId(args.workflowStepId);
  const updates: WorkflowToolUpdate[] = [];
  if (args.workflowUpdates !== undefined) {
    if (!Array.isArray(args.workflowUpdates) || args.workflowUpdates.length > workflow.steps.length) throw new Error("workflowUpdates must be a bounded array");
    for (const raw of args.workflowUpdates) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid workflow update");
      const item = raw as Record<string, unknown>;
      const id = checkId(item.stepId);
      if (!["pending", "running", "completed", "failed"].includes(item.status as string)) throw new Error("Invalid workflow status");
      if (typeof item.detail !== "string" || !item.detail.trim() || item.detail.length > 2000) throw new Error("workflowUpdates requires a concise evidence/detail string");
      if (updates.some((update) => update.stepId === id)) throw new Error("Duplicate workflow update");
      updates.push({ stepId: id, status: item.status as WorkflowToolUpdate["status"], detail: item.detail });
    }
  }
  return { stepId, updates };
}

export const workflowUpdatesSchema = {
  type: "array", description: "合并此前已由工具结果/日志验证的阶段状态（只限本轮）。不预测本次调用结果，不把后台回执或单工具成功当阶段完成；无变更省略。",
  items: { type: "object", additionalProperties: false, properties: {
    stepId: { type: "string" }, status: { type: "string", enum: ["pending", "running", "completed", "failed"] },
    detail: { type: "string", maxLength: 2000 }
  }, required: ["stepId", "status", "detail"] }
};
