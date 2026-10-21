import { getSqlite } from "../db/client.js";
import type { ChatCompletionResult, ChatMessageInput, ReasoningEffort } from "../services/modelService.js";
import { createId } from "../utils/id.js";
import { nowIso } from "../utils/time.js";
import type { AgentStatus, AgentWorkflowProgress } from "../types.js";
import type { DeploymentWorkflow } from "../services/deploymentWorkflow.js";

export type ExecutionStatus = Exclude<AgentStatus, "idle"> | "interrupted";

export interface ExecutionCheckpoint {
  messages: ChatMessageInput[];
  step: number;
  result?: ChatCompletionResult;
}

export interface AgentExecution {
  id: string;
  scopeId: string;
  parentTurnId: string | null;
  input: string;
  reasoningEffort: ReasoningEffort;
  modelName: string | null;
  status: ExecutionStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  checkpoint: ExecutionCheckpoint | null;
  capabilities?: string[];
  deploymentWorkflow?: DeploymentWorkflow;
  workflowProgress?: AgentWorkflowProgress;
  /** Absent on legacy turns, whose saved model/tool protocol stays unchanged. */
  workflowScheduling?: 1;
  /** CLI benchmark runs cannot pause for interactive user questions. */
  benchmark?: { mode: "full" | "basic"; askUser: false };
  workflowRun?: {
    id: string;
    roundIndex: number;
    task: string;
    previousTurnId?: string;
    nextTurnId?: string;
    scheduled?: boolean;
  };
  focus?: { focusServerId: string; focusTask: string; focusReason: string };
  handoff?: { status: "pending" | "started" | "blocked" | "failed"; childTurnId?: string; error?: string };
}

export interface ExecutionStep {
  id: string;
  turnId: string;
  index: number;
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  startedAt: string;
  finishedAt?: string;
  result?: ChatCompletionResult;
}

export interface ExecutionToolCall {
  id: string;
  turnId: string;
  stepId: string;
  toolCallId: string;
  name: string;
  arguments: string;
  status: "running" | "completed";
  startedAt: string;
  finishedAt?: string;
  output?: string;
}

/** Synchronous SQLite writes are the durability boundary, before any side effect. */
export class ExecutionStore {
  create(scopeId: string, input: string, reasoningEffort: ReasoningEffort, modelName: string | null, parentTurnId: string | null) {
    const execution: AgentExecution = { id: createId("turn"), scopeId, input, reasoningEffort, modelName, parentTurnId,
      status: "running", error: null, createdAt: nowIso(), updatedAt: nowIso(), checkpoint: null };
    this.save(execution);
    return execution;
  }

  save(turn: AgentExecution) {
    turn.updatedAt = nowIso();
    getSqlite().prepare(`INSERT INTO agent_executions(id, scope_id, parent_turn_id, status, payload) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, payload=excluded.payload`)
      .run(turn.id, turn.scopeId, turn.parentTurnId, turn.status, JSON.stringify(turn));
  }

  get(scopeId: string, id: string): AgentExecution {
    const row = getSqlite().prepare("SELECT payload FROM agent_executions WHERE id=? AND scope_id=?").get(id, scopeId) as { payload: string } | undefined;
    if (!row) throw new Error("执行记录不存在");
    return JSON.parse(row.payload);
  }

  list(scopeId: string): AgentExecution[] {
    return (getSqlite().prepare("SELECT payload FROM agent_executions WHERE scope_id=? ORDER BY rowid DESC LIMIT 100").all(scopeId) as { payload: string }[])
      .map((row) => JSON.parse(row.payload));
  }

  steps(turnId: string): ExecutionStep[] {
    return (getSqlite().prepare("SELECT payload FROM agent_execution_steps WHERE turn_id=? ORDER BY step_index").all(turnId) as { payload: string }[]).map((row) => JSON.parse(row.payload));
  }

  saveStep(step: ExecutionStep) {
    getSqlite().prepare(`INSERT INTO agent_execution_steps(id, turn_id, step_index, payload) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`).run(step.id, step.turnId, step.index, JSON.stringify(step));
  }

  calls(turnId: string): ExecutionToolCall[] {
    return (getSqlite().prepare("SELECT payload FROM agent_execution_tools WHERE turn_id=? ORDER BY rowid").all(turnId) as { payload: string }[]).map((row) => JSON.parse(row.payload));
  }

  saveCall(call: ExecutionToolCall) {
    getSqlite().prepare(`INSERT INTO agent_execution_tools(id, turn_id, payload) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`).run(call.id, call.turnId, JSON.stringify(call));
  }

  /** Called once at database startup, never when a second service object is created. */
  static recoverInterrupted() {
    const db = getSqlite();
    const rows = db.prepare("SELECT payload FROM agent_executions WHERE status IN ('running','thinking','retrying','waiting_confirmation')").all() as { payload: string }[];
    const store = new ExecutionStore();
    for (const row of rows) {
      const turn: AgentExecution = JSON.parse(row.payload);
      turn.status = "interrupted";
      turn.error = "服务重启，执行已暂停；恢复前将检查工具结果是否确定。";
      store.save(turn);
      for (const step of store.steps(turn.id)) {
        if (step.status === "running") {
          step.status = "interrupted";
          store.saveStep(step);
        }
      }
    }
  }
}
