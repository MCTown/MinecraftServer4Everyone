import { eq, inArray, sql } from "drizzle-orm";
import { getDb, getSqlite } from "../db/client.js";
import { agentMessages, globalAgentMessages } from "../db/schema.js";
import type { AgentActivity, AgentConfirmationRequest, AgentDownloadProgress, AgentEvent, AgentFocusInstance, AgentRetryEvent, AgentRole, AgentStatus, AgentToolConfigRequired, ConsoleLogEntry, GlobalAgentMessage, ServerSlotStatus } from "../types.js";
import { createId } from "../utils/id.js";
import { nowIso } from "../utils/time.js";
import { FileService } from "../services/fileService.js";
import { JavaService } from "../services/javaService.js";
import { ModelEmptyResponseError, ModelRemoteError, ModelService, type ChatMessageInput, type ReasoningEffort } from "../services/modelService.js";
import { ProcessManager } from "../services/processManager.js";
import { PromptService } from "../services/promptService.js";
import { ServerService } from "../services/serverService.js";
import { UploadService } from "../services/uploadService.js";
import { ConsoleLogService } from "../services/consoleLogService.js";
import { eventBus } from "../services/eventBus.js";
import { createAgentTools, createGlobalAgentTools, type AgentCapabilityId, type AgentTool } from "./tools.js";
import { ExecutionStore, type AgentExecution } from "./executionStore.js";
import { ToolRuntime, backgroundableTools, type InboxItem } from "./toolRuntime.js";
import { QuestionBroker } from "./questionBroker.js";
import type { AgentQuestionInput } from "../types.js";
import { SessionStore, appendRuntimeContext, compactBoundary } from "./sessionStore.js";
import { installableCapabilities } from "./toolKit.js";
import { defaultDeploymentWorkflow, deploymentRounds, type DeploymentWorkflow } from "../services/deploymentWorkflow.js";
import { buildWorkflowProgress } from "./workflowProgress.js";
import { parseWorkflowToolProgress, workflowUpdatesSchema } from "./workflowToolProgress.js";

/** Conversation id for the dashboard-level agent that spans all instances. */
const GLOBAL_SCOPE_ID = "global";

function isGlobalScope(scopeId: string) {
  return scopeId === GLOBAL_SCOPE_ID;
}

interface PendingConfirmation {
  request: AgentConfirmationRequest;
  resolve: (approved: boolean) => void;
  timeout?: NodeJS.Timeout;
}

interface ActiveRun {
  execution: AgentExecution;
  stepId?: string;
  controller: AbortController;
  responseMessageId: string;
  retryNow?: () => void;
  retry?: AgentRetryEvent;
  activities: Map<string, { content: string; activity: AgentActivity; persistedAt: number }>;
  partialContent: string;
  responseCreatedAt?: string;
  /** Set by focus_instance so the UI can route to the target instance console. */
  focusServerId?: string;
  /** Task text queued for the target instance agent once this run finishes. */
  focusTask?: string;
  focusReason?: string;
}

export class AgentService {
  private readonly questions = new QuestionBroker();

  getPendingQuestion(scopeId: string) { return this.questions.get(scopeId); }
  resolveQuestion(scopeId: string, questionId: string, selected: string[], cancelled = false) {
    return this.questions.answer(scopeId, questionId, selected, cancelled);
  }

  private async askUser(scopeId: string, input: AgentQuestionInput, signal: AbortSignal) {
    const answer = this.questions.ask(scopeId, input, signal);
    this.setStatus(scopeId, "waiting_confirmation");
    try {
      const result = await answer;
      this.saveMessage(scopeId, "user", `【选择题回答】${input.question}\n${result.status === "answered" ? result.selected.join("、") : result.status === "expired" ? "问题已超时，未作选择" : "已取消，未作选择"}`);
      return result;
    } finally {
      if (!signal.aborted) this.setStatus(scopeId, "running");
    }
  }
  private readonly executions = new ExecutionStore();
  private readonly sessions = new SessionStore();
  private readonly compactingScopes = new Set<string>();
  private readonly toolRuntime = new ToolRuntime((scopeId) => this.scheduleInbox(scopeId));
  private readonly inboxScheduled = new Set<string>();
  private statusByServer = new Map<string, AgentStatus>();
  private confirmations = new Map<string, PendingConfirmation>();
  private activeRuns = new Map<string, ActiveRun>();
  private installedCapabilitiesByServer = new Map<string, Set<AgentCapabilityId>>();
  private lastUsageByServer = new Map<string, { actualTokens: number; estimatedTokens: number }>();
  /** Per-conversation model override (model name); falls back to the default config. */
  private modelOverrideByScope = new Map<string, string>();
  private presentation = new Map<string, { downloads: AgentDownloadProgress[]; workflow: AgentEvent["workflow"] | null; toolConfigRequired: AgentEvent["toolConfigRequired"] | null; focus: (AgentFocusInstance & { id: string }) | null }>();
  private acceptedRequests = new Map<string, { content: string; reasoningEffort: ReasoningEffort; turnId: string }>();

  getPresentation(scopeId: string) {
    return structuredClone(this.presentation.get(scopeId) ?? { downloads: [], workflow: this.executions.list(scopeId)[0]?.workflowProgress ?? null, toolConfigRequired: null, focus: null });
  }

  acknowledgeFocus(scopeId: string, id: string) {
    const state = this.presentation.get(scopeId);
    if (state?.focus?.id === id) state.focus = null;
    return { ok: true };
  }

  /** Admission acknowledgement is independent of the lifetime of the HTTP response. */
  async acceptMessage(scopeId: string, requestId: string, content: string, reasoningEffort: ReasoningEffort, benchmark?: { mode: "full" | "basic" }) {
    if (!isGlobalScope(scopeId)) await this.serverService.requireServer(scopeId);
    const key = `${scopeId}:${requestId}`;
    const previous = this.acceptedRequests.get(key);
    if (previous) {
      if (previous.content !== content || previous.reasoningEffort !== reasoningEffort) throw new Error("消息标识已被其他内容使用");
      return { accepted: true, turnId: previous.turnId };
    }
    if (!content.trim() || this.isBusy(scopeId) || this.compactingScopes.has(scopeId)) throw new Error("Agent 忙或消息为空，请稍后重试");
    const completion = this.runScope(scopeId, content, reasoningEffort, undefined, null, false, benchmark);
    const run = this.activeRuns.get(scopeId);
    if (!run) { await completion; throw new Error("任务未能启动"); }
    this.acceptedRequests.set(key, { content, reasoningEffort, turnId: run.execution.id });
    void completion.catch(() => undefined);
    return { accepted: true, turnId: run.execution.id };
  }
  private readonly modelRetryBaseDelayMs = 5000;
  private readonly modelRetryMaxDelayMs = 120000;
  private readonly modelRetryMaxConsecutiveFailures = 5;
  private readonly modelToolResultMaxChars = 12000;
  private readonly contextAutoCompressRatio = 0.7;
  private readonly contextCompressKeepRecentMessages = 6;

  constructor(
    private readonly serverService: ServerService,
    private readonly consoleLogService: ConsoleLogService,
    private readonly fileService: FileService,
    private readonly processManager: ProcessManager,
    private readonly modelService: ModelService,
    private readonly promptService: PromptService,
    private readonly uploadService: UploadService,
    private readonly javaService: JavaService
  ) {}

  getStatus(serverId: string): AgentStatus {
    return this.statusByServer.get(serverId) ?? "idle";
  }

  /** Global conversation status, tracked under the "global" scope id. */
  getGlobalStatus(): AgentStatus {
    return this.statusByServer.get(GLOBAL_SCOPE_ID) ?? "idle";
  }

  isGlobalBusy() {
    return this.isBusy(GLOBAL_SCOPE_ID);
  }

  getGlobalRetry() {
    return this.activeRuns.get(GLOBAL_SCOPE_ID)?.retry ?? null;
  }

  listGlobalMessages(): GlobalAgentMessage[] {
    return this.listScopeMessages(GLOBAL_SCOPE_ID) as GlobalAgentMessage[];
  }

  getPendingGlobalConfirmation() {
    return this.getPendingConfirmation(GLOBAL_SCOPE_ID);
  }

  private rowToScopeMessage(row: typeof agentMessages.$inferSelect | typeof globalAgentMessages.$inferSelect) {
    const focusServerId = "focusServerId" in row ? row.focusServerId : null;
    return {
      id: row.id,
      turnId: row.turnId,
      stepId: row.stepId,
      serverId: "serverId" in row ? row.serverId : "",
      role: row.role as AgentRole,
      content: row.content,
      status: row.status,
      createdAt: row.createdAt,
      activity: row.activity,
      focusServerId
    };
  }

  /** Reads messages for one conversation (instance serverId or the global scope). */
  private listScopeMessages(scopeId: string) {
    const rows = isGlobalScope(scopeId)
      ? getDb().select().from(globalAgentMessages)
        .where(eq(globalAgentMessages.conversationId, GLOBAL_SCOPE_ID))
        .orderBy(globalAgentMessages.createdAt, sql`rowid`).all()
      : getDb().select().from(agentMessages)
        .where(eq(agentMessages.serverId, scopeId))
        .orderBy(agentMessages.createdAt, sql`rowid`).all();
    const messages = rows.map((row) => this.rowToScopeMessage(row)).map((message) => {
      const live = this.activeRuns.get(scopeId)?.activities.get(message.id);
      if (live) return { ...message, content: live.content, activity: live.activity, status: live.activity.status };
      if (message.activity && !message.activity.background && ["running", "waiting_confirmation"].includes(message.activity.status)) {
        return { ...message, status: "cancelled", activity: { ...message.activity, status: "cancelled" as const, error: "服务已重启，本次执行未完成。" } };
      }
      return message;
    });
    const run = this.activeRuns.get(scopeId);
    if (run?.partialContent && !messages.some((message) => message.id === run.responseMessageId)) {
      messages.push({
        id: run.responseMessageId,
        turnId: run.execution.id,
        stepId: run.stepId ?? null,
        serverId: isGlobalScope(scopeId) ? "" : scopeId,
        role: "agent",
        content: run.partialContent,
        status: "running",
        createdAt: run.responseCreatedAt ?? nowIso(),
        activity: null,
        focusServerId: run.focusServerId ?? null
      });
    }
    return messages;
  }

  listMessages(serverId: string) {
    return this.listScopeMessages(serverId);
  }

  getRetry(serverId: string) {
    return this.activeRuns.get(serverId)?.retry ?? null;
  }

  /**
   * Choose which model name subsequent requests in this conversation use. Only
   * the model name changes; connection details stay on the saved config. An empty
   * value clears the override and returns to the default model.
   */
  setModelOverride(scopeId: string, modelName: string | undefined) {
    const trimmed = modelName?.trim();
    if (trimmed) this.modelOverrideByScope.set(scopeId, trimmed);
    else this.modelOverrideByScope.delete(scopeId);
    this.emit(scopeId, { type: "model", modelName: trimmed || null });
    return { modelName: trimmed || this.modelService.getDecryptedDefault()?.modelName || null };
  }

  getModelOverride(scopeId: string) {
    return this.modelOverrideByScope.get(scopeId) ?? null;
  }

  /** Active model name for a conversation, after applying any per-scope override. */
  getActiveModelName(scopeId: string) {
    return this.modelOverrideByScope.get(scopeId) || this.modelService.getDecryptedDefault()?.modelName || null;
  }

  async getContextUsage(serverId: string) {
    // Build messages exactly as runAgent does to get accurate token count
    const systemPrompt = await this.promptService.getEffectivePrompt(serverId, this.activeRuns.get(serverId)?.execution.deploymentWorkflow);
    const runtimeContext = await this.buildRuntimeContext(serverId);
    const messages = this.buildContextMessages(serverId, systemPrompt, runtimeContext);
    
    // Include tools definitions in the estimate
    const tools = this.withBackgroundParameters(this.createTools(serverId, new AbortController().signal));
    const toolDefinitions = tools.map((tool) => tool.definition);

    const estimatedTokens = this.estimateModelContextTokens(messages, toolDefinitions);
    const contextSizeK = this.modelService.getContextSizeK();
    const maxTokens = contextSizeK * 1000;
    const usedTokens = this.calibratedContextTokens(serverId, estimatedTokens, maxTokens);    const remainingTokens = Math.max(0, maxTokens - usedTokens);
    const remainingRatio = maxTokens > 0 ? remainingTokens / maxTokens : 0;
    return {
      contextSizeK,
      maxTokens,
      usedTokens,
      remainingTokens,
      remainingRatio,
      remainingPercent: Math.round(remainingRatio * 100),
      cache: this.sessions.cacheUsage(serverId)
    };
  }

  private calibratedContextTokens(serverId: string, estimatedTokens: number, maxTokens: number) {
    const lastUsage = this.lastUsageByServer.get(serverId);
    if (!lastUsage || lastUsage.estimatedTokens <= 0) {
      return Math.min(maxTokens, Math.max(0, Math.ceil(estimatedTokens)));
    }
    const ratio = lastUsage.actualTokens / lastUsage.estimatedTokens;
    return Math.min(maxTokens, Math.max(0, Math.round(estimatedTokens * ratio)));
  }

  async sendMessage(serverId: string, content: string, reasoningEffort: ReasoningEffort = "high") {
    await this.serverService.requireServer(serverId);
    return this.runScope(serverId, content, reasoningEffort);
  }

  /**
   * Entry point for the dashboard-level agent. Unlike an instance conversation
   * there is no bound server: the agent lists instances and calls
   * focus_instance to hand the task to a specific instance console.
   */
  async sendGlobalMessage(content: string, reasoningEffort: ReasoningEffort = "high") {
    return this.runScope(GLOBAL_SCOPE_ID, content, reasoningEffort);
  }

  listExecutions(scopeId: string) {
    return this.executions.list(scopeId).map(({ checkpoint, ...turn }) => ({ ...turn, resumable: this.canResume(turn, Boolean(checkpoint || turn.workflowRun)) }));
  }

