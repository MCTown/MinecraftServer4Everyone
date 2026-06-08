import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { agentMessages } from "../db/schema.js";
import type { AgentConfirmationRequest, AgentEvent, AgentRole, AgentStatus, ConsoleLogEntry } from "../types.js";
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
import { createAgentTools, type AgentCapabilityId, type AgentTool } from "./tools.js";

interface PendingConfirmation {
  request: AgentConfirmationRequest;
  resolve: (approved: boolean) => void;
  timeout: NodeJS.Timeout;
}

interface ActiveRun {
  controller: AbortController;
  responseMessageId: string;
  retryNow?: () => void;
}

export class AgentService {
  private statusByServer = new Map<string, AgentStatus>();
  private confirmations = new Map<string, PendingConfirmation>();
  private activeRuns = new Map<string, ActiveRun>();
  private installedCapabilitiesByServer = new Map<string, Set<AgentCapabilityId>>();
  private readonly modelRetryBaseDelayMs = 5000;
  private readonly modelRetryMaxDelayMs = 120000;
  private readonly modelRetryMaxConsecutiveFailures = 5;
  private readonly modelContextMaxEstimatedTokens = 120000;
  private readonly modelToolResultMaxChars = 12000;

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

  listMessages(serverId: string) {
    return getDb()
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.serverId, serverId))
      .orderBy(agentMessages.createdAt)
      .all()
      .map((row) => ({
        id: row.id,
        serverId: row.serverId,
        role: row.role as AgentRole,
        content: row.content,
        status: row.status,
        createdAt: row.createdAt
      }));
  }

  async sendMessage(serverId: string, content: string, reasoningEffort: ReasoningEffort = "high") {
    await this.serverService.requireServer(serverId);
    const normalizedContent = content.trim();
    if (!normalizedContent) throw new Error("消息内容不能为空");
    if (this.isBusy(serverId)) {
      throw new Error("Agent 正在处理上一条任务，请等待完成或先处理确认弹窗");
    }

    const responseMessageId = createId("msg");
    const controller = new AbortController();
    this.activeRuns.set(serverId, { controller, responseMessageId });
    this.saveMessage(serverId, "user", normalizedContent);
    this.appendAgentConsoleLog(serverId, `开始任务：${this.formatConsolePayload(normalizedContent)}`);
    this.setStatus(serverId, "thinking");
    try {
      const response = await this.runAgent(serverId, normalizedContent, reasoningEffort, responseMessageId, controller.signal);
      this.saveMessage(serverId, "agent", response, "completed", responseMessageId);
      this.emit(serverId, { type: "message", messageId: responseMessageId, content: response, status: "completed" });
      this.setStatus(serverId, "completed");
      this.appendAgentConsoleLog(serverId, "任务完成");
      this.emit(serverId, { type: "done", status: "completed" });
      return response;
    } catch (error) {
      if (this.isAbortError(error) || controller.signal.aborted) {
        const response = "Agent 操作已中断";
        this.saveMessage(serverId, "agent", response, "cancelled", responseMessageId);
        this.emit(serverId, { type: "message", messageId: responseMessageId, content: response, status: "cancelled" });
        this.setStatus(serverId, "cancelled");
        this.appendAgentConsoleLog(serverId, "任务已中断");
        this.emit(serverId, { type: "done", status: "cancelled" });
        return response;
      }
      const message = error instanceof Error ? error.message : String(error);
      const response = `执行失败：${message}`;
      this.saveMessage(serverId, "agent", response, "failed", responseMessageId);
      this.emit(serverId, { type: "error", messageId: responseMessageId, content: response, status: "failed" });
      this.setStatus(serverId, "failed");
      this.appendAgentConsoleLog(serverId, `任务失败：${message}`);
      return response;
    } finally {
      this.activeRuns.delete(serverId);
    }
  }

  cancel(serverId: string) {
    const run = this.activeRuns.get(serverId);
    if (!run) {
      this.setStatus(serverId, "cancelled");
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
    this.emit(serverId, { type: "retry_cleared", status: "running" });
    this.appendAgentConsoleLog(serverId, "用户已请求立即重试模型接口。");
    return { retried: true };
  }

  async clearContext(serverId: string) {
    await this.serverService.requireServer(serverId);
    if (this.isBusy(serverId)) {
      throw new Error("Agent 正在处理任务，请先中断或等待完成后再清除上下文");
    }
    for (const [confirmationId, pending] of this.confirmations.entries()) {
      if (pending.request.serverId !== serverId) continue;
      clearTimeout(pending.timeout);
      this.confirmations.delete(confirmationId);
      pending.resolve(false);
      this.emit(serverId, { type: "confirmation_resolved", confirmationId, approved: false });
    }
    getDb().delete(agentMessages).where(eq(agentMessages.serverId, serverId)).run();
    this.setStatus(serverId, "idle");
    return { ok: true };
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

  private async runAgent(serverId: string, input: string, reasoningEffort: ReasoningEffort, responseMessageId: string, signal: AbortSignal) {
    const modelConfig = this.modelService.getDecryptedDefault();
    if (!modelConfig) {
      this.throwIfAborted(signal);
      return this.localFallback(serverId, input);
    }

    this.setStatus(serverId, "running");
    const systemPrompt = await this.promptService.getEffectivePrompt(serverId);
    const runtimeContext = await this.buildRuntimeContext(serverId);
    const installedCapabilities = this.getInstalledCapabilities(serverId);
    const makeTools = () => createAgentTools({
        serverId,
        serverService: this.serverService,
        fileService: this.fileService,
        processManager: this.processManager,
        uploadService: this.uploadService,
        javaService: this.javaService,
        signal,
        downloadProxyUrl: () => this.promptService.getAgentDownloadProxyUrl(),
        getCurseForgeApiKey: () => this.promptService.getCurseForgeApiKey(),
        getModrinthApiKey: () => this.promptService.getModrinthApiKey(),
        toolConfigRequired: (toolConfigRequired) => this.emit(serverId, { type: "tool_config_required", toolConfigRequired }),
        installedCapabilities,
        installCapability: (capability) => this.installCapability(serverId, capability),
        confirm: (request) => this.requestConfirmation(serverId, request),
        progress: (download) => this.emit(serverId, { type: "download_progress", download }),
        workflowProgress: (workflow) => this.emit(serverId, { type: "workflow_progress", workflow }),
        serverSlotStatus: (serverSlot) => this.emit(serverId, { type: "server_slot", serverSlot }),
        consoleLog: (text, stream) => this.appendAgentConsoleLog(serverId, text, stream)
      });
    const messages: ChatMessageInput[] = [];
    messages.push({ role: "system", content: `${systemPrompt}\n\n${runtimeContext}\n\n${this.agentRecoveryInstructions()}` });
    messages.push(...this.listMessages(serverId).filter((message) => message.role !== "system").slice(-20).map<ChatMessageInput>((message) => ({
        role: message.role === "agent" ? "assistant" as const : message.role === "system" ? "system" as const : "user" as const,
        content: message.content
      })));
    try {
      for (let step = 0; step < 500; step += 1) {
        this.throwIfAborted(signal);
        const tools = makeTools();
        const toolDefinitions = tools.map((tool) => tool.definition);
        this.ensureModelContextWithinLimit(messages, toolDefinitions);
        const toolMap = new Map(tools.map((tool) => [tool.definition.function.name, tool]));
        const result = await this.chatCompletionWithRetry(serverId, {
          baseUrl: modelConfig.baseUrl,
          modelName: modelConfig.modelName,
          apiKey: modelConfig.apiKey,
          temperature: 0.2,
          reasoningEffort,
          messages,
          tools: toolDefinitions,
          signal
        });
        this.throwIfAborted(signal);
        if (result.reasoning) {
          this.trace(serverId, `思考过程：\n${result.reasoning}`);
        }
        if (result.toolCalls.length === 0) {
          this.emit(serverId, { type: "message_delta", messageId: responseMessageId, content: result.content });
          return result.content;
        }
        const assistantMessage: ChatMessageInput = { role: "assistant", content: result.content || null, tool_calls: result.toolCalls };
        messages.push(assistantMessage);
        for (const toolCall of result.toolCalls) {
          const tool = toolMap.get(toolCall.function.name);
          const args = this.parseToolArguments(toolCall.function.arguments);
          this.trace(serverId, `调用工具：${toolCall.function.name}\n参数：${this.formatTracePayload(args)}`);
          this.appendAgentConsoleLog(serverId, `执行工具：${toolCall.function.name}\n参数：${this.formatConsolePayload(args)}`);
          this.throwIfAborted(signal);
          const content = await this.executeToolForModel(serverId, toolCall.function.name, tool, args, signal);
          this.throwIfAborted(signal);
          this.trace(serverId, `工具结果：${toolCall.function.name}\n${this.formatTracePayload(content)}`);
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
      this.trace(serverId, `工具调用失败，已交给 Agent 尝试恢复：${toolName}\n${message}`);
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

  private ensureModelContextWithinLimit(messages: ChatMessageInput[], tools: AgentTool["definition"][]) {
    const estimatedTokens = this.estimateModelContextTokens(messages, tools);
    if (estimatedTokens <= this.modelContextMaxEstimatedTokens) return;
    throw new Error([
      `模型请求上下文预计约 ${estimatedTokens} tokens，超过安全上限 ${this.modelContextMaxEstimatedTokens}，已停止发送以避免上游返回空 assistant 消息。`,
      "请清除 Agent 上下文、拆分任务，或让 Agent 只读取更具体的日志/文件片段后重试。"
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
      "- 整合包服务端部署必须按顺序推进：确认整合包 -> 获取玩家给的服务端包并保存到当前服务端独立槽位 -> 调用 initialize_server_template(template=reference) 套用内置 MCDReforged 模板 -> 解压槽位到 server/ -> 用 update_current_server_config 将 startupCommand 切到 server/ 内脚本后直启验证 -> 调用 configure_builtin_python_environment 安装并配置内置 Python/pip/MCDReforged -> 直启成功后编辑根目录 config.yml 配置 MCDReforged，并调用 update_current_server_config 将 startupCommand 切到 {python} -m mcdreforged -> 通过 MCDReforged 最终启动验证。serverType 只是标签，不决定启动方式。",
      "- 确认整合包来源时必须同时考虑 Modrinth 和 CurseForge。只查询了其中一个平台、或其中一个平台结果不唯一/不匹配时，不得把 identify_modpack 标记为 failed；必须继续尝试另一个平台的官方 API 工具。只有两个平台都已查询且没有匹配项，或 CurseForge 因缺少/鉴权失败 API Key 需要用户配置，或用户没有提供足够名称/版本信息时，才可以失败并明确说明还缺少什么。",
      "- 每个部署阶段开始、完成或失败时都要调用 update_agent_workflow_progress。服务端包必须先进入当前服务端的独立槽位，优先使用 save_upload_to_server_slot；没有上传时优先使用 download_modrinth_server_pack_to_server_slot 和 download_curseforge_server_pack_to_server_slot 通过平台 API 获取；最后才使用 download_https_file_to_server_slot。不要抓取 CurseForge 网页 Files 页面，不要直接把原始服务端包散落到根目录。",
      "- CurseForge API 工具如果提示缺少或鉴权失败，或前端收到 tool_config_required，必须停止部署并让用户点击 Tools 卡片/设置中的配置按钮填写 CurseForge API Key，告知申请/管理地址 https://console.curseforge.com/?#/api-keys。Modrinth 工具如果提示需要 PAT，必须停止部署并让用户点击配置按钮填写 Modrinth PAT，告知申请/管理地址 https://modrinth.com/settings/pats。",
      "- 部署整合包时必须使用内置 reference 模板。Minecraft 服务端本体必须位于当前服务端根目录下的 server/ 子目录；mods、libraries、world、server.jar、eula.txt、user_jvm_args.txt 和服务端自带脚本都应在 server/ 内，不应放在 MCDReforged 根目录。",
      "- 安装单个模组时优先调用 download_mod_to_server_mods，通过 provider=modrinth 或 provider=curseforge 下载 .jar 到 server/mods/；不要把 .mrpack、zip 或服务端包当作单个模组安装。",
      "- 已存在于服务端目录内的 zip/tar.gz/tgz 需要先安装 zip_extract 能力，再用 extract_server_zip 解压到 server/；服务端槽位中的 zip/tar.gz/tgz 应使用 extract_server_slot_to_workspace，并把 destinationPath 设为 server。",
      "- 直启验证前必须优先使用 server/ 内服务端包自带的 run/start/server/launch 脚本；如果没有自带脚本或脚本确实不可用，再按当前服务端配置生成启动脚本。",
      "- 启动验证前必须优先按上下文里的推荐内存写入 server/user_jvm_args.txt、server/ 内脚本 -Xms/-Xmx 或当前服务端配置。整合包有明确要求时可以调整，但不能超过推荐内存，并且必须向用户说明调整原因和最终内存值。",
      "- Forge 1.17+ 整合包如果需要运行 forge installer 生成 libraries 参数文件，先安装 forge_server_setup 能力，再用 setup_forge_server 写入 @libraries/.../win_args.txt 或 unix_args.txt 启动配置；不要把 installer jar 当作服务端 jar 启动。",
      "- setup_forge_server 返回 ok=true 后，Forge 服务端已安装；如果是 MCDReforged 模板部署，仍需确认 Minecraft 服务端文件在 server/ 内，并编辑根目录 config.yml 使 working_directory=server、start_command 和 handler 正确。",
      "- 只有用户拒绝确认、用户中断、或确实缺少外部文件/信息时，才向用户说明无法继续的具体原因。"
    ].join("\n");
  }

  private parseToolArguments(args: string) {
    try {
      const parsed = args ? JSON.parse(args) : {};
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }

  private formatTracePayload(value: unknown) {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return text.length > 1600 ? `${text.slice(0, 1600)}\n...（已截断）` : text;
  }

  private formatConsolePayload(value: unknown) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > 500 ? `${text.slice(0, 500)}...（已截断）` : text;
  }

  private appendAgentConsoleLog(serverId: string, content: string, stream: ConsoleLogEntry["stream"] = "system") {
    if (!content) return;
    const normalized = content.endsWith("\n") ? content : `${content}\n`;
    const text = stream === "system"
      ? `${normalized.trimEnd().split(/\r?\n/).map((line) => `[Agent] ${line}`).join("\n")}\n`
      : normalized;
    try {
      this.consoleLogService.append(serverId, stream, text);
    } catch {
      // Agent console mirroring should never interrupt the actual Agent run.
    }
  }

  private trace(serverId: string, content: string) {
    this.saveMessage(serverId, "system", content);
    this.emit(serverId, { type: "log", content });
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
      "配置策略：Agent 在部署或调整服务端时必须调用 update_current_server_config 写入服务端名字、Java 版本/路径、内存和必要的统一启动指令；内存只能使用一个值，并同时写入 minMemory 和 maxMemory，优先使用推荐内存；Java 版本优先使用推荐 Java 版本，必要时先安装对应工作区 Java；startupCommand 可使用 {java}/{javaHome}/{python}/{pythonHome}/{workspace}/{serverDir}/{minecraftDir}/{memory}/{minMemory}/{maxMemory}/{jarFile}/{startArgs} 变量。serverType 只是展示/分类标签，不决定启动方式。",
      "模板部署约束：整合包部署必须调用 initialize_server_template(template=reference) 套用内置 MCDReforged 模板；Minecraft 服务端本体必须放在 server/ 子目录；根目录用于 MCDReforged 的 config.yml、permission.yml、plugins/、config/、logs/。",
      "启动策略：start_current_server 只有一种后端启动路径，按当前配置执行。直启验证前先把 startupCommand 设置为进入 server/ 并调用服务端自带 run/start/server/launch 脚本的非交互命令；直启成功后必须先调用 configure_builtin_python_environment 配置工作区内置 Python/pip/MCDReforged，不要直接使用系统 Python；Linux 下系统 python3 只允许用于创建 workspace/python venv。MCDReforged 最终验证需要编辑根目录 config.yml，使 working_directory=server、start_command 从 server/ 工作目录启动服务端、handler 符合核心/Loader，并把 startupCommand 设置为 {python} -m mcdreforged。切换启动方式前先用 get_current_server_config 查看现状，必要时用 stop_current_server 或 kill_current_server 停止/清理残留进程。",
      "当前服务端根目录文件：",
      fileSummary,
      "当前上传给 Agent 的临时文件：",
      uploadSummary,
      "服务端槽位状态：",
      serverSlot?.occupied ? `已占用：${serverSlot.fileName} size=${serverSlot.size} path=${serverSlot.filePath}` : `空槽位：${serverSlot?.directory ?? "未知"}`,
      "工作空间约束：当前对话已经绑定到以上服务端。用户提到的整合包名、版本名或相似服务端名都只是当前任务的上下文，不表示要创建或切换到另一个服务端。只能在当前服务端工作目录内读取、写入、解压、配置和启动；如果用户确实要求新建或切换服务端，说明当前 Agent 不能完成该操作，请用户在服务端列表中手动选择或创建后再发起对话。",
      "对话要求：如果信息不足，先明确缺少哪些信息；如果要修改配置或文件，说明将使用的工具和预期结果。"
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

  private async chatCompletionWithRetry(serverId: string, input: Parameters<ModelService["chatCompletionResult"]>[0]) {
    let retryAttempt = 0;
    while (true) {
      if (input.signal) this.throwIfAborted(input.signal);
      try {
        if (retryAttempt > 0) this.emit(serverId, { type: "retry_cleared", status: "running" });
        this.setStatus(serverId, "running");
        return await this.modelService.chatCompletionResult(input);
      } catch (error) {
        if (!(error instanceof ModelRemoteError)) throw error;
        retryAttempt += 1;
        const maxFailures = error instanceof ModelEmptyResponseError ? 2 : this.modelRetryMaxConsecutiveFailures;
        if (retryAttempt >= this.modelRetryMaxConsecutiveFailures) {
          throw new ModelRemoteError(`模型接口连续异常 ${retryAttempt} 次，已停止自动重试。最后错误：${error.message}`);
        }
        if (retryAttempt >= maxFailures) {
          throw new ModelRemoteError(`模型接口连续返回空 assistant 消息 ${retryAttempt} 次，已停止自动重试。通常是模型上下文过大、输出被上游网关截断，或该模型/网关不完全兼容 OpenAI Chat Completions。最后错误：${error.message}`);
        }
        const delayMs = this.modelRetryDelayMs(retryAttempt);
        const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
        this.setStatus(serverId, "retrying");
        this.emit(serverId, {
          type: "retry_scheduled",
          status: "retrying",
          retry: {
            attempt: retryAttempt,
            delayMs,
            nextRetryAt,
            message: error.message
          }
        });
        this.appendAgentConsoleLog(serverId, `模型接口异常，${Math.ceil(delayMs / 1000)} 秒后重试（第 ${retryAttempt} 次）：${error.message}`);
        await this.waitForModelRetry(serverId, delayMs, input.signal);
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

  private saveMessage(serverId: string, role: AgentRole, content: string, status?: AgentStatus, id = createId("msg")) {
    getDb().insert(agentMessages).values({
      id,
      serverId,
      role,
      content,
      status: status ?? null,
      createdAt: nowIso()
    }).run();
  }

  private setStatus(serverId: string, status: AgentStatus) {
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
