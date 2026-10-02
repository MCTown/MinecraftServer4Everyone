import { eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
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

/** Conversation id for the dashboard-level agent that spans all instances. */
const GLOBAL_SCOPE_ID = "global";

function isGlobalScope(scopeId: string) {
  return scopeId === GLOBAL_SCOPE_ID;
}

interface PendingConfirmation {
  request: AgentConfirmationRequest;
  resolve: (approved: boolean) => void;
  timeout: NodeJS.Timeout;
}

interface ActiveRun {
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
  private statusByServer = new Map<string, AgentStatus>();
  private confirmations = new Map<string, PendingConfirmation>();
  private activeRuns = new Map<string, ActiveRun>();
  private installedCapabilitiesByServer = new Map<string, Set<AgentCapabilityId>>();
  private lastUsageByServer = new Map<string, { actualTokens: number; estimatedTokens: number }>();
  /** Per-conversation model override (model name); falls back to the default config. */
  private modelOverrideByScope = new Map<string, string>();
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
      if (message.activity && ["running", "waiting_confirmation"].includes(message.activity.status)) {
        return { ...message, status: "cancelled", activity: { ...message.activity, status: "cancelled" as const, error: "服务已重启，本次执行未完成。" } };
      }
      return message;
    });
    const run = this.activeRuns.get(scopeId);
    if (run?.partialContent && !messages.some((message) => message.id === run.responseMessageId)) {
      messages.push({
        id: run.responseMessageId,
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
    const systemPrompt = await this.promptService.getEffectivePrompt(serverId);
    const runtimeContext = await this.buildRuntimeContext(serverId);
    const messages = this.buildContextMessages(serverId, systemPrompt, runtimeContext);
    
    // Include tools definitions in the estimate
    const tools = this.createTools(serverId, new AbortController().signal);
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
      remainingPercent: Math.round(remainingRatio * 100)
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

  private async runScope(scopeId: string, content: string, reasoningEffort: ReasoningEffort) {
    const normalizedContent = content.trim();
    if (!normalizedContent) throw new Error("消息内容不能为空");
    if (this.isBusy(scopeId)) {
      throw new Error("Agent 正在处理上一条任务，请等待完成或先处理确认弹窗");
    }

    const responseMessageId = createId("msg");
    const controller = new AbortController();
    this.activeRuns.set(scopeId, { controller, responseMessageId, activities: new Map(), partialContent: "" });
    this.saveMessage(scopeId, "user", normalizedContent);
    this.appendAgentConsoleLog(scopeId, `开始任务：${this.formatConsolePayload(normalizedContent)}`);
    this.setStatus(scopeId, "thinking");
    try {
      const response = await this.runAgent(scopeId, normalizedContent, reasoningEffort, responseMessageId, controller.signal);
      const focusServerId = this.activeRuns.get(scopeId)?.focusServerId ?? null;
      this.saveMessage(scopeId, "agent", response, "completed", responseMessageId, focusServerId);
      this.emit(scopeId, { type: "message", messageId: responseMessageId, content: response, status: "completed" });
      this.setStatus(scopeId, "completed");
      this.appendAgentConsoleLog(scopeId, "任务完成");
      this.emit(scopeId, { type: "done", status: "completed" });
      return response;
    } catch (error) {
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
      // Start the instance agent after this run fully completes, so the two
      // conversations never interleave their status events.
      if (handoff) void this.dispatchFocusHandoff(handoff);
    }
  }

  cancel(serverId: string) {
    const run = this.activeRuns.get(serverId);
    if (!run) {
      if (this.isBusy(serverId)) this.setStatus(serverId, "cancelled");
      return { cancelled: false };
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
    this.setStatus(scopeId, "idle");
    return { ok: true };
  }

  /** Context accounting for the global conversation (no bound server). */
  async getGlobalContextUsage() {
    const systemPrompt = this.promptService.getGlobalPrompt();
    const runtimeContext = await this.buildGlobalRuntimeContext();
    const messages: ChatMessageInput[] = [{ role: "system", content: `${systemPrompt}\n\n${this.agentToolAvailabilityInstructions()}\n\n${runtimeContext}\n\n${this.agentRecoveryInstructions()}` }];
    messages.push(...this.listScopeMessages(GLOBAL_SCOPE_ID)
      .filter((message) => message.role !== "system")
      .slice(-20)
      .map<ChatMessageInput>((message) => ({
        role: message.role === "agent" ? "assistant" as const : "user" as const,
        content: message.content
      })));
    const toolDefinitions = this.createGlobalTools(new AbortController().signal).map((tool) => tool.definition);
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
      remainingPercent: Math.round(remainingRatio * 100)
    };
  }

  releaseServer(serverId: string) {
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
    const messages: ChatMessageInput[] = [];
    messages.push({ role: "system", content: `${systemPrompt}\n\n${this.agentToolAvailabilityInstructions()}\n\n${runtimeContext}\n\n${this.agentRecoveryInstructions()}` });
    messages.push(...this.listScopeMessages(scopeId)
      .filter((message) => message.role !== "system")
      .slice(-20)
      .map<ChatMessageInput>((message) => ({
        role: message.role === "agent" ? "assistant" as const : "user" as const,
        content: message.content
      })));
    return messages;
  }

  private shouldAutoCompressContext(scopeId: string, messages: ChatMessageInput[], makeTools: () => AgentTool[]) {
    if (this.listScopeMessages(scopeId).filter((message) => message.role !== "system").length <= this.contextCompressKeepRecentMessages) return false;
    const tools = makeTools().map((tool) => tool.definition);
    const estimatedTokens = this.estimateModelContextTokens(messages, tools);
    return estimatedTokens > this.getModelContextMaxEstimatedTokens() * this.contextAutoCompressRatio;
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
    const global = isGlobalScope(serverId);
    const modelConfig = this.resolveModelConfig(serverId);
    if (!modelConfig) {
      this.throwIfAborted(signal);
      return global ? this.globalLocalFallback(input) : this.localFallback(serverId, input);
    }

    this.setStatus(serverId, "running");
    const systemPrompt = global ? this.promptService.getGlobalPrompt() : await this.promptService.getEffectivePrompt(serverId);
    const runtimeContext = global ? await this.buildGlobalRuntimeContext() : await this.buildRuntimeContext(serverId);
    const makeTools = () => global ? this.createGlobalTools(signal) : this.createTools(serverId, signal);
    let messages = this.buildContextMessages(serverId, systemPrompt, runtimeContext);
    if (this.shouldAutoCompressContext(serverId, messages, makeTools)) {
      this.trace(serverId, "上下文占用接近上限，正在自动压缩历史消息。");
      try {
        await this.compressContextInternal(serverId);
        this.lastUsageByServer.delete(serverId);
        messages = this.buildContextMessages(serverId, systemPrompt, runtimeContext);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.trace(serverId, `自动压缩上下文失败：${message}。将按当前上下文继续，若超出上限将停止。`);
      }
    }
    try {
      for (let step = 0; step < 500; step += 1) {
        this.throwIfAborted(signal);
        const tools = makeTools();
        const toolDefinitions = tools.map((tool) => tool.definition);
        this.ensureModelContextWithinLimit(messages, toolDefinitions);
        const toolMap = new Map(tools.map((tool) => [tool.definition.function.name, tool]));
        let streamedContent = "";
        let reasoningId: string | undefined;
        const onReasoning = (delta: string) => {
          reasoningId ??= this.startActivity(serverId, { kind: "reasoning", title: "思考过程" });
          this.appendActivityDelta(serverId, reasoningId, delta);
        };
        const result = await this.chatCompletionWithRetry(serverId, {
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
          // Final natural-language reply stays on the run response bubble (saved by sendMessage).
          if (visibleContent && !streamedContent) {
            this.emit(serverId, { type: "message", messageId: responseMessageId, content: visibleContent, status: "running" });
          }
          return visibleContent || result.content;
        }
        // Preserve intermediate assistant narration as its own completed message before clearing the shared bubble for tool rounds.
        if (visibleContent) {
          const intermediateMessageId = createId("msg");
          this.saveMessage(serverId, "agent", visibleContent, "completed", intermediateMessageId);
          this.emit(serverId, { type: "message", messageId: intermediateMessageId, content: visibleContent, status: "completed" });
          this.emit(serverId, { type: "message", messageId: responseMessageId, content: "", status: "running" });
          const run = this.activeRuns.get(serverId);
          if (run) { run.partialContent = ""; run.responseCreatedAt = undefined; }
        }
        const assistantMessage: ChatMessageInput = { role: "assistant", content: result.content || null, tool_calls: result.toolCalls };
        messages.push(assistantMessage);
        for (const toolCall of result.toolCalls) {
          this.throwIfAborted(signal);
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
            continue;
          }
          this.appendAgentConsoleLog(serverId, `执行工具：${toolCall.function.name}\n参数：${this.formatConsolePayload(args)}`);
          this.throwIfAborted(signal);
          let content: string;
          try {
            content = await this.executeToolForModel(serverId, toolCall.function.name, tool, args, signal);
          } catch (error) {
            this.finishActivity(serverId, activityId, "cancelled", "", error instanceof Error ? error.message : String(error));
            throw error;
          }
          this.throwIfAborted(signal);
          const failed = content.startsWith("TOOL_ERROR");
          this.finishActivity(serverId, activityId, failed ? "failed" : "completed", content,
            failed ? content.split("错误：")[1]?.split("\n恢复策略：")[0]?.trim() || content : undefined);
          this.appendAgentConsoleLog(serverId, `${content.startsWith("TOOL_ERROR") ? "工具失败" : "工具完成"}：${toolCall.function.name}`);
          const toolMessage: ChatMessageInput = { role: "tool", content, tool_call_id: toolCall.id };
          messages.push(toolMessage);
        }
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

  private createTools(serverId: string, signal: AbortSignal) {
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
      downloadProxyUrl: () => this.promptService.getAgentDownloadProxyUrl(),
      getPythonPackageIndexUrl: () => this.promptService.getPythonPackageIndexUrl(),
      getCurseForgeApiKey: () => this.promptService.getCurseForgeApiKey(),
      getModrinthApiKey: () => this.promptService.getModrinthApiKey(),
      getBraveSearchApiKey: () => this.promptService.getBraveSearchApiKey(),
      getTavilyApiKey: () => this.promptService.getTavilyApiKey(),
      getSearxngBaseUrl: () => this.promptService.getSearxngBaseUrl(),
      toolConfigRequired: (toolConfigRequired) => this.emit(serverId, { type: "tool_config_required", toolConfigRequired }),
      installedCapabilities,
      installCapability: (capability) => this.installCapability(serverId, capability),
      confirm: (request) => this.requestConfirmation(serverId, request),
      progress: (download) => this.emit(serverId, { type: "download_progress", download }),
      workflowProgress: (workflow) => this.emit(serverId, { type: "workflow_progress", workflow }),
      serverSlotStatus: (serverSlot) => this.emit(serverId, { type: "server_slot", serverSlot }),
      consoleLog: (text, stream) => this.appendAgentConsoleLog(serverId, text, stream)
    });
  }

  /**
   * Tools for the dashboard-level agent. Each instance tool takes an explicit
   * serverId, so the global conversation can inspect and orchestrate instances
   * without being bound to one. focus_instance records the handoff target.
   */
  private createGlobalTools(signal: AbortSignal) {
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
      downloadProxyUrl: () => this.promptService.getAgentDownloadProxyUrl(),
      getPythonPackageIndexUrl: () => this.promptService.getPythonPackageIndexUrl(),
      getCurseForgeApiKey: () => this.promptService.getCurseForgeApiKey(),
      getModrinthApiKey: () => this.promptService.getModrinthApiKey(),
      getBraveSearchApiKey: () => this.promptService.getBraveSearchApiKey(),
      getTavilyApiKey: () => this.promptService.getTavilyApiKey(),
      getSearxngBaseUrl: () => this.promptService.getSearxngBaseUrl(),
      toolConfigRequired: (toolConfigRequired: AgentToolConfigRequired) => this.emit(scopeId, { type: "tool_config_required", toolConfigRequired }),
      confirm: (request: { title: string; description: string; risk: "medium" | "high" }) => this.requestConfirmation(scopeId, request),
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
    }
    this.emit(scopeId, { type: "focus_instance", focus });
  }

  /**
   * After a global run hands a task to an instance, kick off the instance agent
   * so the work continues where the user was sent. Failures here only affect the
   * instance conversation, never the completed global handoff.
   */
  private async dispatchFocusHandoff(handoff: { focusServerId: string; focusTask: string; focusReason: string }) {
    const { focusServerId, focusTask, focusReason } = handoff;
    if (!focusTask.trim()) return;
    if (this.isBusy(focusServerId)) return;
    const reasonLine = focusReason ? `\n交接原因：${focusReason}` : "";
    const prompt = [
      "【来自全局 Agent 的任务交接】",
      focusTask,
      reasonLine,
      "请从当前实例的实际情况出发，先确认现状再执行；必要时用工具检查文件、配置与终端输出。"
    ].filter(Boolean).join("\n");
    try {
      this.saveMessage(focusServerId, "system", `已接收全局 Agent 交接的任务：${focusTask}`);
      await this.sendMessage(focusServerId, prompt, "high");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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
      const content = await tool.execute(args);
      this.throwIfAborted(signal);
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
      "- 整合包服务端部署必须按顺序推进：确认整合包（检索候选并等待用户明确确认）-> 获取玩家给的服务端包并保存到当前服务端独立槽位 -> 调用 initialize_server_template(template=reference) 套用内置 MCDReforged 模板 -> 解压槽位到 server/ -> 用 update_current_server_config 将 startupCommand 切到 server/ 内脚本后直启验证 -> 调用 configure_builtin_python_environment 安装并配置内置 Python/pip/MCDReforged -> 直启成功后编辑根目录 config.yml 配置 MCDReforged，并调用 update_current_server_config 将 startupCommand 切到 {python} -m mcdreforged -> 通过 MCDReforged 最终启动验证。serverType 只是标签，不决定启动方式。",
      "- 确认整合包来源时必须同时考虑 Modrinth 和 CurseForge。只查询了其中一个平台、或其中一个平台结果不唯一/不匹配时，不得把 identify_modpack 标记为 failed；必须继续尝试另一个平台的官方 API 工具。只有两个平台都已查询且没有匹配项，或 CurseForge 因缺少/鉴权失败 API Key 需要用户配置，或用户没有提供足够名称/版本信息时，才可以失败并明确说明还缺少什么。",
      "- 确认整合包硬门禁：检索到候选后必须向用户列出名称、平台、slug/projectId、版本/MC 版本/Loader（及链接），并请求用户确认选哪一个；用户未明确确认前，禁止将 identify_modpack 标为 completed，禁止下载服务端包、解压、安装 Forge/NeoForge、改启动配置或启动服务端。不得因搜索结果看似唯一或下载量最高就自行认定并继续部署。",
      "- 每个部署阶段开始、完成或失败时都要调用 update_agent_workflow_progress。服务端包必须先进入当前服务端的独立槽位，且仅在用户确认整合包后：优先使用 save_upload_to_server_slot；没有上传时优先使用 download_modrinth_server_pack_to_server_slot 和 download_curseforge_server_pack_to_server_slot 通过平台 API 获取；最后才使用 download_https_file_to_server_slot。不要抓取 CurseForge 网页 Files 页面，不要直接把原始服务端包散落到根目录。",
      "- 服务端槽位若是 Modrinth .mrpack，禁止 extract_server_slot_to_workspace / extract_server_zip。必须先 inspect_mrpack_server_slot，再 deploy_mrpack_server_from_server_slot：只下载 server required 文件并校验哈希、合并 overrides，并安装 Vanilla/Fabric/Quilt/Forge/NeoForge 启动文件。完整 server pack zip 仍优先于 .mrpack。",
      "- CurseForge 槽位 ZIP 若根目录只有 manifest.json、overrides/、modlist.html 等清单内容，不是可直启服务端。禁止直接 extract_server_slot_to_workspace 后启动；必须调用 materialize_curseforge_manifest_pack_from_server_slot。该工具会精确按 manifest 的 projectID/fileID 下载 required 模组并复制 overrides 内容，但不会安装 Loader。若返回 Forge/NeoForge installer URL，下载该官方 installer 到 server/；Forge 启用 forge_server_setup 并调用 setup_forge_server，NeoForge 启用 neoforge_server_setup 并调用 setup_neoforge_server（minecraftVersion、neoforgeVersion、installerPath、javaPath）；若是当前未支持的 Loader，明确说明需要对应受控安装能力，禁止伪造启动成功。",
      "- CurseForge API 工具如果提示缺少或鉴权失败，或前端收到 tool_config_required，必须停止部署并让用户点击 Tools 卡片/设置中的配置按钮填写 CurseForge API Key，告知申请/管理地址 https://console.curseforge.com/?#/api-keys。Modrinth 工具如果提示需要 PAT，必须停止部署并让用户点击配置按钮填写 Modrinth PAT，告知申请/管理地址 https://modrinth.com/settings/pats。",
      "- 部署整合包时必须使用内置 reference 模板。Minecraft 服务端本体必须位于当前服务端根目录下的 server/ 子目录；mods、libraries、world、server.jar、eula.txt、user_jvm_args.txt 和服务端自带脚本都应在 server/ 内，不应放在 MCDReforged 根目录。",
      "- 布局硬门禁：每次解压、Forge/NeoForge 安装、直启验证前后都必须 list_server_files 检查根目录与 server/。若根目录出现 mods、libraries、world、run.sh/run.bat、eula.txt、server.properties、user_jvm_args.txt、server.jar 中的任一项，视为布局失败，不得把 direct_run_test/configure_mcdr/final_mcdr_test 标为 completed；必须先把 Minecraft 文件迁回 server/ 或重新按模板安装。",
      "- 安装单个模组时优先调用 download_mod_to_server_mods，通过 provider=modrinth 或 provider=curseforge 下载 .jar 到 server/mods/；不要把 .mrpack、zip 或服务端包当作单个模组安装。",
      "- 直启失败或怀疑混入客户端模组时，调用 inspect_client_only_server_mods 扫描 server/mods；确认后用 disable_client_only_server_mods 将仅客户端 jar 重命名为 .jar.disabled（不删除）。优先处理 high/medium 置信度。",
      "- 若自动扫描未覆盖但日志点名某个模组、用户要求禁用某个模组，或启动失败明确指向某个 jar/modId，调用 disable_server_mods，传入 targets（文件名、相对路径、modId 或关键词）；同样重命名为 .jar.disabled，不删除。禁用后重新启动验证。",
      "- 已存在于服务端目录内的 zip/tar.gz/tgz 需要先安装 zip_extract 能力，再用 extract_server_zip 解压到 server/；服务端槽位中的 zip/tar.gz/tgz 应使用 extract_server_slot_to_workspace，并把 destinationPath 设为 server；槽位 .mrpack 不得解压，只能走 inspect_mrpack_server_slot + deploy_mrpack_server_from_server_slot。",
      "- 直启验证前必须优先使用 server/ 内服务端包自带的 run/start/server/launch 脚本；如果没有自带脚本或脚本确实不可用，再按当前服务端配置生成启动脚本。",
      "- 启动验证前必须优先按上下文里的推荐内存写入 server/user_jvm_args.txt、server/ 内脚本 -Xms/-Xmx 或当前服务端配置。整合包有明确要求时可以调整，但不能超过推荐内存，并且必须向用户说明调整原因和最终内存值。",
      "- Forge 1.17+ 或 NeoForge 整合包需要 installer 时，分别启用 forge_server_setup/neoforge_server_setup 能力，再调用 setup_forge_server/setup_neoforge_server 写入 @libraries/.../win_args.txt 或 unix_args.txt 启动配置；不要把 installer jar 当作服务端 jar 启动。NeoForge 使用 --installServer 与 net/neoforged Maven 坐标，Minecraft 1.20.1 旧版使用 net/neoforged/forge/1.20.1-47.x 坐标，其他版本使用 net/neoforged/neoforge/<NeoForge版本>。优先使用包内 installer，缺失时从官方 Maven 下载整合包指定的精确版本。在 reference 模板下必须安装进 server/，禁止安装或提升到 MCDR 根目录。",
      "- setup_forge_server/setup_neoforge_server 返回 ok=true 只表示 Loader 已装进 installRoot（MCDR 下为 server/），绝不表示部署完成。必须：list_server_files 确认根目录无 Minecraft 本体文件；用 update_current_server_config 把 startupCommand 设为 server/ 内脚本后直启验证；调用 configure_builtin_python_environment；编辑根目录 config.yml（working_directory=server、start_command 从 server/ 启动、handler 正确）；再把 startupCommand 设为 {python} -m mcdreforged 做最终验证。未完成 configure_builtin_python_environment + config.yml + MCDR startupCommand 时，禁止将 configure_python/configure_mcdr/final_mcdr_test 标为 completed。",
      "- MCDReforged 最终启动后必须读取控制台及 logs/，确认每个已启用插件成功加载。若日志或插件 requirements 文件明确报告缺少 Python 模块/依赖，精确提取包名和版本约束，调用 install_mcdreforged_plugin_dependencies 安装到 workspace/python；停止残留进程后重启 MCDReforged 并复查日志。禁止使用系统 Python、猜测包名或安装无关依赖。插件仍缺依赖、安装失败或无法加载时，final_mcdr_test 必须保持 failed，并向用户报告插件名、依赖和错误。",
      "- 只有用户拒绝确认、用户中断、或确实缺少外部文件/信息时，才向用户说明无法继续的具体原因。"
    ].join("\n");
  }

  private agentToolAvailabilityInstructions() {
    return [
      "运行时工具事实（优先级高于保存的旧提示词和对话历史）：",
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
        activity: entry.activity, status: entry.activity.status, createdAt: entry.activity.startedAt
      }).onConflictDoUpdate({ target: globalAgentMessages.id, set: {
        content: entry.content, activity: entry.activity, status: entry.activity.status
      } }).run();
      entry.persistedAt = Date.now();
      return;
    }
    getDb().insert(agentMessages).values({ id, serverId: scopeId, role: "system", content: entry.content,
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
      "配置策略：Agent 在部署或调整服务端时必须调用 update_current_server_config 写入服务端名字、Java 版本/路径、内存和必要的统一启动指令；内存只能使用一个值，并同时写入 minMemory 和 maxMemory，优先使用推荐内存；Java 版本优先使用推荐 Java 版本，必要时先安装对应工作区 Java；startupCommand 可使用 {java}/{javaHome}/{python}/{pythonHome}/{workspace}/{serverDir}/{minecraftDir}/{memory}/{minMemory}/{maxMemory}/{jarFile}/{startArgs} 变量。serverType 只是展示/分类标签，不决定启动方式。",
      "模板部署约束：整合包部署必须调用 initialize_server_template(template=reference) 套用内置 MCDReforged 模板；Minecraft 服务端本体必须放在 server/ 子目录；根目录用于 MCDReforged 的 config.yml、permission.yml、plugins/、config/、logs/。若根目录出现 mods/libraries/world/run.sh/eula.txt 等 Minecraft 文件，布局失败，必须先修复。",
      "启动策略：start_current_server 只有一种后端启动路径，按当前配置执行。直启验证前先把 startupCommand 设置为进入 server/ 并调用服务端自带 run/start/server/launch 脚本的非交互命令；直启成功后必须先调用 configure_builtin_python_environment 下载并配置工作区内置 Python 3.10/pip/MCDReforged，不要直接使用或要求系统 Python、venv 或 ensurepip。MCDReforged 最终验证需要编辑根目录 config.yml，使 working_directory=server、start_command 从 server/ 工作目录启动服务端、handler 符合核心/Loader，并把 startupCommand 设置为 {python} -m mcdreforged。启动后必须检查控制台和 logs/ 中每个已启用插件的加载结果；若明确缺少 Python 依赖，调用 install_mcdreforged_plugin_dependencies 仅安装日志或 requirements 文件声明的包，重启后复查。未配置内置 Python、未正确编辑 config.yml、startupCommand 仍不是 {python} -m mcdreforged，或插件仍因依赖无法加载时，部署不算完成。切换启动方式前先用 get_current_server_config 查看现状，必要时用 stop_current_server 或 kill_current_server 停止/清理残留进程。",
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
      return "请在设置中添加 OpenAI-compatible 模型配置后，让 Agent 调用 initialize_server_template(template=reference) 套用内置 MCDReforged 模板。Minecraft 服务端文件必须放入 server/ 目录。";
    }

    return [
      "当前还没有配置可用模型，因此使用本地引导模式。",
      `当前服务端：${server.name}`,
      `目录文件数量：${files.length}`,
      `推荐 Java 版本：${javaVersion}`,
      "你可以先在设置中添加 OpenAI-compatible 模型配置，或让我执行：初始化模板、检查 Java、说明部署步骤。"
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
      "- 创建新实例用 create_server；返回新 serverId 后，如需继续部署就对新 serverId 调用 focus_instance。",
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
    request: { title: string; description: string; risk: "medium" | "high" }
  ) {
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
    const approved = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        this.confirmations.delete(confirmation.id);
        this.emit(serverId, { type: "confirmation_resolved", confirmationId: confirmation.id, approved: false });
        resolve(false);
      }, 10 * 60 * 1000);
      this.confirmations.set(confirmation.id, { request: confirmation, resolve, timeout });
      this.emit(serverId, { type: "confirmation_required", confirmation });
      this.setStatus(serverId, "waiting_confirmation");
    });
    if (!approved) throw new Error(`用户拒绝或未确认：${confirmation.title}`);
    this.setStatus(serverId, "running");
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
    this.emit(serverId, { type: "status", status });
  }

  isBusy(serverId: string) {
    const status = this.getStatus(serverId);
    return this.activeRuns.has(serverId) || status === "thinking" || status === "running" || status === "waiting_confirmation" || status === "retrying";
  }

  private emit(serverId: string, event: AgentEvent) {
    eventBus.emit("agent", { serverId, event });
  }
}