  listToolJobs(scopeId: string) { return this.toolRuntime.jobs(scopeId); }
  listInbox(scopeId: string) { return this.toolRuntime.inbox(scopeId); }
  backgroundTools(scopeId: string) { return this.toolRuntime.background(scopeId); }
  updateInbox(scopeId: string, id: string, delivery: InboxItem["delivery"]) { this.toolRuntime.updateInbox(scopeId, id, delivery); }
  cancelInbox(scopeId: string, id: string) { this.toolRuntime.cancelInbox(scopeId, id); }
  steer(scopeId: string, text: string, delivery: InboxItem["delivery"] = "steer") {
    if (!text.trim()) throw new Error("消息内容不能为空");
    const item = this.toolRuntime.enqueue(scopeId, text.trim(), delivery);
    this.toolRuntime.notify(scopeId);
    return item;
  }

  /** Invoked after bootstrap; only persisted steer inputs wake an idle conversation. */
  startInbox() {
    // A next turn is written before its predecessor is completed. Recover only
    // turns not yet started; uncertain side effects still require explicit resume.
    const queued = getSqlite().prepare("SELECT payload FROM agent_executions ORDER BY rowid").all() as { payload: string }[];
    for (const row of queued) {
      const turn = JSON.parse(row.payload) as AgentExecution;
      if (turn.workflowRun?.scheduled && this.executions.list(turn.scopeId)[0]?.id === turn.id
        && this.executions.get(turn.scopeId, turn.workflowRun.previousTurnId!).status === "completed" && !this.isBusy(turn.scopeId)) {
        void this.runScope(turn.scopeId, turn.input, turn.reasoningEffort, turn, null, true).catch(() => undefined);
      }
    }
    const scopes = getSqlite().prepare("SELECT DISTINCT scope_id AS scopeId FROM agent_inbox WHERE state='pending'").all() as { scopeId: string }[];
    for (const { scopeId } of scopes) this.scheduleInbox(scopeId);
  }

  private scheduleInbox(scopeId: string) {
    if (this.inboxScheduled.has(scopeId) || this.isBusy(scopeId)) return;
    // Never let a late job result bypass a failed/cancelled workflow turn.
    if (this.executions.list(scopeId)[0]?.workflowRun) return;
    if (!this.resolveModelConfig(scopeId)) return;
    if (!this.toolRuntime.inbox(scopeId).some((item) => item.delivery === "steer")) return;
    this.inboxScheduled.add(scopeId);
    queueMicrotask(() => {
      this.inboxScheduled.delete(scopeId);
      if (this.isBusy(scopeId) || !this.resolveModelConfig(scopeId)) return;
      if (this.executions.list(scopeId)[0]?.workflowRun) return;
      const item = this.toolRuntime.inbox(scopeId).find((entry) => entry.delivery === "steer");
      if (!item) return;
      // Synthetic continuation is not a user message. Admission is committed with
      // its first checkpoint; failures leave the item durable for explicit retry.
      void this.runScope(scopeId, "处理 inbox 中的新结果或补充信息。", "high", undefined, null, true)
        .catch(() => undefined);
    });
  }

  private consumeInbox(scopeId: string, messages: ChatMessageInput[], step: number, allowQueue: boolean) {
    const run = this.activeRuns.get(scopeId)!;
    const items = this.toolRuntime.inbox(scopeId).filter((item) =>
      (allowQueue || item.delivery === "steer" || (run.execution.workflowRun && item.sourceTurnId === run.execution.id))
      && (!run.execution.workflowRun || !item.sourceTurnId || item.sourceTurnId === run.execution.id));
    if (!items.length) return false;
    getDb().transaction(() => {
      for (const item of items) {
        messages.push({ role: "user", content: `【Inbox synthetic input · ${item.id}】\n${item.text}` });
        this.saveMessage(scopeId, "system", `【Inbox synthetic input · ${item.id}】\n${item.text}`);
        this.toolRuntime.delivered(item, run.execution.id);
      }
      run.execution.checkpoint = { messages: structuredClone(messages), step };
      this.sessions.commit(scopeId, messages);
      this.executions.save(run.execution);
    });
    this.emit(scopeId, { type: "inbox_updated" });
    return true;
  }

  private canResume(turn: Pick<AgentExecution, "id" | "status" | "scopeId">, hasCheckpoint: boolean) {
    return hasCheckpoint && ["interrupted", "failed"].includes(turn.status)
      && this.executions.list(turn.scopeId)[0]?.id === turn.id
      && !this.executions.calls(turn.id).some((call) => call.status === "running");
  }

  getExecution(scopeId: string, turnId: string) {
    const { checkpoint, ...turn } = this.executions.get(scopeId, turnId);
    return { ...turn, resumable: this.canResume(turn, Boolean(checkpoint || turn.workflowRun)), steps: this.executions.steps(turnId), toolCalls: this.executions.calls(turnId) };
  }

  async resumeExecution(scopeId: string, turnId: string) {
    const turn = this.executions.get(scopeId, turnId);
    if (turn.status !== "interrupted" && turn.status !== "failed") throw new Error("只能恢复中断或失败的执行");
    if (!turn.checkpoint && !turn.workflowRun) throw new Error("没有可恢复的检查点");
    if (this.executions.list(scopeId)[0]?.id !== turn.id) throw new Error("此会话已有后续任务，旧检查点可能过期，请发起新任务");
    if (this.executions.calls(turnId).some((call) => call.status === "running")) {
      throw new Error("存在执行结果不确定的工具调用，请人工核对副作用后发起新任务；禁止自动重放");
    }
    if (!isGlobalScope(scopeId)) await this.serverService.requireServer(scopeId);
    return this.runScope(scopeId, turn.input, turn.reasoningEffort, turn);
  }

  private async runScope(scopeId: string, content: string, reasoningEffort: ReasoningEffort, resumed?: AgentExecution, parentTurnId: string | null = null, synthetic = false, benchmark?: { mode: "full" | "basic" }) {
    const normalizedContent = content.trim();
    if (!normalizedContent) throw new Error("消息内容不能为空");
    if (this.isBusy(scopeId) || this.compactingScopes.has(scopeId)) {
      throw new Error("Agent 正在处理上一条任务，请等待完成或先处理确认弹窗");
    }

    const responseMessageId = createId("msg");
    const controller = new AbortController();
    const execution = resumed ?? this.executions.create(scopeId, normalizedContent, reasoningEffort, this.getActiveModelName(scopeId), parentTurnId);
    if (!resumed) execution.workflowScheduling = 1;
    if (!resumed && benchmark) execution.benchmark = { ...benchmark, askUser: false };
    execution.status = "running";
    execution.error = null;
    if (execution.workflowRun) execution.workflowRun.scheduled = false;
    this.executions.save(execution);
    this.activeRuns.set(scopeId, { execution, controller, responseMessageId, activities: new Map(), partialContent: "" });
    if (parentTurnId) {
      const parent = this.executions.get(GLOBAL_SCOPE_ID, parentTurnId);
      parent.handoff = { status: "started", childTurnId: execution.id };
      this.executions.save(parent);
    }
    if (execution.focus) Object.assign(this.activeRuns.get(scopeId)!, execution.focus);
    if (execution.capabilities) this.installedCapabilitiesByServer.set(scopeId, new Set(execution.capabilities as AgentCapabilityId[]));
    if (!synthetic) this.toolRuntime.activate(scopeId);
    if (!resumed && !synthetic) this.saveMessage(scopeId, "user", normalizedContent);
    if (execution.workflowRun?.previousTurnId && !execution.checkpoint) this.saveMessage(scopeId, "system", `【流程自动推进】${this.workflowTurnInstruction(execution)}`);
    this.presentation.set(scopeId, { downloads: [], workflow: execution.workflowProgress ?? null, toolConfigRequired: null, focus: this.presentation.get(scopeId)?.focus ?? null });
    if (execution.workflowRun?.previousTurnId && !execution.checkpoint) this.initializeWorkflowTurn(execution);
    this.appendAgentConsoleLog(scopeId, `开始任务：${this.formatConsolePayload(normalizedContent)}`);
    this.setStatus(scopeId, "thinking");
    let nextWorkflowTurn: AgentExecution | undefined;
    try {
      const response = await this.runAgent(scopeId, normalizedContent, reasoningEffort, responseMessageId, controller.signal);
      this.throwIfAborted(controller.signal);
      if (execution.workflowRun) nextWorkflowTurn = this.prepareNextWorkflowTurn(execution);
      const focusServerId = this.activeRuns.get(scopeId)?.focusServerId ?? null;
      this.saveMessage(scopeId, "agent", response, "completed", responseMessageId, focusServerId);
      this.emit(scopeId, { type: "message", messageId: responseMessageId, content: response, status: "completed" });
      this.throwIfAborted(controller.signal);
      if (nextWorkflowTurn) {
        execution.status = "completed";
        this.executions.save(execution);
      } else this.setStatus(scopeId, "completed");
      this.appendAgentConsoleLog(scopeId, "任务完成");
      if (!nextWorkflowTurn) this.emit(scopeId, { type: "done", status: "completed" });
      return response;
    } catch (error) {
      if (execution.workflowProgress?.turn?.waitingForJobs) this.emit(scopeId, { type: "workflow_progress", workflow: {
        ...execution.workflowProgress, turn: { ...execution.workflowProgress.turn, waitingForJobs: false }
      } });
      this.finishPendingActivities(scopeId,
        controller.signal.aborted || this.isAbortError(error) || this.isConfirmationRejection(error) ? "cancelled" : "failed",
        error instanceof Error ? error.message : String(error));
      const focusServerId = this.activeRuns.get(scopeId)?.focusServerId ?? null;
      // Keep already streamed narration when the terminal response is an error or cancellation.
      const partialContent = this.activeRuns.get(scopeId)?.partialContent;
      if (partialContent?.trim()) {
        const partialId = createId("msg");
        this.saveMessage(scopeId, "agent", partialContent, "completed", partialId, focusServerId);
        this.emit(scopeId, { type: "message", messageId: partialId, content: partialContent, status: "completed" });
      }
      if (this.isAbortError(error) || controller.signal.aborted) {
        const response = "Agent 操作已中断";
        this.saveMessage(scopeId, "agent", response, "cancelled", responseMessageId, focusServerId);
        this.emit(scopeId, { type: "message", messageId: responseMessageId, content: response, status: "cancelled" });
        this.setStatus(scopeId, "cancelled");
        this.appendAgentConsoleLog(scopeId, "任务已中断");
        this.emit(scopeId, { type: "done", status: "cancelled" });
        return response;
      }
      if (this.isConfirmationRejection(error)) {
        const response = error instanceof Error ? error.message : String(error);
        this.saveMessage(scopeId, "agent", response, "cancelled", responseMessageId, focusServerId);
        this.emit(scopeId, { type: "message", messageId: responseMessageId, content: response, status: "cancelled" });
        this.setStatus(scopeId, "cancelled");
        this.appendAgentConsoleLog(scopeId, "任务已取消：用户拒绝或未确认操作。");
        this.emit(scopeId, { type: "done", status: "cancelled" });
        return response;
      }
      const message = error instanceof Error ? error.message : String(error);
      execution.error = message;
      const response = `执行失败：${message}`;
      this.saveMessage(scopeId, "agent", response, "failed", responseMessageId, focusServerId);
      this.emit(scopeId, { type: "error", messageId: responseMessageId, content: response, status: "failed" });
      this.setStatus(scopeId, "failed");
      this.appendAgentConsoleLog(scopeId, `任务失败：${message}`);
      this.emit(scopeId, { type: "done", status: "failed" });
      return response;
    } finally {
      const status = this.getStatus(scopeId) === "failed" ? "failed" : "cancelled";
      this.finishPendingActivities(scopeId, status);
      const run = this.activeRuns.get(scopeId);
      const handoff = run?.focusServerId && run.focusTask
        ? { focusServerId: run.focusServerId, focusTask: run.focusTask, focusReason: run.focusReason ?? "" }
        : null;
      this.activeRuns.delete(scopeId);
      if (nextWorkflowTurn && !controller.signal.aborted && execution.status === "completed") {
        // No public idle/completed event between rounds: the client stays busy.
        this.statusByServer.set(scopeId, "completed");
        void this.runScope(scopeId, nextWorkflowTurn.input, reasoningEffort, nextWorkflowTurn, null, true).catch(() => undefined);
      } else if (nextWorkflowTurn) {
        nextWorkflowTurn.status = "cancelled";
        nextWorkflowTurn.workflowRun!.scheduled = false;
        this.executions.save(nextWorkflowTurn);
      }
      // Start the instance agent after this run fully completes, so the two
      // conversations never interleave their status events.
      if (handoff && this.getStatus(scopeId) === "completed") void this.dispatchFocusHandoff(handoff, execution.id);
      if (!nextWorkflowTurn && this.getStatus(scopeId) === "completed") this.scheduleInbox(scopeId);
    }
  }

  private workflowTurnInstruction(turn: AgentExecution) {
    const rounds = deploymentRounds(turn.deploymentWorkflow!);
    const round = rounds[turn.workflowRun!.roundIndex];
    if (!round) throw new Error("流程轮次不存在，不能自动推进");
    return [
      `【系统流程调度 · Turn ${turn.workflowRun!.roundIndex + 1}/${rounds.length}】`,
      `本次任务：${turn.workflowRun!.task}`,
      `本轮节点：${round.steps.map((step) => `${step.label} [${step.id}]`).join(" ∥ ")}`,
      round.steps.length > 1 ? "这些节点共用一个 turn，独立任务可用 background=true 重叠执行，所有分支必须在本轮汇合。" : "本轮只执行这一个节点。",
      "不得执行后续轮次。每个工具调用必须携带 workflowStepId=本轮所属节点 ID（进度工具用 stepId）。先更新本轮节点 running，依据真实结果更新 completed/failed。后台回执不算完成；等待系统交付结果后核验并汇总。本轮全部完成后结束回复，系统自动启动下一个独立 turn。信息不足或失败时说明原因，不得虚报完成。"
    ].join("\n");
  }

