/** Pure, shared graph rules used by both the canvas and the server admission gate. */
export interface WorkflowPoint { x: number; y: number }
export interface WorkflowEdge { id: string; from: string; to: string }
export interface WorkflowCanvas { positions: Record<string, WorkflowPoint>; edges: WorkflowEdge[] }
interface GraphStep { id: string; label: string; enabled: boolean; parallelGroup?: string }
interface GraphWorkflow { steps: GraphStep[]; canvas?: WorkflowCanvas }
export interface GraphIssue { message: string; nodeIds: string[]; edgeIds: string[] }

export function orderedWorkflowRounds<T extends GraphStep>(steps: T[]) {
  const rounds: { id: string; steps: T[] }[] = [];
  for (const step of steps) {
    const id = step.parallelGroup ?? step.id;
    if (step.parallelGroup && rounds.at(-1)?.id === id) rounds.at(-1)!.steps.push(step);
    else rounds.push({ id, steps: [step] });
  }
  return rounds;
}

export function analyzeWorkflowGraph(workflow: GraphWorkflow) {
  const issues: GraphIssue[] = [];
  const rounds: string[][] = [];
  const report = (message: string, nodeIds: string[] = [], edgeIds: string[] = []) => issues.push({ message, nodeIds, edgeIds });
  if (!workflow.canvas) return { rounds: orderedWorkflowRounds(workflow.steps).map((round) => round.steps.map((step) => step.id)), issues };
  const { edges } = workflow.canvas;
  const ids = new Set(workflow.steps.map((step) => step.id));
  const seen = new Set<string>();
  for (const step of workflow.steps) {
    if (seen.has(step.id)) report(`步骤 ID 重复：${step.id}`, [step.id]);
    seen.add(step.id);
  }
  const label = (id: string) => workflow.steps.find((step) => step.id === id)?.label ?? id;
  const incoming = new Map([...ids].map((id) => [id, [] as string[]]));
  const outgoing = new Map([...ids].map((id) => [id, [] as string[]]));
  const pairs = new Set<string>(), edgeIds = new Set<string>();
  for (const edge of edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) report("连线引用了不存在的节点，请删除该连线", [edge.from, edge.to], [edge.id]);
    else {
      if (edge.from === edge.to) report(`「${label(edge.from)}」不能连接自身`, [edge.from], [edge.id]);
      outgoing.get(edge.from)!.push(edge.to); incoming.get(edge.to)!.push(edge.from);
    }
    const key = JSON.stringify([edge.from, edge.to]);
    if (pairs.has(key) || edgeIds.has(edge.id)) report("存在重复连线，请只保留一条", [edge.from, edge.to], [edge.id]);
    pairs.add(key); edgeIds.add(edge.id);
  }
  if (issues.length) return { rounds, issues };
  const remaining = new Set(ids), visited = new Set<string>();
  const edgeOrder = [...new Set(edges.flatMap((edge) => [edge.from, edge.to]))];
  while (remaining.size) {
    const layer = [...remaining].filter((id) => incoming.get(id)!.every((from) => visited.has(from))).sort((a, b) => edgeOrder.indexOf(a) - edgeOrder.indexOf(b));
    if (!layer.length) { report("流程存在闭环，不能安排 turn；请删除反向或循环连线", [...remaining], edges.filter((edge) => remaining.has(edge.from) && remaining.has(edge.to)).map((edge) => edge.id)); break; }
    rounds.push(layer);
    layer.forEach((id) => { remaining.delete(id); visited.add(id); });
  }
  if (issues.length) return { rounds, issues };
  const roots = rounds[0] ?? [], ends = [...ids].filter((id) => !outgoing.get(id)!.length);
  if (roots.length !== 1) report("流程必须只有一个入口，存在断开的节点或未连接的分支", roots);
  if (ends.length !== 1) report("流程必须只有一个出口；所有并行分支都需要连到同一汇合节点", ends);
  rounds.forEach((layer) => {
    if (layer.length > 4) report("每个并行组最多包含 4 个节点", layer);
    const gates = layer.filter((id) => ["identify_modpack", "final_mcdr_test"].includes(id));
    if (gates.length && layer.length > 1) report("确认整合包与最终验证必须独占一个 turn", layer);
  });
  return { rounds, issues };
}

/** Normalize only valid topology. Invalid drafts must never silently lose edges. */
export function normalizeGraphWorkflow<T extends GraphWorkflow>(workflow: T): T {
  if (!workflow.canvas) return workflow;
  const { rounds, issues } = analyzeWorkflowGraph(workflow);
  if (issues.length) return workflow;
  const byId = new Map(workflow.steps.map((step) => [step.id, step]));
  const occupied = new Set(byId.keys());
  return { ...workflow, steps: rounds.flatMap((ids, index) => {
    let group = `parallel_turn_${index + 1}`;
    while (occupied.has(group)) group += "_";
    return ids.map((id) => {
      const { parallelGroup: _old, ...step } = byId.get(id)!;
      return ids.length > 1 ? { ...step, parallelGroup: group } : step;
    });
  }) };
}

export function workflowGraphEdges(steps: GraphStep[]): WorkflowEdge[] {
  const rounds = orderedWorkflowRounds(steps);
  return rounds.flatMap((round, index) => round.steps.flatMap((from) => (rounds[index + 1]?.steps ?? []).map((to) => ({
    id: `${from.id}__${to.id}`, from: from.id, to: to.id
  }))));
}

export function workflowGraphLayout(workflow: GraphWorkflow): Record<string, WorkflowPoint> {
  const analysis = analyzeWorkflowGraph(workflow);
  const rounds = analysis.issues.length ? orderedWorkflowRounds(workflow.steps).map((round) => round.steps.map((step) => step.id)) : analysis.rounds;
  return Object.fromEntries(rounds.flatMap((ids, index) => ids.map((id, branch) => [id, { x: (branch - (ids.length - 1) / 2) * 350, y: index * 146 }])));
}

export function withWorkflowCanvas<T extends GraphWorkflow>(workflow: T): T & { canvas: WorkflowCanvas } {
  return { ...workflow, canvas: {
    positions: { ...workflowGraphLayout(workflow), ...workflow.canvas?.positions },
    edges: workflow.canvas?.edges ?? workflowGraphEdges(workflow.steps)
  } };
}
