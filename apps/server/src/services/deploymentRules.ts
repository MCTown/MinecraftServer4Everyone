import { analyzeWorkflowGraph, normalizeGraphWorkflow, type WorkflowCanvas } from "./deploymentGraph.js";

/** The single workflow check used by the editor, the save gate and the prompt preview. */
export interface WorkflowRuleStep { id: string; label: string; prompt: string; enabled: boolean; parallelGroup?: string }
export interface WorkflowRuleWorkflow { version?: number; steps: WorkflowRuleStep[]; canvas?: WorkflowCanvas }
export interface WorkflowRuleStage { id: string; label: string }

export function workflowIssues(workflow: WorkflowRuleWorkflow, catalog: readonly WorkflowRuleStage[]): string[] {
  const issues: string[] = analyzeWorkflowGraph(workflow).issues.map((issue) => issue.message);
  workflow = normalizeGraphWorkflow(workflow);
  const active = workflow.steps.filter((step) => step.enabled);
  const ids = new Set<string>();
  if (workflow.steps.length > 40) issues.push("流程最多包含 40 个步骤");
  for (const step of workflow.steps) {
    if (ids.has(step.id)) issues.push(`步骤 ID 重复：${step.id}`);
    ids.add(step.id);
    if (step.id === "apply_mcdr_template") issues.push("套用 MCDR 模板已移至新建服务端时自动执行，请刷新流程配置");
    if (!step.label.trim() || step.label.trim().length > 60) issues.push("步骤名称需要 1–60 个字符");
    if (step.enabled && !step.prompt.trim()) issues.push(`「${step.label}」的提示词不能为空`);
    if (step.prompt.length > 12000) issues.push(`「${step.label}」的提示词不能超过 12000 字符`);
  }
  const groups = new Set<string>();
  let previous: string | undefined;
  for (const step of workflow.steps) {
    if (step.parallelGroup && step.parallelGroup !== previous) {
      if (groups.has(step.parallelGroup)) issues.push("并行组必须连续且收束，不能跨越其他节点");
      groups.add(step.parallelGroup);
    }
    previous = step.parallelGroup;
    if (step.parallelGroup && ids.has(step.parallelGroup)) issues.push("并行组 ID 不能与步骤 ID 相同");
    if (step.parallelGroup && ["identify_modpack", "final_mcdr_test"].includes(step.id)) issues.push("确认整合包与最终验证必须是独立关口，不与其他步骤并行");
  }
  for (const group of groups) if (workflow.steps.filter((step) => step.parallelGroup === group).length > 4) issues.push("每个并行组最多包含 4 个节点");
  for (const stage of catalog) {
    if (active.findIndex((step) => step.id === stage.id) < 0) issues.push(`必须保留并启用「${stage.label}」`);
  }
  if (active[0]?.id !== "identify_modpack") issues.push("确认整合包必须是第一个启用的步骤");
  if (active.at(-1)?.id !== "final_mcdr_test") issues.push("最终验证必须是最后一个启用的步骤");
  return issues;
}