  private beginDeploymentWorkflow(scopeId: string) {
    if (isGlobalScope(scopeId)) throw new Error("请先 focus_instance，再由实例 Agent 启动流程");
    const turn = this.activeRuns.get(scopeId)!.execution;
    if (!turn.workflowRun) {
      if (this.toolRuntime.hasLiveJobs(scopeId)) throw new Error("仍有其他工具执行中，请先等待结果再开始流程");
      turn.workflowRun = { id: turn.id, roundIndex: 0, task: turn.input };
      turn.workflowProgress = undefined;
      this.initializeWorkflowTurn(turn);
    }
    return this.workflowTurnInstruction(turn);
  }

  private initializeWorkflowTurn(turn: AgentExecution) {
    const rounds = deploymentRounds(turn.deploymentWorkflow!);
    const round = rounds[turn.workflowRun!.roundIndex]!;
    let progress = turn.workflowProgress ?? null;
    for (const step of round.steps) progress = buildWorkflowProgress(turn.deploymentWorkflow!, progress, {
      stepId: step.id, status: "running", progress: 0, detail: "等待本轮执行与验证", title: "整合包服务端部署流程"
    });
    this.emit(turn.scopeId, { type: "workflow_progress", workflow: { ...progress!, turn: {
      runId: turn.workflowRun!.id, turnId: turn.id, index: turn.workflowRun!.roundIndex, total: rounds.length, stepIds: round.steps.map((step) => step.id)
    } } });
  }

  private workflowJobProblems(turn: AgentExecution, stepId?: string) {
    // Synchronous background-capable tools already returned their result to the
    // model. Only detached jobs need a join barrier; otherwise a failed,
    // non-background diagnostic command poisons the turn forever.
    const jobs = this.toolRuntime.turnJobs(turn.scopeId, turn.id)
      .filter((job) => job.background && (!stepId || job.arguments.workflowStepId === stepId));
    // A successful retry of the exact same operation supersedes its failure.
    const canonical = (value: unknown): string => {
      if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
      if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
      return JSON.stringify(value);
    };
    const latest = new Map<string, typeof jobs[number]>();
    for (const job of jobs) latest.set(`${job.name}:${canonical(job.arguments)}`, job);
    // Even identical concurrent operations must ALL stop before we can join.
    return [...jobs.filter((job) => job.status === "running"), ...latest.values()].filter((job) => job.status !== "completed");
  }

  private unreadWorkflowJobs(turn: AgentExecution, stepId?: string) {
    const delivered = new Set(this.toolRuntime.inbox(turn.scopeId, false).filter((item) => item.deliveredTurnId === turn.id).map((item) => item.sourceJobId));
    return this.toolRuntime.turnJobs(turn.scopeId, turn.id).filter((job) => job.background && !delivered.has(job.id) && (!stepId || job.arguments.workflowStepId === stepId));
  }

  private guardWorkflowTool(scopeId: string, name: string, args: Record<string, unknown>) {
    const turn = this.activeRuns.get(scopeId)?.execution;
    if (turn?.workflowScheduling && !turn.workflowRun && name === "update_agent_workflow_progress") throw new Error("必须先调用 begin_deployment_workflow 启动流程调度；不能跳过 turn 门禁直接更新部署进度");
    if (!turn?.workflowRun || name === "begin_deployment_workflow") return;
    const round = deploymentRounds(turn.deploymentWorkflow!)[turn.workflowRun.roundIndex]!;
    const id = name === "update_agent_workflow_progress" ? args.stepId : args.workflowStepId;
    if (!round.steps.some((step) => step.id === id)) throw new Error("Turn 门禁：只能执行/更新本轮节点，工具必须携带本轮 workflowStepId，不能提前或回写其他轮次");
    const stageTools: Record<string, string[]> = {
      prepare_server_slot: ["save_upload_to_server_slot", "download_https_file_to_server_slot", "download_curseforge_server_pack_to_server_slot", "download_modrinth_server_pack_to_server_slot"],
      check_java_dependencies: ["install_java_version"],
      extract_to_workspace: ["extract_server_slot_to_workspace", "materialize_curseforge_manifest_pack_from_server_slot", "extract_server_zip"],
      configure_python: ["configure_builtin_python_environment"]
    };
    const required = Object.entries(stageTools).find(([, tools]) => tools.includes(name))?.[0];
    if (required && required !== id) throw new Error(`Turn 门禁：${name} 只能在 ${required} 节点执行`);
    if (name === "deploy_mrpack_server_from_server_slot" && id !== "extract_to_workspace") throw new Error("Turn 门禁：mrpack 部署只能在 extract_to_workspace 节点执行");
    if (["setup_forge_server", "setup_neoforge_server"].includes(name) && id !== "extract_to_workspace") throw new Error("Turn 门禁：Loader 安装只能在 extract_to_workspace 节点执行");
    if (id === "identify_modpack" && !["ask_user", "web_search", "fetch_web_page", "list_uploaded_files", "get_server_slot_status", "list_server_files", "read_server_text_file", "get_current_server_config", "update_agent_workflow_progress", "list_modrinth_modpack_versions", "fetch_https_resource_summary", "summarize_modpack_deployment_info"].includes(name) && !name.startsWith("search_") && !name.startsWith("get_modrinth_") && !name.startsWith("get_curseforge_")) {
      throw new Error("确认门禁：本轮仅允许查询与请求用户确认，不能部署或启动");
    }
    if (name === "update_agent_workflow_progress" && args.status === "completed") {
      if (id === "identify_modpack" && turn.benchmark?.askUser !== false && !this.executions.calls(turn.id).some((call) => call.name === "ask_user" && call.output?.includes('"status":"answered"'))) {
        throw new Error("用户尚未通过 ask_user 明确确认整合包及版本，本轮不能完成");
      }
      if (this.workflowJobProblems(turn, String(id)).length) throw new Error("Turn 尚未收束：此节点工具仍在执行或失败/中断，后台回执不代表完成");
      if (this.unreadWorkflowJobs(turn, String(id)).length) throw new Error("此节点后台结果尚未送达模型，必须先读取结果再完成节点");
    }
  }

  private assertWorkflowRoundComplete(turn: AgentExecution) {
    const round = deploymentRounds(turn.deploymentWorkflow!)[turn.workflowRun!.roundIndex]!;
    if (this.workflowJobProblems(turn).length) throw new Error("本轮后台任务失败或中断，流程未收束，未启动下一 turn。请检查实际结果后恢复本轮");
    const unfinished = round.steps.filter((step) => turn.workflowProgress?.steps.find((item) => item.id === step.id)?.status !== "completed");
    if (unfinished.length) throw new Error(`本轮节点尚未完成：${unfinished.map((step) => step.label).join("、")}。未启动下一 turn，请补充信息或恢复本轮`);
    if (this.unreadWorkflowJobs(turn).length) throw new Error("本轮后台结果尚未读取，不能推进下一 turn");
  }

  private prepareNextWorkflowTurn(turn: AgentExecution) {
    this.assertWorkflowRoundComplete(turn);
    const rounds = deploymentRounds(turn.deploymentWorkflow!);
    if (turn.workflowRun!.roundIndex + 1 >= rounds.length) return undefined;
    return getSqlite().transaction(() => {
      const next = this.executions.create(turn.scopeId, turn.workflowRun!.task, turn.reasoningEffort, turn.modelName, null);
      next.deploymentWorkflow = structuredClone(turn.deploymentWorkflow);
      next.workflowProgress = structuredClone(turn.workflowProgress);
      next.capabilities = turn.capabilities;
      next.workflowScheduling = turn.workflowScheduling;
      next.benchmark = turn.benchmark;
      next.workflowRun = { id: turn.workflowRun!.id, task: turn.workflowRun!.task, roundIndex: turn.workflowRun!.roundIndex + 1, previousTurnId: turn.id, scheduled: true };
      next.status = "interrupted";
      turn.workflowRun!.nextTurnId = next.id;
      turn.status = "completed";
      this.executions.save(turn);
      this.executions.save(next);
      return next;
    })();
  }

  cancel(serverId: string) {
    const cancelledJobs = this.toolRuntime.cancelScope(serverId);
    const run = this.activeRuns.get(serverId);
    if (!run) {
      if (this.isBusy(serverId)) this.setStatus(serverId, "cancelled");
      return { cancelled: cancelledJobs > 0 };
    }
    run.controller.abort();
    for (const [confirmationId, pending] of this.confirmations.entries()) {
      if (pending.request.serverId !== serverId) continue;
      clearTimeout(pending.timeout);
      this.confirmations.delete(confirmationId);
      pending.resolve(false);
      this.emit(serverId, { type: "confirmation_resolved", confirmationId, approved: false });
    }
    this.emit(serverId, { type: "log", content: "用户已请求中断当前 Agent 操作。" });
    this.appendAgentConsoleLog(serverId, "用户已请求中断当前 Agent 操作。");
    return { cancelled: true };
  }

  retryNow(serverId: string) {
    const run = this.activeRuns.get(serverId);
    if (!run?.retryNow) return { retried: false };
    run.retryNow();
    run.retry = undefined;
    this.emit(serverId, { type: "retry_cleared", status: "running" });
    this.appendAgentConsoleLog(serverId, "用户已请求立即重试模型接口。");
    return { retried: true };
  }

  async clearContext(serverId: string) {
    await this.serverService.requireServer(serverId);
    return this.clearScopeContext(serverId);
  }

  async clearGlobalContext() {
    return this.clearScopeContext(GLOBAL_SCOPE_ID);
  }

  private async clearScopeContext(scopeId: string) {
    if (this.compactingScopes.has(scopeId)) throw new Error("此会话正在压缩上下文，请等待完成后再清除");
    if (this.toolRuntime.hasLiveJobs(scopeId)) throw new Error("仍有工具正在执行，请先中断并等待工具结束后再清除上下文");
    if (this.isBusy(scopeId)) {
      throw new Error("Agent 正在处理任务，请先中断或等待完成后再清除上下文");
    }
    for (const [confirmationId, pending] of this.confirmations.entries()) {
      if (pending.request.serverId !== scopeId) continue;
      clearTimeout(pending.timeout);
      this.confirmations.delete(confirmationId);
      pending.resolve(false);
      this.emit(scopeId, { type: "confirmation_resolved", confirmationId, approved: false });
    }
    if (isGlobalScope(scopeId)) {
      getDb().delete(globalAgentMessages).where(eq(globalAgentMessages.conversationId, GLOBAL_SCOPE_ID)).run();
    } else {
      getDb().delete(agentMessages).where(eq(agentMessages.serverId, scopeId)).run();
    }
    this.lastUsageByServer.delete(scopeId);
    this.sessions.clear(scopeId);
    this.presentation.delete(scopeId);
    this.setStatus(scopeId, "idle");
    return { ok: true };
  }

  /** Context accounting for the global conversation (no bound server). */
  async getGlobalContextUsage() {
    const systemPrompt = await this.promptService.getEffectivePrompt(undefined, this.activeRuns.get(GLOBAL_SCOPE_ID)?.execution.deploymentWorkflow);
    const runtimeContext = await this.buildGlobalRuntimeContext();
    const messages = this.buildContextMessages(GLOBAL_SCOPE_ID, systemPrompt, runtimeContext);
    const toolDefinitions = this.withBackgroundParameters(this.createGlobalTools(new AbortController().signal)).map((tool) => tool.definition);
    const estimatedTokens = this.estimateModelContextTokens(messages, toolDefinitions);
    const contextSizeK = this.modelService.getContextSizeK();
    const maxTokens = contextSizeK * 1000;
    const usedTokens = this.calibratedContextTokens(GLOBAL_SCOPE_ID, estimatedTokens, maxTokens);
    const remainingTokens = Math.max(0, maxTokens - usedTokens);
    const remainingRatio = maxTokens > 0 ? remainingTokens / maxTokens : 0;
    return {
      contextSizeK,
      maxTokens,
      usedTokens,
      remainingTokens,
      remainingRatio,
      remainingPercent: Math.round(remainingRatio * 100),
      cache: this.sessions.cacheUsage(GLOBAL_SCOPE_ID)
    };
  }

  releaseServer(serverId: string) {
    this.presentation.delete(serverId);
    this.questions.cancel(serverId);
    this.statusByServer.delete(serverId);
    this.installedCapabilitiesByServer.delete(serverId);
    this.lastUsageByServer.delete(serverId);
    for (const [confirmationId, pending] of this.confirmations.entries()) {
      if (pending.request.serverId !== serverId) continue;
      clearTimeout(pending.timeout);
      this.confirmations.delete(confirmationId);
      pending.resolve(false);
    }
  }

  private buildContextMessages(scopeId: string, systemPrompt: string, runtimeContext: string): ChatMessageInput[] {
    const messages = this.sessions.messages(scopeId);
    const system = this.composeSystemPrompt(systemPrompt);
    if (messages.length === 0) messages.push({ role: "system", content: system });
    // A real policy change deliberately starts a new cache series. Never conceal
    // a changed safety policy in an untrusted runtime-context message.
    else if (messages[0]?.content !== system) messages[0] = { role: "system", content: system };
    if (!this.sessions.exists(scopeId)) messages.push(...this.listScopeMessages(scopeId)
      .filter((message) => message.role !== "system" || message.content.startsWith("【Inbox synthetic input ·"))
      .map<ChatMessageInput>((message) => ({
        role: message.role === "agent" ? "assistant" as const : "user" as const,
        content: message.content
      })));
    appendRuntimeContext(messages, runtimeContext);
    return messages;
  }

  private composeSystemPrompt(prompt: string) {
    return `${prompt}\n\n${this.agentToolAvailabilityInstructions()}\n\n${this.agentRecoveryInstructions()}`;
  }

  async previewSystemPrompt(workflow: DeploymentWorkflow, serverId?: string) {
    return this.composeSystemPrompt(await this.promptService.getEffectivePrompt(serverId, workflow));
  }

  async compressContext(serverId: string) {
    await this.serverService.requireServer(serverId);
    if (this.isBusy(serverId)) {
      throw new Error("Agent 正在处理任务，请先等待完成或中断后再压缩上下文");
    }
    return this.compressContextInternal(serverId);
  }

  async compressGlobalContext() {
    if (this.isBusy(GLOBAL_SCOPE_ID)) {
      throw new Error("Agent 正在处理任务，请先等待完成或中断后再压缩上下文");
    }
    return this.compressContextInternal(GLOBAL_SCOPE_ID);
  }

  private async compressContextInternal(scopeId: string) {
    const messages = this.sessions.messages(scopeId);
    if (messages.length > 1) {
      const model = this.resolveModelConfig(scopeId);
      if (!model) throw new Error("未配置模型，无法压缩上下文");
      return this.compactSession(scopeId, messages, model);
    }
    const rows = this.listScopeMessages(scopeId).filter((message) => message.role !== "system");
    if (rows.length <= this.contextCompressKeepRecentMessages) {
      return { ok: true, compressed: 0, reason: "历史消息较少，无需压缩" };
    }
    const modelConfig = this.resolveModelConfig(scopeId);
    if (!modelConfig) {
      throw new Error("未配置模型，无法压缩上下文");
    }
    const keepRecent = this.contextCompressKeepRecentMessages;
    const toCompress = rows.slice(0, -keepRecent);
    const summary = await this.summarizeConversation(modelConfig, toCompress);
    const compressedIds = toCompress.map((message) => message.id);
    const createdAt = toCompress[0]?.createdAt ?? nowIso();
    const summaryId = createId("msg");
    if (isGlobalScope(scopeId)) {
      const summaryMessage: typeof globalAgentMessages.$inferInsert = {
        id: summaryId,
        conversationId: GLOBAL_SCOPE_ID,
        role: "user",
        content: summary,
        status: null,
        createdAt
      };
      getDb().transaction((tx) => {
        tx.delete(globalAgentMessages).where(inArray(globalAgentMessages.id, compressedIds)).run();
        tx.insert(globalAgentMessages).values(summaryMessage).run();
      });
    } else {
      const summaryMessage: typeof agentMessages.$inferInsert = {
        id: summaryId,
        serverId: scopeId,
        role: "user",
        content: summary,
        status: null,
        createdAt
      };
      getDb().transaction((tx) => {
        tx.delete(agentMessages).where(inArray(agentMessages.id, compressedIds)).run();
        tx.insert(agentMessages).values(summaryMessage).run();
      });
    }
    this.lastUsageByServer.delete(scopeId);
    this.trace(scopeId, `已压缩 ${toCompress.length} 条历史消息为一条摘要，保留最近 ${keepRecent} 条。`);
    return { ok: true, compressed: toCompress.length, summary };
  }

  private async summarizeConversation(modelConfig: NonNullable<ReturnType<ModelService["getDecryptedDefault"]>>, messages: Array<{ role: AgentRole; content: string }>) {
    const history = messages.map<ChatMessageInput>((message) => ({
      role: message.role === "agent" ? "assistant" as const : "user" as const,
      content: message.content
    }));
    const result = await this.modelService.chatCompletionResult({
      baseUrl: modelConfig.baseUrl,
      modelName: modelConfig.modelName,
      apiKey: modelConfig.apiKey,
      apiType: modelConfig.apiType,
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: "你是对话压缩助手。请把以下 Agent 与用户的对话历史压缩成简洁的中文摘要，保留：当前任务目标、已完成的步骤与结果、关键配置（版本、内存、路径、命令）、遇到的问题与结论、待办事项。不要添加原文没有的信息。直接输出摘要正文。"
        },
        ...history
      ]
    });
    const summary = (result.content || "").trim();
    if (!summary) {
      throw new Error("模型未返回有效的压缩摘要");
    }
    return `[历史摘要] 为节省上下文，以下为 ${messages.length} 条早期对话的压缩摘要：\n${summary}`;
  }

  private async compactSession(scopeId: string, messages: ChatMessageInput[], model: NonNullable<ReturnType<ModelService["getDecryptedDefault"]>>) {
    if (this.compactingScopes.has(scopeId)) throw new Error("此会话正在压缩上下文");
    this.compactingScopes.add(scopeId);
    try {
    const header = this.sessions.header(scopeId);
    const boundary = compactBoundary(messages, this.getModelContextMaxEstimatedTokens() * 0.16, (text) => this.estimateTextTokens(text));
    if (boundary <= 1) return { ok: true, compressed: 0, reason: "没有可安全压缩的历史区间" };
    // The auxiliary request is the original request's exact head, with the
    // instruction appended, not a different system prompt or flattened tools.
    const result = await this.modelService.chatCompletionResult({
      baseUrl: model.baseUrl, modelName: model.modelName, apiKey: model.apiKey, apiType: model.apiType,
      temperature: 0.2,
      reasoningEffort: (header?.reasoningEffort as ReasoningEffort | undefined) ?? "high",
      tools: header?.tools,
      signal: this.activeRuns.get(scopeId)?.controller.signal,
      messages: [...messages.slice(0, boundary), { role: "user", content: "请将以上历史压缩为结构化检查点，保留用户目标与约束、已完成步骤、工具的真实结果、准确路径/版本/命令、失败原因、后台任务、待办及下一步。旧摘要应合并更新。仅输出摘要，不调用工具，不添加原文没有的信息。" }]
    });
    const summary: ChatMessageInput = { role: "user", content: `<compacted-summary>\n${result.content}\n</compacted-summary>` };
    if (!result.content.trim() || result.toolCalls.length || this.estimateTextTokens(JSON.stringify(summary)) >= this.estimateTextTokens(JSON.stringify(messages.slice(1, boundary)))) {
      throw new Error("压缩结果无效或未缩小上下文，保留原始历史");
    }
    const next = [messages[0]!, summary, ...messages.slice(boundary)];
    this.sessions.commit(scopeId, next, true);
    messages.splice(0, messages.length, ...next);
    this.lastUsageByServer.delete(scopeId);
    return { ok: true, compressed: boundary - 1, summary: result.content };
    } finally {
      this.compactingScopes.delete(scopeId);
    }
  }

  getPendingConfirmation(serverId: string) {
    for (const pending of this.confirmations.values()) {
      if (pending.request.serverId === serverId) return pending.request;
    }
    return null;
  }

  resolveConfirmation(serverId: string, confirmationId: string, approved: boolean) {
    const pending = this.confirmations.get(confirmationId);
    if (!pending || pending.request.serverId !== serverId) {
      throw new Error("确认请求不存在或已过期");
    }
    clearTimeout(pending.timeout);
    this.confirmations.delete(confirmationId);
    pending.resolve(approved);
    this.emit(serverId, { type: "confirmation_resolved", confirmationId, approved });
    return { ok: true };
  }

  private resolveModelConfig(scopeId: string) {
    const modelConfig = this.modelService.getDecryptedDefault();
    if (!modelConfig) return null;
    const override = this.modelOverrideByScope.get(scopeId);
    return override ? { ...modelConfig, modelName: override } : modelConfig;
  }

  private async runAgent(serverId: string, input: string, reasoningEffort: ReasoningEffort, responseMessageId: string, signal: AbortSignal) {
    const execution = this.activeRuns.get(serverId)!.execution;
    const global = isGlobalScope(serverId);
    const modelConfig = this.resolveModelConfig(serverId);
    if (modelConfig && execution.modelName) modelConfig.modelName = execution.modelName;
    if (!modelConfig) {
      this.throwIfAborted(signal);
      if (execution.workflowRun) throw new Error("未配置模型，不能自动执行流程 turn");
      return global ? this.globalLocalFallback(input) : this.localFallback(serverId, input);
    }

    this.setStatus(serverId, "running");
    execution.deploymentWorkflow ??= this.promptService.getDeploymentWorkflow?.() ?? defaultDeploymentWorkflow();
    const baseSystemPrompt = await this.promptService.getEffectivePrompt(global ? undefined : serverId, execution.deploymentWorkflow);
    const systemPrompt = execution.benchmark
      ? `${baseSystemPrompt}\n\n# CLI Benchmark Execution\n本次任务通过 benchmark CLI 非交互执行。不得调用 ask_user，也不得等待或伪造用户选择。任务输入中给出的整合包、版本和部署要求视为用户已经确认的事实；在 identify_modpack 阶段依据这些输入完成确认，不要停留等待用户。其他工具、流程节点、验证要求和失败规则保持不变。`
      : baseSystemPrompt;
    const runtimeContext = global ? await this.buildGlobalRuntimeContext() : await this.buildRuntimeContext(serverId);
    const makeTools = () => this.withBackgroundParameters(global ? this.createGlobalTools(signal) : this.createTools(serverId, signal, false, execution.benchmark));
    let messages = execution.checkpoint?.messages ?? this.buildContextMessages(serverId, systemPrompt, runtimeContext);
    if (!execution.checkpoint && this.sessions.exists(serverId)) {
      // The current user's UI bubble is saved by runScope, but never reconstruct
      // old model messages from UI bubbles after the one-time legacy import.
      const current = this.listScopeMessages(serverId).find((message) => message.turnId === execution.id && message.role === "user");
      if (current) messages.push({ role: "user", content: current.content });
    }
    if (!execution.checkpoint && execution.workflowRun) messages.push({ role: "user", content: this.workflowTurnInstruction(execution) });
    const oldHead = this.sessions.messages(serverId)[0];
    this.sessions.commit(serverId, messages, Boolean(oldHead && JSON.stringify(oldHead) !== JSON.stringify(messages[0])));
    try {
      for (let step = execution.checkpoint?.step ?? 0; step < 500; step += 1) {
        this.throwIfAborted(signal);
        const stepId = `${execution.id}:step:${step}`;
        this.activeRuns.get(serverId)!.stepId = stepId;
        const stepRecord = this.executions.steps(execution.id).find((entry) => entry.id === stepId)
          ?? { id: stepId, turnId: execution.id, index: step, status: "running" as const, startedAt: nowIso() };
        stepRecord.status = "running";
        this.executions.saveStep(stepRecord);
        const savedResult = execution.checkpoint?.step === step ? execution.checkpoint.result : undefined;
        // Never insert input in the middle of assistant tool_calls / tool results.
        if (!savedResult) this.consumeInbox(serverId, messages, step, step === 0);
        execution.checkpoint = { messages: structuredClone(messages), step, result: savedResult };
        this.executions.save(execution);
        const tools = makeTools();
        execution.capabilities = [...this.getInstalledCapabilities(serverId)];
        const toolDefinitions = tools.map((tool) => tool.definition);
        this.sessions.setHeader(serverId, { baseUrl: modelConfig.baseUrl, modelName: modelConfig.modelName,
          apiType: modelConfig.apiType ?? "chat_completions", reasoningEffort, tools: toolDefinitions });
        if (!savedResult) {
          appendRuntimeContext(messages, global ? await this.buildGlobalRuntimeContext() : await this.buildRuntimeContext(serverId));
          this.sessions.commit(serverId, messages);
          if (this.estimateModelContextTokens(messages, toolDefinitions) > this.getModelContextMaxEstimatedTokens() * this.contextAutoCompressRatio) {
            try {
              await this.compactSession(serverId, messages, modelConfig);
            } catch (error) {
              this.throwIfAborted(signal);
              this.trace(serverId, `自动压缩失败，保留原始上下文：${error instanceof Error ? error.message : String(error)}`);
            }
            appendRuntimeContext(messages, global ? await this.buildGlobalRuntimeContext() : await this.buildRuntimeContext(serverId));
            this.sessions.commit(serverId, messages);
          }
          execution.checkpoint = { messages: structuredClone(messages), step };
          this.executions.save(execution);
        }
        this.ensureModelContextWithinLimit(messages, toolDefinitions);
        const toolMap = new Map(tools.map((tool) => [tool.definition.function.name, tool]));
        let streamedContent = "";
        let reasoningId: string | undefined;
        const onReasoning = (delta: string) => {
          reasoningId ??= this.startActivity(serverId, { kind: "reasoning", title: "思考过程" });
          this.appendActivityDelta(serverId, reasoningId, delta);
        };
        const result = savedResult ?? await this.chatCompletionWithRetry(serverId, {
          baseUrl: modelConfig.baseUrl,
          modelName: modelConfig.modelName,
          apiKey: modelConfig.apiKey,
          apiType: modelConfig.apiType,
          temperature: 0.2,
          reasoningEffort,
          messages,
          tools: toolDefinitions,
          signal
        }, (delta) => {
          streamedContent += delta;
          const run = this.activeRuns.get(serverId);
          if (run) {
            run.partialContent = streamedContent;
            run.responseCreatedAt ??= nowIso();
          }
          this.emit(serverId, { type: "message_delta", messageId: responseMessageId, content: delta });
        }, (error) => {
          if (reasoningId) this.finishActivity(serverId, reasoningId, "failed", undefined, error);
          reasoningId = undefined;
          if (streamedContent.trim()) {
            const partialId = createId("msg");
            this.saveMessage(serverId, "agent", streamedContent, "completed", partialId);
            this.emit(serverId, { type: "message", messageId: partialId, content: streamedContent, status: "completed" });
          }
          streamedContent = "";
          const run = this.activeRuns.get(serverId);
          if (run) { run.partialContent = ""; run.responseCreatedAt = undefined; }
          this.emit(serverId, { type: "message", messageId: responseMessageId, content: "", status: "running" });
        }, onReasoning);
        this.throwIfAborted(signal);
        execution.checkpoint = { messages: structuredClone(messages), step, result };
        stepRecord.result = result;
        this.sessions.saveUsage(serverId, result.usage);
        this.executions.saveStep(stepRecord);
        this.executions.save(execution);
        if (result.usage?.promptTokens) {
          this.lastUsageByServer.set(serverId, {
            actualTokens: result.usage.promptTokens,
            estimatedTokens: this.estimateModelContextTokens(messages, toolDefinitions)
          });
        }
        if (result.reasoning && !reasoningId) onReasoning(result.reasoning);
        if (reasoningId) this.finishActivity(serverId, reasoningId, "completed");
        const visibleContent = (result.content || streamedContent || "").trim();
        if (result.toolCalls.length === 0) {
          stepRecord.status = "completed";
          stepRecord.finishedAt = nowIso();
          this.executions.saveStep(stepRecord);
          if (execution.workflowRun && this.toolRuntime.turnJobs(serverId, execution.id).some((job) => job.status === "running")) {
            messages.push(this.replayAssistant(result));
            this.sessions.commit(serverId, messages);
            execution.checkpoint = { messages: structuredClone(messages), step: step + 1 };
            this.executions.save(execution);
            const progress = execution.workflowProgress;
            if (progress?.turn) this.emit(serverId, { type: "workflow_progress", workflow: { ...progress, turn: { ...progress.turn, waitingForJobs: true } } });
            this.trace(serverId, "本轮等待后台任务汇合；不会启动下一 turn。");
            await this.toolRuntime.join(serverId, execution.id, signal);
            this.throwIfAborted(signal);
            this.consumeInbox(serverId, messages, step + 1, false);
            if (execution.workflowProgress?.turn) this.emit(serverId, { type: "workflow_progress", workflow: { ...execution.workflowProgress, turn: { ...execution.workflowProgress.turn, waitingForJobs: false } } });
            this.emit(serverId, { type: "message", messageId: responseMessageId, content: "", status: "running" });
            this.activeRuns.get(serverId)!.partialContent = "";
            continue;
          }
          const eligibleInbox = this.toolRuntime.inbox(serverId).some((item) => execution.workflowRun
            ? (!item.sourceTurnId && item.delivery === "steer") || item.sourceTurnId === execution.id
            : item.delivery === "steer");
          if (eligibleInbox) {
            if (visibleContent) this.saveMessage(serverId, "agent", visibleContent, "completed");
            messages.push(this.replayAssistant(result));
            this.consumeInbox(serverId, messages, step + 1, false);
            this.emit(serverId, { type: "message", messageId: responseMessageId, content: "", status: "running" });
            const run = this.activeRuns.get(serverId)!;
            run.partialContent = "";
            run.responseCreatedAt = undefined;
            continue;
          }
          // Final natural-language reply stays on the run response bubble (saved by sendMessage).
          if (visibleContent && !streamedContent) {
            this.emit(serverId, { type: "message", messageId: responseMessageId, content: visibleContent, status: "running" });
          }
          messages.push(this.replayAssistant(result));
          this.sessions.commit(serverId, messages);
          execution.checkpoint = { messages: structuredClone(messages), step: step + 1 };
          this.executions.save(execution);
          if (execution.workflowRun) this.assertWorkflowRoundComplete(execution);
          return visibleContent || result.content;
        }
        // Preserve intermediate assistant narration as its own completed message before clearing the shared bubble for tool rounds.
        if (visibleContent && !savedResult) {
          const intermediateMessageId = createId("msg");
          this.saveMessage(serverId, "agent", visibleContent, "completed", intermediateMessageId);
          this.emit(serverId, { type: "message", messageId: intermediateMessageId, content: visibleContent, status: "completed" });
          this.emit(serverId, { type: "message", messageId: responseMessageId, content: "", status: "running" });
          const run = this.activeRuns.get(serverId);
          if (run) { run.partialContent = ""; run.responseCreatedAt = undefined; }
        }
        const assistantMessage = this.replayAssistant(result);
        messages.push(assistantMessage);
        for (const toolCall of result.toolCalls) {
          this.throwIfAborted(signal);
          const callId = `${stepId}:tool:${toolCall.id}`;
          const previous = this.executions.calls(execution.id).find((call) => call.id === callId);
          if (previous?.status === "completed") {
            messages.push({ role: "tool", content: previous.output ?? "", tool_call_id: toolCall.id });
            continue;
          }
          if (previous) throw new Error("工具结果不确定，禁止自动重放");
          const callRecord = { id: callId, turnId: execution.id, stepId, toolCallId: toolCall.id,
            name: toolCall.function.name, arguments: toolCall.function.arguments, status: "running" as const, startedAt: nowIso() };
          const tool = toolMap.get(toolCall.function.name);
          const activityId = this.startActivity(serverId, {
            kind: "tool", title: toolCall.function.name, toolName: toolCall.function.name,
            toolCallId: toolCall.id, input: toolCall.function.arguments
          });
          let args: Record<string, unknown>;
          try {
            args = this.parseToolArguments(toolCall.function.arguments);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.finishActivity(serverId, activityId, "failed", "", message);
            this.appendAgentConsoleLog(serverId, `工具失败：${toolCall.function.name}（参数解析失败）`);
            const toolMessage: ChatMessageInput = {
              role: "tool",
              content: this.formatToolError(toolCall.function.name, message, [
                "请重新调用该工具，arguments 必须是合法的 JSON 对象。",
                "注意字符串内的引号、换行和反斜杠必须按 JSON 规则转义；不要把参数拼进工具名或省略字段。"
              ]),
              tool_call_id: toolCall.id
            };
            messages.push(toolMessage);
            this.executions.saveCall({ ...callRecord, status: "completed", output: toolMessage.content ?? "", finishedAt: nowIso() });
            continue;
          }
          this.appendAgentConsoleLog(serverId, `执行工具：${toolCall.function.name}\n参数：${this.formatConsolePayload(args)}`);
          this.throwIfAborted(signal);
          let content: string;
          this.executions.saveCall(callRecord);
          try {
            let admissionError: string | undefined;
            try { this.guardWorkflowTool(serverId, toolCall.function.name, args); }
            catch (error) { admissionError = this.formatToolError(toolCall.function.name, error instanceof Error ? error.message : String(error), ["仅执行当前 turn 的节点；等待本轮后台结果并完成核验，不要提前执行后续节点。"]); }
            if (admissionError) content = admissionError;
            else if (backgroundableTools.has(toolCall.function.name)) {
              const background = args.background === true;
              const toolArgs = { ...args };
              delete toolArgs.background;
              // Tool context belongs to the job, not the model step's lifetime.
              content = await this.toolRuntime.execute({ scopeId: serverId, turnId: execution.id, stepId,
                toolCallId: toolCall.id, name: toolCall.function.name, arguments: toolArgs, background }, signal, (jobSignal) => {
                const jobTools = global ? this.createGlobalTools(jobSignal, true) : this.createTools(serverId, jobSignal, true);
                const jobTool = jobTools.find((entry) => entry.definition.function.name === toolCall.function.name);
                return this.executeToolForModel(serverId, toolCall.function.name, jobTool, toolArgs, jobSignal);
              });
            } else {
              content = await this.executeToolForModel(serverId, toolCall.function.name, tool, args, signal);
            }
          } catch (error) {
            this.finishActivity(serverId, activityId, "cancelled", "", error instanceof Error ? error.message : String(error));
            throw error;
          }
          this.throwIfAborted(signal);
          execution.capabilities = [...this.getInstalledCapabilities(serverId)];
          getDb().transaction(() => {
            this.executions.saveCall({ ...callRecord, status: "completed", output: content, finishedAt: nowIso() });
            this.executions.save(execution);
          });
          const failed = content.startsWith("TOOL_ERROR");
          this.finishActivity(serverId, activityId, failed ? "failed" : "completed", content,
            failed ? content.split("错误：")[1]?.split("\n恢复策略：")[0]?.trim() || content : undefined);
          this.appendAgentConsoleLog(serverId, `${content.startsWith("TOOL_ERROR") ? "工具失败" : "工具完成"}：${toolCall.function.name}`);
          const toolMessage: ChatMessageInput = { role: "tool", content, tool_call_id: toolCall.id };
          messages.push(toolMessage);
        }
        stepRecord.status = "completed";
        stepRecord.finishedAt = nowIso();
        this.executions.saveStep(stepRecord);
        execution.checkpoint = { messages: structuredClone(messages), step: step + 1 };
        this.sessions.commit(serverId, messages);
        this.executions.save(execution);
      }
      throw new Error("Agent 工具调用次数过多，请拆分任务后重试");
    } catch (error) {
      throw this.normalizeModelError(error);
    }
  }

  private getInstalledCapabilities(serverId: string) {
    let installed = this.installedCapabilitiesByServer.get(serverId);
    if (!installed) {
      installed = new Set<AgentCapabilityId>();
      this.installedCapabilitiesByServer.set(serverId, installed);
    }
    return installed;
  }

  private replayAssistant(result: import("../services/modelService.js").ChatCompletionResult): ChatMessageInput {
    return { role: "assistant", content: result.replayContent ?? result.content,
      ...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {}),
      reasoning_content: result.replayReasoning ?? result.reasoning };
  }

  private withBackgroundParameters(tools: AgentTool[]): AgentTool[] {
    return tools.map((tool) => {
      if (!["begin_deployment_workflow", "update_agent_workflow_progress"].includes(tool.definition.function.name)) {
        tool = { ...tool, definition: { ...tool.definition, function: { ...tool.definition.function,
          parameters: { ...tool.definition.function.parameters, properties: { ...(tool.definition.function.parameters.properties as Record<string, unknown>),
            workflowStepId: { type: "string", description: "流程执行期间填写本轮所属节点 ID，自动标记运行/失败；非流程任务省略" },
            workflowUpdates: workflowUpdatesSchema }
          }
        } } };
      }
      if (!backgroundableTools.has(tool.definition.function.name)) return tool;
      const schema = tool.definition.function.parameters;
      return { ...tool, definition: { ...tool.definition, function: { ...tool.definition.function,
        description: `${tool.definition.function.description}\n支持 background=true 后台执行：立即返回 jobId；仍需操作确认，完成结果由 inbox steer 送达。仅在后续操作不依赖该结果、不冲突于同一文件/配置时使用；不要轮询或重复调用。`,
        parameters: { ...schema, properties: { ...(schema.properties as Record<string, unknown>), background: { type: "boolean", description: "后台执行，完成后通过 inbox 通知" } } }
      } } };
    });
  }

  private createTools(serverId: string, signal: AbortSignal, jobOwned = false, benchmark?: AgentExecution["benchmark"]) {
    const installedCapabilities = this.getInstalledCapabilities(serverId);
    return createAgentTools({
      getServerId: () => serverId,
      getUploadSessionId: () => serverId,
      serverService: this.serverService,
      fileService: this.fileService,
      processManager: this.processManager,
      uploadService: this.uploadService,
      javaService: this.javaService,
      signal,
      askUser: benchmark?.askUser === false ? undefined : (request) => this.askUser(serverId, request, signal),
      allowAskUser: benchmark?.askUser !== false,
      downloadProxyUrl: () => this.promptService.getAgentDownloadProxyUrl(),
      getPythonPackageIndexUrl: () => this.promptService.getPythonPackageIndexUrl(),
      getDeploymentWorkflow: () => this.activeRuns.get(serverId)?.execution.deploymentWorkflow ?? this.promptService.getDeploymentWorkflow?.() ?? defaultDeploymentWorkflow(),
      getWorkflowProgress: () => this.presentation.get(serverId)?.workflow ?? null,
      beginDeploymentWorkflow: () => this.beginDeploymentWorkflow(serverId),
      getCurseForgeApiKey: () => this.promptService.getCurseForgeApiKey(),
      getModrinthApiKey: () => this.promptService.getModrinthApiKey(),
      getBraveSearchApiKey: () => this.promptService.getBraveSearchApiKey(),
      getTavilyApiKey: () => this.promptService.getTavilyApiKey(),
      getSearxngBaseUrl: () => this.promptService.getSearxngBaseUrl(),
      toolConfigRequired: (toolConfigRequired) => this.emit(serverId, { type: "tool_config_required", toolConfigRequired }),
      // Declare every built-in schema once. Enabling a capability changes only
      // execution admission, never the provider's tools-before-history prefix.
      installedCapabilities: new Set(Object.keys(installableCapabilities) as AgentCapabilityId[]),
      installCapability: (capability) => this.installCapability(serverId, capability),
      confirm: (request) => this.requestConfirmation(serverId, request, jobOwned ? signal : undefined),
      progress: (download) => this.emit(serverId, { type: "download_progress", download }),
      workflowProgress: (workflow) => this.emit(serverId, { type: "workflow_progress", workflow }),
      serverSlotStatus: (serverSlot) => this.emit(serverId, { type: "server_slot", serverSlot }),
      consoleLog: (text, stream) => this.appendAgentConsoleLog(serverId, text, stream)
    }).map((tool) => {
      const capability = (Object.keys(installableCapabilities) as AgentCapabilityId[])
        .find((id) => (installableCapabilities[id].tools as readonly string[]).includes(tool.definition.function.name));
      if (!capability) return tool;
      return { ...tool, execute: async (input: Record<string, unknown>) => {
        if (!installedCapabilities.has(capability)) throw new Error(`先调用 install_agent_capability(capability=${capability}) 启用此能力`);
        return tool.execute(input);
      } };
    });
  }

  /**
   * Tools for the dashboard-level agent. Each instance tool takes an explicit
   * serverId, so the global conversation can inspect and orchestrate instances
   * without being bound to one. focus_instance records the handoff target.
   */
  private createGlobalTools(signal: AbortSignal, jobOwned = false) {
    const scopeId = GLOBAL_SCOPE_ID;
    const context = {
      getServerId: () => this.activeRuns.get(scopeId)?.focusServerId ?? "",
      getUploadSessionId: () => scopeId,
      serverService: this.serverService,
      fileService: this.fileService,
      processManager: this.processManager,
      uploadService: this.uploadService,
      javaService: this.javaService,
      signal,
      askUser: (request: AgentQuestionInput) => this.askUser(scopeId, request, signal),
      downloadProxyUrl: () => this.promptService.getAgentDownloadProxyUrl(),
      getPythonPackageIndexUrl: () => this.promptService.getPythonPackageIndexUrl(),
      getDeploymentWorkflow: () => this.activeRuns.get(GLOBAL_SCOPE_ID)?.execution.deploymentWorkflow ?? this.promptService.getDeploymentWorkflow?.() ?? defaultDeploymentWorkflow(),
      getWorkflowProgress: () => this.presentation.get(GLOBAL_SCOPE_ID)?.workflow ?? null,
      getCurseForgeApiKey: () => this.promptService.getCurseForgeApiKey(),
      getModrinthApiKey: () => this.promptService.getModrinthApiKey(),
      getBraveSearchApiKey: () => this.promptService.getBraveSearchApiKey(),
      getTavilyApiKey: () => this.promptService.getTavilyApiKey(),
      getSearxngBaseUrl: () => this.promptService.getSearxngBaseUrl(),
      toolConfigRequired: (toolConfigRequired: AgentToolConfigRequired) => this.emit(scopeId, { type: "tool_config_required", toolConfigRequired }),
      confirm: (request: { title: string; description: string; risk: "medium" | "high" }) => this.requestConfirmation(scopeId, request, jobOwned ? signal : undefined),
      progress: (download: AgentDownloadProgress) => this.emit(scopeId, { type: "download_progress", download }),
      serverSlotStatus: (serverSlot: ServerSlotStatus) => this.emit(scopeId, { type: "server_slot", serverSlot }),
      consoleLog: (text: string, stream?: ConsoleLogEntry["stream"]) => this.appendAgentConsoleLog(scopeId, text, stream),
      focusInstance: (focus: AgentFocusInstance) => this.setFocusInstance(scopeId, focus)
    };
    return createGlobalAgentTools(this.serverService, this.processManager, this.consoleLogService, context);
  }

  private setFocusInstance(scopeId: string, focus: AgentFocusInstance) {
    // Persisted with the run's response message; the UI routes on that field.
    const run = this.activeRuns.get(scopeId);
    if (run) {
      run.focusServerId = focus.serverId;
      run.focusTask = focus.task;
      run.focusReason = focus.reason;
      run.execution.focus = { focusServerId: focus.serverId, focusTask: focus.task, focusReason: focus.reason };
      run.execution.handoff = { status: "pending" };
      this.executions.save(run.execution);
    }
    this.emit(scopeId, { type: "focus_instance", focus });
  }

  /**
   * After a global run hands a task to an instance, kick off the instance agent
   * so the work continues where the user was sent. Failures here only affect the
   * instance conversation, never the completed global handoff.
   */
  private async dispatchFocusHandoff(handoff: { focusServerId: string; focusTask: string; focusReason: string }, parentTurnId: string) {
    const { focusServerId, focusTask, focusReason } = handoff;
    if (!focusTask.trim()) return;
    const parent = this.executions.get(GLOBAL_SCOPE_ID, parentTurnId);
    if (this.isBusy(focusServerId)) {
      parent.handoff = { status: "blocked", error: "目标实例忙，尚未启动交接任务" };
      this.executions.save(parent);
      this.saveMessage(GLOBAL_SCOPE_ID, "system", `交接未启动：目标实例 ${focusServerId} 正在处理其他任务。`);
      return;
    }
    const reasonLine = focusReason ? `\n交接原因：${focusReason}` : "";
    const prompt = [
      "【来自全局 Agent 的任务交接】",
      focusTask,
      reasonLine,
      "请从当前实例的实际情况出发，先确认现状再执行；必要时用工具检查文件、配置与终端输出。"
    ].filter(Boolean).join("\n");
    try {
      this.saveMessage(focusServerId, "system", `已接收全局 Agent 交接的任务：${focusTask}`);
      await this.serverService.requireServer(focusServerId);
      await this.runScope(focusServerId, prompt, "high", undefined, parentTurnId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      parent.handoff = { status: "failed", error: message };
      this.executions.save(parent);
      this.saveMessage(focusServerId, "system", `交接任务执行失败：${message}`);
    }
  }

  private installCapability(serverId: string, capability: AgentCapabilityId) {
    const installed = this.getInstalledCapabilities(serverId);
    if (installed.has(capability)) return;
    installed.add(capability);
    this.trace(serverId, `已启用 Agent 内置能力：${capability}`);
  }

  private async executeToolForModel(
    serverId: string,
    toolName: string,
    tool: AgentTool | undefined,
    args: Record<string, unknown>,
    signal: AbortSignal
  ) {
    if (!tool) {
      return this.formatToolError(toolName, `未知工具：${toolName}`, [
        "检查工具列表中可用的工具名，不要重复调用不存在的工具。",
        "如果是缺少内置能力，先调用 install_agent_capability 安装可用能力包，再继续任务。"
      ]);
    }

    try {
      this.guardWorkflowTool(serverId, toolName, args);
      const toolArgs = { ...args };
      delete toolArgs.workflowStepId;
      delete toolArgs.workflowUpdates;
      const execution = this.activeRuns.get(serverId)?.execution;
      const merged = execution?.workflowRun && execution.deploymentWorkflow
        ? parseWorkflowToolProgress(args, execution.deploymentWorkflow) : undefined;
      if (args.workflowUpdates !== undefined && !merged) throw new Error("workflowUpdates requires an active deployment workflow");
      // Reuse the exact confirmation, round and background-result gates of the
      // standalone progress tool. Validate every update before applying any.
      for (const item of merged?.updates ?? []) this.guardWorkflowTool(serverId, "update_agent_workflow_progress", { ...item });
      const update = (stepId: string, status: "pending" | "running" | "completed" | "failed", detail: string) => {
        if (!execution?.deploymentWorkflow || this.activeRuns.get(serverId)?.execution !== execution) return;
        const previous = execution.workflowProgress;
        const old = previous?.steps.find((step) => step.id === stepId);
        this.emit(serverId, { type: "workflow_progress", workflow: buildWorkflowProgress(execution.deploymentWorkflow, previous,
          { stepId, status, detail, progress: status === "completed" ? 100 : status === "pending" ? 0 : Math.min(99, old?.progress ?? 0), title: previous?.title ?? "整合包服务端部署流程" }) });
      };
      for (const item of merged?.updates ?? []) update(item.stepId, item.status, item.detail);
      const old = execution?.workflowProgress?.steps.find((step) => step.id === merged?.stepId);
      if (merged?.stepId && old?.status !== "completed") update(merged.stepId, "running", `正在执行 ${toolName}`);
      let content: string;
      try {
        content = await tool.execute(toolArgs);
        this.throwIfAborted(signal);
      } catch (error) {
        if (merged?.stepId && !signal.aborted && !this.isAbortError(error) && !this.isConfirmationRejection(error)) update(merged.stepId, "failed", `${toolName} 执行失败；需诊断后继续`);
        throw error;
      }
      if (merged?.stepId && content.startsWith("TOOL_ERROR")) update(merged.stepId, "failed", `${toolName} 返回失败；需诊断后继续`);
      return this.truncateToolResultForModel(toolName, content);
    } catch (error) {
      if (this.isAbortError(error) || this.isConfirmationRejection(error)) throw error;
      const normalized = this.normalizeModelError(error);
      const message = normalized instanceof Error ? normalized.message : String(normalized);
      return this.formatToolError(toolName, message, [
        "不要用相同参数重复调用刚失败的工具。",
        "先用 list_server_files、read_server_text_file 等工具重新检查实际路径、文件类型或已有文件。",
        "如果失败原因是当前缺少工具能力，调用 install_agent_capability 安装可用内置能力包后继续。",
        "如果是外部网站、下载或信息不足导致失败，改用已上传/已存在文件，或向用户说明缺少的具体信息。"
      ]);
    }
  }

  private truncateToolResultForModel(toolName: string, content: string) {
    const maxChars = this.modelToolResultMaxChars;
    if (content.length <= maxChars) return content;
    const marker = `\n\n...（工具 ${toolName} 返回 ${content.length} 字符，已截断中间内容以避免模型上下文过大；保留开头和结尾。如需更多细节，请读取更具体的文件或日志片段。）...\n\n`;
    const headChars = Math.floor((maxChars - marker.length) / 2);
    const tailChars = Math.max(0, maxChars - marker.length - headChars);
    return `${content.slice(0, Math.max(0, headChars))}${marker}${tailChars > 0 ? content.slice(-tailChars) : ""}`;
  }

  private getModelContextMaxEstimatedTokens() {
    return this.modelService.getContextMaxTokens();
  }

  private ensureModelContextWithinLimit(messages: ChatMessageInput[], tools: AgentTool["definition"][]) {
    const estimatedTokens = this.estimateModelContextTokens(messages, tools);
    const maxTokens = this.getModelContextMaxEstimatedTokens();
    if (estimatedTokens <= maxTokens) return;
    throw new Error([
      `模型请求上下文预计约 ${estimatedTokens} tokens，超过安全上限 ${maxTokens}，已停止发送以避免上游返回空 assistant 消息。`,
      "可点击“压缩上下文”把早期对话压缩为摘要后重试，或清除 Agent 上下文、拆分任务、让 Agent 只读取更具体的日志/文件片段。"
    ].join(""));
  }

  private estimateModelContextTokens(messages: ChatMessageInput[], tools: AgentTool["definition"][]) {
    let estimated = 0;
    for (const message of messages) {
      estimated += 4 + this.estimateTextTokens(message.role);
      if (message.content) estimated += this.estimateTextTokens(message.content);
      if (message.reasoning_content) estimated += this.estimateTextTokens(message.reasoning_content);
      if (message.tool_call_id) estimated += this.estimateTextTokens(message.tool_call_id);
      if (message.tool_calls?.length) estimated += this.estimateTextTokens(JSON.stringify(message.tool_calls));
    }
    for (const tool of tools) {
      estimated += this.estimateTextTokens(tool.function.name);
      estimated += this.estimateTextTokens(tool.function.description);
      estimated += this.estimateTextTokens(JSON.stringify(tool.function.parameters));
    }
    return Math.ceil(estimated);
  }

  private estimateTextTokens(text: string) {
    let ascii = 0;
    for (let index = 0; index < text.length; index += 1) {
      if (text.charCodeAt(index) <= 0x7f) ascii += 1;
    }
    const nonAscii = text.length - ascii;
    return ascii / 4 + nonAscii * 1.2;
  }

  private formatToolError(toolName: string, message: string, recovery: string[]) {
    return [
      "TOOL_ERROR",
      `工具：${toolName}`,
      `错误：${message}`,
      "恢复策略：",
      ...recovery.map((item) => `- ${item}`)
    ].join("\n");
  }

  private agentRecoveryInstructions() {
    return [
      "Agent 失败恢复策略：",
      "- 工具返回 TOOL_ERROR 时，不要直接结束任务；根据错误调整路径、参数或方案后继续。",
      "- 如果当前工具缺少完成任务所需能力，先调用 install_agent_capability 安装可用内置能力包。",
      "- 整合包部署顺序只遵循系统中的「当前部署流程（流程编排 · 权威配置）」。下列工具恢复建议是技术参考，不定义阶段先后顺序；禁止恢复旧的固定阶段顺序。",
      "- 确认整合包来源时必须同时考虑 Modrinth 和 CurseForge。只查询了其中一个平台、或其中一个平台结果不唯一/不匹配时，不得把 identify_modpack 标记为 failed；必须继续尝试另一个平台的官方 API 工具。只有两个平台都已查询且没有匹配项，或 CurseForge 因缺少/鉴权失败 API Key 需要用户配置，或用户没有提供足够名称/版本信息时，才可以失败并明确说明还缺少什么。",
      "- 确认整合包硬门禁：检索到候选后必须向用户列出名称、平台、slug/projectId、版本/MC 版本/Loader（及链接），并请求用户确认选哪一个；用户未明确确认前，禁止将 identify_modpack 标为 completed，禁止下载服务端包、解压、安装 Forge/NeoForge、改启动配置或启动服务端。不得因搜索结果看似唯一或下载量最高就自行认定并继续部署。",
      "- 进度优先随实际工具提交：workflowStepId 自动标记运行/失败，workflowUpdates 合并此前已验证的本轮状态；不要为开始或细碎百分比单独汇报，无后续操作时才用独立进度工具收尾。服务端包必须先进入当前服务端的独立槽位，且仅在用户确认整合包后：优先使用 save_upload_to_server_slot；没有上传时优先使用 download_modrinth_server_pack_to_server_slot 和 download_curseforge_server_pack_to_server_slot 通过平台 API 获取；最后才使用 download_https_file_to_server_slot。不要抓取 CurseForge 网页 Files 页面，不要直接把原始服务端包散落到根目录。",
      "- 服务端槽位若是 Modrinth .mrpack，禁止 extract_server_slot_to_workspace / extract_server_zip。必须先 inspect_mrpack_server_slot，再 deploy_mrpack_server_from_server_slot：只下载 server required 文件并校验哈希、合并 overrides，并安装 Vanilla/Fabric/Quilt/Forge/NeoForge 启动文件。完整 server pack zip 仍优先于 .mrpack。",
      "- CurseForge 槽位 ZIP 若根目录只有 manifest.json、overrides/、modlist.html 等清单内容，不是可直启服务端。禁止直接 extract_server_slot_to_workspace 后启动；必须调用 materialize_curseforge_manifest_pack_from_server_slot。该工具会精确按 manifest 的 projectID/fileID 下载 required 模组并复制 overrides 内容，但不会安装 Loader。若返回 Forge/NeoForge installer URL，下载该官方 installer 到 server/；Forge 启用 forge_server_setup 并调用 setup_forge_server，NeoForge 启用 neoforge_server_setup 并调用 setup_neoforge_server（minecraftVersion、neoforgeVersion、installerPath、javaPath）；若是当前未支持的 Loader，明确说明需要对应受控安装能力，禁止伪造启动成功。",
      "- CurseForge API 工具如果提示缺少或鉴权失败，或前端收到 tool_config_required，必须停止部署并让用户点击 Tools 卡片/设置中的配置按钮填写 CurseForge API Key，告知申请/管理地址 https://console.curseforge.com/?#/api-keys。Modrinth 工具如果提示需要 PAT，必须停止部署并让用户点击配置按钮填写 Modrinth PAT，告知申请/管理地址 https://modrinth.com/settings/pats。",
      "- 部署整合包时必须使用内置 reference 模板。Minecraft 服务端本体必须位于当前服务端根目录下的 server/ 子目录；mods、libraries、world、server.jar、eula.txt、user_jvm_args.txt 和服务端自带脚本都应在 server/ 内，不应放在 MCDReforged 根目录。",
       "- 布局硬门禁：每次解压、Forge/NeoForge 安装后都必须 list_server_files 检查根目录与 server/。若根目录出现 mods、libraries、world、run.sh/run.bat、eula.txt、server.properties、user_jvm_args.txt、server.jar 中的任一项，视为布局失败，不得把 extract_to_workspace/configure_mcdr/final_mcdr_test 标为 completed；必须先把 Minecraft 文件迁回 server/ 或重新按模板安装。",
      "- 安装单个模组时优先调用 download_mod_to_server_mods，通过 provider=modrinth 或 provider=curseforge 下载 .jar 到 server/mods/；不要把 .mrpack、zip 或服务端包当作单个模组安装。",
      "- 直启失败或怀疑混入客户端模组时，调用 inspect_client_only_server_mods 扫描 server/mods；确认后用 disable_client_only_server_mods 将仅客户端 jar 重命名为 .jar.disabled（不删除）。优先处理 high/medium 置信度。",
      "- 若自动扫描未覆盖但日志点名某个模组、用户要求禁用某个模组，或启动失败明确指向某个 jar/modId，调用 disable_server_mods，传入 targets（文件名、相对路径、modId 或关键词）；同样重命名为 .jar.disabled，不删除。禁用后重新启动验证。",
      "- 已存在于服务端目录内的 zip/tar.gz/tgz 需要先安装 zip_extract 能力，再用 extract_server_zip 解压到 server/；服务端槽位中的 zip/tar.gz/tgz 应使用 extract_server_slot_to_workspace，并把 destinationPath 设为 server；槽位 .mrpack 不得解压，只能走 inspect_mrpack_server_slot + deploy_mrpack_server_from_server_slot。",
       "- 最终启动验证必须使用 server/ 内服务端包自带的 run/start/server/launch 脚本；如果没有自带脚本或脚本确实不可用，再按当前服务端配置生成非交互启动命令。",
      "- 启动验证前必须优先按上下文里的推荐内存写入 server/user_jvm_args.txt、server/ 内脚本 -Xms/-Xmx 或当前服务端配置。整合包有明确要求时可以调整，但不能超过推荐内存，并且必须向用户说明调整原因和最终内存值。",
      "- Forge 1.17+ 或 NeoForge 整合包需要 installer 时，分别启用 forge_server_setup/neoforge_server_setup 能力，再调用 setup_forge_server/setup_neoforge_server 写入 @libraries/.../win_args.txt 或 unix_args.txt 启动配置；不要把 installer jar 当作服务端 jar 启动。NeoForge 使用 --installServer 与 net/neoforged Maven 坐标，Minecraft 1.20.1 旧版使用 net/neoforged/forge/1.20.1-47.x 坐标，其他版本使用 net/neoforged/neoforge/<NeoForge版本>。优先使用包内 installer，缺失时从官方 Maven 下载整合包指定的精确版本。在 reference 模板下必须安装进 server/，禁止安装或提升到 MCDR 根目录。",
       "- setup_forge_server/setup_neoforge_server 返回 ok=true 只表示 Loader 已装进 installRoot（MCDR 下为 server/），绝不表示部署完成。仍须按编排完成布局检查、内置 Python、config.yml 和 MCDR 最终验证；如果内置 Python 已提前配置且有成功证据，不必因阶段位置变化重复安装。",
      "- MCDReforged 最终启动后必须读取控制台及 logs/，确认每个已启用插件成功加载。若日志或插件 requirements 文件明确报告缺少 Python 模块/依赖，精确提取包名和版本约束，调用 install_mcdreforged_plugin_dependencies 安装到 workspace/python；停止残留进程后重启 MCDReforged 并复查日志。禁止使用系统 Python、猜测包名或安装无关依赖。插件仍缺依赖、安装失败或无法加载时，final_mcdr_test 必须保持 failed，并向用户报告插件名、依赖和错误。",
      "- 只有用户拒绝确认、用户中断、或确实缺少外部文件/信息时，才向用户说明无法继续的具体原因。"
    ].join("\n");
  }

  private agentToolAvailabilityInstructions() {
    return [
      "运行时工具事实（优先级高于保存的旧提示词和对话历史）：",
      "- 需要用户决定方案或偏好时，调用 ask_user 展示单选/多选题（multiple=true 为多选），等待真实回答后继续。不得伪造用户选择；取消或超时表示未作决定，不能擅自采用某个选项。它不代替危险操作确认，也不受自动确认设置影响。",
      "- 当前每次模型请求都注册了 run_shell_command，可执行 Shell 命令、管道、重定向和脚本；不需要安装额外能力，不得声称当前 Agent 无法使用 Shell。cwd 默认当前服务端根目录，可设为 server 等已有相对子目录。实际操作系统及 Shell 见工具描述；必须按该系统编写非交互命令。",
      "- run_shell_command 沿用操作确认/自动确认设置，支持超时与用户中断。优先使用已有专用工具；需要额外检查、脚本或修复时可使用 Shell，并根据 stdout、stderr、退出码判断结果。工作目录校验不是操作系统级隔离；操作应围绕当前服务端任务。持续运行服务端仍通过 update_current_server_config + start_current_server，避免脱离后端进程管理。",
      "- 当前每次模型请求都注册了通用公开网页搜索工具 web_search。它可以按任意关键词检索公开网页，返回标题、URL 和摘要；不是只限于 Modrinth 或 CurseForge。",
      "- 搜索结果只是摘要；需要阅读某个页面的具体内容时，必须用返回的 URL 调用 fetch_web_page 抓取正文，不要凭搜索摘要下结论。",
      "- 不得声称 web_search 不存在、不可用，或要求用户先提供具体 URL。只有工具实际执行失败时，才能说明失败原因和可行替代方案。",
      "- 用户询问网页搜索是否存在、是否可用，或要求检查 Tools 中的网页搜索时，必须先调用 web_search（可使用一个简短测试关键词）再根据实际工具结果回答。",
      "- web_search 与 fetch_web_page 的结果仅用于信息检索。下载或部署文件时，仍必须使用 Modrinth、CurseForge 官方 API 或用户提供的可信 HTTPS 直链。"
    ].join("\n");
  }

  private parseToolArguments(args: string): Record<string, unknown> {
    const trimmed = args.trim();
    if (!trimmed) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`参数 JSON 解析失败：${reason}（原始参数前 200 字符：${trimmed.slice(0, 200)}）`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("参数必须是 JSON 对象，而不是其他 JSON 类型。");
    }
    return parsed as Record<string, unknown>;
  }

  private formatConsolePayload(value: unknown) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > 500 ? `${text.slice(0, 500)}...（已截断）` : text;
  }

  private appendAgentConsoleLog(serverId: string, content: string, stream: ConsoleLogEntry["stream"] = "system") {
    if (!content) return;
    // The global conversation mirrors to the workspace console, not one instance.
    const consoleTargetId = isGlobalScope(serverId) ? undefined : serverId;
    if (!consoleTargetId) return;
    const normalized = content.endsWith("\n") ? content : `${content}\n`;
    const text = stream === "system"
      ? `${normalized.trimEnd().split(/\r?\n/).map((line) => `[Agent] ${line}`).join("\n")}\n`
      : normalized;
    try {
      this.consoleLogService.append(consoleTargetId, stream, text);
    } catch {
      // Agent console mirroring should never interrupt the actual Agent run.
    }
  }

  private trace(serverId: string, content: string) {
    const id = createId("msg");
    this.saveMessage(serverId, "system", content, undefined, id);
    this.emit(serverId, { type: "log", messageId: id, content });
  }

  private startActivity(serverId: string, details: Omit<AgentActivity, "status" | "startedAt">) {
    const id = createId("activity");
    const activity: AgentActivity = { ...details, status: "running", startedAt: nowIso() };
    this.activeRuns.get(serverId)?.activities.set(id, { content: "", activity, persistedAt: 0 });
    this.publishActivity(serverId, id);
    return id;
  }

  private persistActivity(scopeId: string, id: string) {
    const entry = this.activeRuns.get(scopeId)?.activities.get(id);
    if (!entry) return;
    if (isGlobalScope(scopeId)) {
      getDb().insert(globalAgentMessages).values({ id, conversationId: GLOBAL_SCOPE_ID, role: "system", content: entry.content,
        turnId: this.activeRuns.get(scopeId)?.execution.id, stepId: this.activeRuns.get(scopeId)?.stepId,
        activity: entry.activity, status: entry.activity.status, createdAt: entry.activity.startedAt
      }).onConflictDoUpdate({ target: globalAgentMessages.id, set: {
        content: entry.content, activity: entry.activity, status: entry.activity.status
      } }).run();
      entry.persistedAt = Date.now();
      return;
    }
    getDb().insert(agentMessages).values({ id, serverId: scopeId, role: "system", content: entry.content,
      turnId: this.activeRuns.get(scopeId)?.execution.id, stepId: this.activeRuns.get(scopeId)?.stepId,
      activity: entry.activity, status: entry.activity.status, createdAt: entry.activity.startedAt
    }).onConflictDoUpdate({ target: agentMessages.id, set: {
      content: entry.content, activity: entry.activity, status: entry.activity.status
    } }).run();
    entry.persistedAt = Date.now();
  }

  private publishActivity(serverId: string, id: string) {
    const entry = this.activeRuns.get(serverId)?.activities.get(id);
    if (!entry) return;
    this.persistActivity(serverId, id);
    this.emit(serverId, { type: "activity", messageId: id, content: entry.content, activity: { ...entry.activity }, createdAt: entry.activity.startedAt });
  }

  private appendActivityDelta(serverId: string, id: string, delta: string) {
    const entry = this.activeRuns.get(serverId)?.activities.get(id);
    if (!entry) return;
    entry.content += delta;
    if (Date.now() - entry.persistedAt >= 500) this.persistActivity(serverId, id);
    this.emit(serverId, { type: "activity_delta", messageId: id, content: delta, activity: { ...entry.activity }, createdAt: entry.activity.startedAt });
  }

  private finishActivity(serverId: string, id: string, status: AgentActivity["status"], content?: string, error?: string) {
    const entry = this.activeRuns.get(serverId)?.activities.get(id);
    if (!entry) return;
    if (content !== undefined) entry.content = content;
    entry.activity = { ...entry.activity, status, finishedAt: nowIso(), ...(error ? { error } : {}) };
    this.publishActivity(serverId, id);
  }

  private finishPendingActivities(serverId: string, status: "failed" | "cancelled", error?: string) {
    for (const [id, entry] of this.activeRuns.get(serverId)?.activities ?? []) {
      if (["running", "waiting_confirmation"].includes(entry.activity.status)) {
        this.finishActivity(serverId, id, status, undefined, error ?? (status === "cancelled" ? "执行已中断" : "模型请求失败，执行未完成"));
      }
    }
  }

  private normalizeModelError(error: unknown) {
    if (this.isAbortError(error)) return new Error("Agent 操作已中断");
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Cannot read properties of undefined") && message.includes("message")) {
      return new Error("模型接口返回了空的或不兼容的响应，请检查模型 Base URL、模型名称，以及该接口是否兼容 OpenAI Chat Completions 格式");
    }
    return error instanceof Error ? error : new Error(message);
  }

  private throwIfAborted(signal: AbortSignal) {
    if (!signal.aborted) return;
    const error = new Error("Agent 操作已中断");
    error.name = "AbortError";
    throw error;
  }

  private isAbortError(error: unknown) {
    return error instanceof Error && (error.name === "AbortError" || error.message === "Agent 操作已中断");
  }

  private isConfirmationRejection(error: unknown) {
    return error instanceof Error && error.message.startsWith("用户拒绝或未确认：");
  }

  private async buildRuntimeContext(serverId: string) {
    const server = await this.serverService.requireServer(serverId);
    const files = await this.fileService.list(serverId, ".").catch(() => []);
    const fileSummary = files.slice(0, 30).map((file) => `${file.type === "directory" ? "[DIR]" : "[FILE]"} ${file.path}`).join("\n") || "当前目录为空";
    const uploads = this.uploadService.list(serverId);
    const serverSlot = await this.fileService.getServerSlotStatus(serverId).catch(() => null);
    const agentSettings = this.promptService.getAgentSettings();
    const uploadSummary = uploads.length > 0
      ? uploads.map((upload) => `- uploadId=${upload.id} name=${upload.originalName} size=${upload.size} expiresAt=${upload.expiresAt}`).join("\n")
      : "当前没有上传给 Agent 的临时文件";
    const javaVersion = this.javaService.recommendVersion(server.minecraftVersion);
    const turn = this.activeRuns.get(serverId)?.execution;
    return [
      "当前服务端上下文：",
      `- 服务端 ID：${server.id}`,
      `- 名称：${server.name}`,
      `- 工作目录：${server.directory}`,
      `- 运行状态：${server.status}`,
      `- Minecraft 版本：${server.minecraftVersion ?? "未设置"}`,
      `- 整合包：${server.modpackName ?? "未设置"}`,
      `- Java 路径：${server.javaPath ?? "未设置"}`,
      `- Java 版本：${server.javaVersion ?? "未设置"}`,
      `- 推荐 Java 版本：${javaVersion}`,
      `- 启动 Jar：${server.jarFile}`,
      `- 启动参数：${server.startArgs}`,
      `- 启动指令：${server.startupCommand ?? "未设置"}`,
      `- 内存：${server.minMemory} / ${server.maxMemory}`,
      `- 推荐内存：${agentSettings.memory}`,
      `- Python 包镜像：${agentSettings.pythonPackageIndexUrl}`,
      ...(turn?.workflowRun ? [this.workflowTurnInstruction(turn), `本轮进度：${turn.workflowProgress?.steps.filter((step) => deploymentRounds(turn.deploymentWorkflow!)[turn.workflowRun!.roundIndex]!.steps.some((item) => item.id === step.id)).map((step) => `${step.id}=${step.status}`).join("、") ?? "等待执行"}`] : []),
      "配置策略：Agent 在部署或调整服务端时必须调用 update_current_server_config 写入服务端名字、Java 版本/路径、内存和必要的统一启动指令；内存只能使用一个值，并同时写入 minMemory 和 maxMemory，优先使用推荐内存；Java 版本必须根据已确认的实际 Minecraft 版本、Loader 与整合包依赖检查后选择可用的工作区 Java，信息不足时不能直接使用当前默认推荐值；startupCommand 可使用 {java}/{javaHome}/{python}/{pythonHome}/{workspace}/{serverDir}/{minecraftDir}/{memory}/{minMemory}/{maxMemory}/{jarFile}/{startArgs} 变量。serverType 只是展示/分类标签，不决定启动方式。",
      "模板与目录事实：新建服务端时后端自动套用内置 reference MCDReforged 模板，无需 Agent 重复套用；旧实例缺少模板时先检查已有文件，再用 initialize_server_template(template=reference, overwrite=false) 补齐。Minecraft 服务端本体必须放在 server/ 子目录；根目录用于 MCDReforged 的 config.yml、permission.yml、plugins/、config/、logs/。若根目录出现 mods/libraries/world/run.sh/eula.txt 等 Minecraft 文件，布局失败，必须先修复。",
      "启动事实：start_current_server 只有一种后端启动路径，按 startupCommand 执行，serverType 只是标签。直启命令从根目录进入 server/；MCDR 命令为 {python} -m mcdreforged。部署阶段顺序以系统「流程编排」为准，运行时上下文和历史不得覆盖它。MCDR 必须使用 configure_builtin_python_environment 配置的工作区 Python；config.yml 保持 working_directory=server、start_command 从 server/ 启动且 handler 匹配核心。插件依赖按真实日志/requirements 用 install_mcdreforged_plugin_dependencies 修复并复验。",
      "当前服务端根目录文件：",
      fileSummary,
      "当前上传给 Agent 的临时文件：",
      uploadSummary,
      "服务端槽位状态：",
      serverSlot?.occupied ? `已占用：${serverSlot.fileName} size=${serverSlot.size} path=${serverSlot.filePath}` : `空槽位：${serverSlot?.directory ?? "未知"}`,
      "工作空间约束：当前对话已经绑定到以上服务端。用户提到的整合包名、版本名或相似服务端名都只是当前任务的上下文，不表示要创建或切换到另一个服务端。只能在当前服务端工作目录内读取、写入、解压、配置和启动；如果用户确实要求新建或切换服务端，说明当前 Agent 不能完成该操作，请用户在服务端列表中手动选择或创建后再发起对话。",
      "对话要求：如果信息不足，先明确缺少哪些信息；如果要修改配置或文件，说明将使用的工具和预期结果。回复使用标准 GFM Markdown：标题标记后必须有空格；每个标题、列表项、表格行和段落必须独占一行；列表和表格前后保留空行；不要把 Markdown 块拼接在同一行。"
    ].join("\n");
  }

  private async localFallback(serverId: string, input: string) {
    const server = await this.serverService.requireServer(serverId);
    const files = await this.fileService.list(serverId, ".").catch(() => []);
    const javaVersion = this.javaService.recommendVersion(server.minecraftVersion);
    const lower = input.toLowerCase();

    if (lower.includes("模板") || lower.includes("初始化") || lower.includes("init")) {
      return "新建服务端时系统会自动套用内置 MCDReforged 模板，无需重复初始化。Minecraft 服务端文件必须放入 server/ 目录。已有旧实例缺少模板时，请先在设置中配置模型，再让 Agent 检查并以不覆盖方式补齐。";
    }

    return [
      "当前还没有配置可用模型，因此使用本地引导模式。",
      `当前服务端：${server.name}`,
      `目录文件数量：${files.length}`,
      `推荐 Java 版本：${javaVersion}`,
      "新建服务端已自动套用 MCDReforged 模板。你可以先在设置中添加 OpenAI-compatible 模型配置，再让 Agent 检查 Java 版本依赖或部署整合包。"
    ].join("\n");
  }

  private async buildGlobalRuntimeContext() {
    const servers = await this.serverService.listServers();
    const agentSettings = this.promptService.getAgentSettings();
    const serverLines = servers.length
      ? servers.map((server) => [
        `- serverId=${server.id} 名称=${server.name} 状态=${server.status}`,
        `Minecraft=${server.minecraftVersion ?? "未设置"} 整合包=${server.modpackName ?? "未设置"} 内存=${server.minMemory}/${server.maxMemory}`,
        `目录=${server.directory}`
      ].join(" ")).join("\n")
      : "当前没有任何实例";
    const running = servers.filter((server) => server.status === "running");
    return [
      "当前是全局 Agent 会话，尚未绑定任何实例。",
      "可用实例列表：",
      serverLines,
      `运行中实例数：${running.length}（后端同一时间只允许运行一个实例）`,
      `推荐内存：${agentSettings.memory}`,
      "工作方式：",
      "- 先用 list_instances 获取最新实例清单再回答或行动。",
      "- 需要只读了解某个实例（文件、配置、终端输出、报错）时，直接调用对应工具并显式传入 serverId；这些只读操作不会切换界面。",
      "- 真正要对某个实例执行写操作或长任务（部署整合包、启动/停止、改配置、装模组）时，必须调用 focus_instance 指明 serverId、语义化的 serverName、本次任务 task 和原因 reason。focus_instance 会让前端自动跳转到该实例并展示它的终端，然后把任务交接给该实例的 Agent 继续。",
      "- 创建新实例用 create_server；后端会自动套用 reference MCDReforged 模板，无需再交接模板初始化任务。返回新 serverId 后，如需继续部署就对新 serverId 调用 focus_instance。",
      "- 不要在全局会话里直接执行会长时间占用实例的写操作；先 focus_instance，把动作交给实例 Agent。",
      "对话要求：如果信息不足，先明确缺少哪些信息。回复使用标准 GFM Markdown：标题标记后必须有空格；每个标题、列表项、表格行和段落必须独占一行；列表和表格前后保留空行；不要把 Markdown 块拼接在同一行。"
    ].join("\n");
  }

  private async globalLocalFallback(input: string) {
    const servers = await this.serverService.listServers();
    const lower = input.toLowerCase();
    if (lower.includes("实例") || lower.includes("服务器") || lower.includes("服务端")) {
      return "当前还没有配置可用模型，因此使用本地引导模式。\n你可以在设置中添加 OpenAI-compatible 模型配置后再让我管理实例。\n" + (servers.length ? `当前实例：\n${servers.map((server) => `- ${server.name}（${server.status}）`).join("\n")}` : "当前还没有任何实例。");
    }
    return "当前还没有配置可用模型，因此使用本地引导模式。请先在设置中添加 OpenAI-compatible 模型配置。";
  }

  private async requestConfirmation(
    serverId: string,
    request: { title: string; description: string; risk: "medium" | "high" },
    jobSignal?: AbortSignal
  ) {
    if (jobSignal) this.throwIfAborted(jobSignal);
    if (this.promptService.getAgentAutoConfirm()) {
      this.trace(serverId, `自动确认已开启，已放行操作：${request.title}\n${request.description}`);
      return;
    }

    const confirmation = {
      id: createId("confirm"),
      serverId,
      title: request.title,
      description: request.description,
      risk: request.risk,
      createdAt: nowIso()
    };
    let onAbort: (() => void) | undefined;
    const approved = await new Promise<boolean>((resolve) => {
      // A browser is not required to stay online. Only an explicit answer or abort resolves approval.
      this.confirmations.set(confirmation.id, { request: confirmation, resolve });
      if (jobSignal) {
        onAbort = () => {
          this.confirmations.delete(confirmation.id);
          this.emit(serverId, { type: "confirmation_resolved", confirmationId: confirmation.id, approved: false });
          resolve(false);
        };
        jobSignal.addEventListener("abort", onAbort, { once: true });
      }
      this.emit(serverId, { type: "confirmation_required", confirmation });
      if (!jobSignal) this.setStatus(serverId, "waiting_confirmation");
    });
    if (onAbort) jobSignal?.removeEventListener("abort", onAbort);
    if (jobSignal) this.throwIfAborted(jobSignal);
    if (!approved) throw new Error(`用户拒绝或未确认：${confirmation.title}`);
    if (!jobSignal) this.setStatus(serverId, "running");
  }

  private async chatCompletionWithRetry(
    serverId: string,
    input: Parameters<ModelService["chatCompletionResult"]>[0],
    onDelta?: (delta: string) => void,
    onRetry?: (error: string) => void,
    onReasoningDelta?: (delta: string) => void
  ) {
    let retryAttempt = 0;
    while (true) {
      if (input.signal) this.throwIfAborted(input.signal);
      try {
        if (retryAttempt > 0) {
          this.emit(serverId, { type: "retry_cleared", status: "running" });
        }
        this.setStatus(serverId, "running");
        if (onDelta) {
          const result = await this.modelService.chatCompletionStream(input, onDelta, onReasoningDelta);
          if (!result.content && result.toolCalls.length === 0) {
            throw new ModelEmptyResponseError("模型接口流式返回了空 assistant 消息（缺少 content 或 tool_calls）");
          }
          return result;
        }
        return await this.modelService.chatCompletionResult(input);
      } catch (error) {
        if (!(error instanceof ModelRemoteError)) throw error;
        if (input.signal?.aborted) this.throwIfAborted(input.signal);
        onRetry?.(error.message);
        retryAttempt += 1;
        const isEmptyResponse = error instanceof ModelEmptyResponseError;
        const maxFailures = isEmptyResponse ? 2 : this.modelRetryMaxConsecutiveFailures;
        if (retryAttempt >= maxFailures) {
          throw isEmptyResponse
            ? new ModelRemoteError(`模型接口连续返回空 assistant 消息 ${retryAttempt} 次，已停止自动重试。通常是模型上下文过大、输出被上游网关截断，或该模型/网关不完全兼容 OpenAI Chat Completions。最后错误：${error.message}`)
            : new ModelRemoteError(`模型接口连续异常 ${retryAttempt} 次，已停止自动重试。最后错误：${error.message}`);
        }
        const delayMs = this.modelRetryDelayMs(retryAttempt);
        const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
        const retry = { attempt: retryAttempt, delayMs, nextRetryAt, message: error.message };
        const run = this.activeRuns.get(serverId);
        if (run) run.retry = retry;
        const retryId = this.startActivity(serverId, { kind: "retry", title: `模型请求重试 · 第 ${retryAttempt} 次`, attempt: retryAttempt, nextRetryAt, error: error.message });
        this.setStatus(serverId, "retrying");
        this.emit(serverId, {
          type: "retry_scheduled",
          status: "retrying",
          retry
        });
        this.appendAgentConsoleLog(serverId, `模型接口异常，${Math.ceil(delayMs / 1000)} 秒后重试（第 ${retryAttempt} 次）：${error.message}`);
        await this.waitForModelRetry(serverId, delayMs, input.signal);
        if (run) run.retry = undefined;
        this.finishActivity(serverId, retryId, "completed", "已重新发送模型请求。");
      }
    }
  }

  private modelRetryDelayMs(attempt: number) {
    return Math.min(this.modelRetryMaxDelayMs, this.modelRetryBaseDelayMs * 2 ** Math.max(0, attempt - 1));
  }

  private async waitForModelRetry(serverId: string, delayMs: number, signal?: AbortSignal) {
    await new Promise<void>((resolve, reject) => {
      const run = this.activeRuns.get(serverId);
      let settled = false;
      const cleanup = () => {
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (run?.retryNow === retryNow) run.retryNow = undefined;
      };
      const finish = () => {
        if (settled) return;
        cleanup();
        resolve();
      };
      const onAbort = () => {
        if (settled) return;
        cleanup();
        reject(new Error("Agent 操作已中断"));
      };
      const retryNow = finish;
      const timer = setTimeout(finish, delayMs);
      if (run) run.retryNow = retryNow;
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private saveMessage(scopeId: string, role: AgentRole, content: string, status?: AgentStatus, id = createId("msg"), focusServerId: string | null = null) {
    if (isGlobalScope(scopeId)) {
      getDb().insert(globalAgentMessages).values({
        id,
        conversationId: GLOBAL_SCOPE_ID,
        turnId: this.activeRuns.get(scopeId)?.execution.id, stepId: this.activeRuns.get(scopeId)?.stepId,
        role,
        content,
        status: status ?? null,
        focusServerId,
        createdAt: nowIso()
      }).run();
      return;
    }
    getDb().insert(agentMessages).values({
      id,
      serverId: scopeId,
      turnId: this.activeRuns.get(scopeId)?.execution.id, stepId: this.activeRuns.get(scopeId)?.stepId,
      role,
      content,
      status: status ?? null,
      createdAt: nowIso()
    }).run();
  }

  private setStatus(serverId: string, status: AgentStatus) {
    for (const [id, entry] of this.activeRuns.get(serverId)?.activities ?? []) {
      if (entry.activity.kind !== "tool") continue;
      if (status === "waiting_confirmation" && entry.activity.status === "running") {
        entry.activity.status = "waiting_confirmation";
        this.publishActivity(serverId, id);
      } else if (status === "running" && entry.activity.status === "waiting_confirmation") {
        entry.activity.status = "running";
        this.publishActivity(serverId, id);
      }
    }
    this.statusByServer.set(serverId, status);
    const run = this.activeRuns.get(serverId);
    if (run) {
      if (status !== "idle") run.execution.status = status;
      this.executions.save(run.execution);
      if ((status === "failed" || status === "cancelled") && run.stepId) {
        const step = this.executions.steps(run.execution.id).find((entry) => entry.id === run.stepId);
        if (step && step.status !== "completed") {
          step.status = status;
          step.finishedAt = nowIso();
          this.executions.saveStep(step);
        }
      }
    }
    this.emit(serverId, { type: "status", status });
  }

  isBusy(serverId: string) {
    const status = this.getStatus(serverId);
    return this.activeRuns.has(serverId) || status === "thinking" || status === "running" || status === "waiting_confirmation" || status === "retrying";
  }

  private emit(serverId: string, event: AgentEvent) {
    const state = this.presentation.get(serverId) ?? { downloads: [], workflow: null, toolConfigRequired: null, focus: null };
    if (event.type === "download_progress" && event.download) {
      state.downloads = [...state.downloads.filter((item) => item.id !== event.download!.id), event.download].slice(-100);
    }
    if (event.type === "workflow_progress") {
      state.workflow = event.workflow ?? null;
      const execution = this.activeRuns.get(serverId)?.execution;
      if (execution && event.workflow) {
        execution.workflowProgress = event.workflow;
        this.executions.save(execution);
      }
    }
    if (event.type === "tool_config_required") state.toolConfigRequired = event.toolConfigRequired ?? null;
    if (event.type === "focus_instance" && event.focus) {
      state.focus = { ...event.focus, id: createId("focus") };
      event = { ...event, focus: state.focus };
    }
    this.presentation.set(serverId, state);
    const run = this.activeRuns.get(serverId);
    eventBus.emit("agent", { serverId, event: { ...event, turnId: run?.execution.id, stepId: run?.stepId } });
  }
}
