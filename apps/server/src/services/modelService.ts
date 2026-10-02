import { eq } from "drizzle-orm";
import { getDb, getSqlite } from "../db/client.js";
import { modelConfigs } from "../db/schema.js";
import { decryptSecret, encryptSecret, maskSecret } from "../security/encrypt.js";
import { nowIso } from "../utils/time.js";

const singletonModelId = "default_model";

export const DEFAULT_MODEL_CONTEXT_SIZE_K = 120;
export const MIN_MODEL_CONTEXT_SIZE_K = 8;
export const MAX_MODEL_CONTEXT_SIZE_K = 2000;

/** Upstream wire protocol used to reach the model. */
export type ModelApiType = "chat_completions" | "responses";

export function normalizeApiType(value: unknown): ModelApiType {
  return value === "responses" ? "responses" : "chat_completions";
}

export interface ModelInput {
  displayName?: string;
  baseUrl?: string;
  modelName?: string;
  apiKey?: string;
  apiType?: ModelApiType;
  availableModels?: string[];
  isDefault?: boolean;
  contextSizeK?: number;
}

/** Fully resolved, decrypted model connection used for one request. */
export interface ResolvedModel {
  id: string;
  displayName: string;
  baseUrl: string;
  modelName: string;
  apiKey: string;
  apiType: ModelApiType;
  contextSizeK: number;
}

export interface ModelContextUsage {
  contextSizeK: number;
  maxTokens: number;
  usedTokens: number;
  remainingTokens: number;
  remainingRatio: number;
  remainingPercent: number;
}

export function normalizeContextSizeK(value: unknown, fallback = DEFAULT_MODEL_CONTEXT_SIZE_K) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(MAX_MODEL_CONTEXT_SIZE_K, Math.max(MIN_MODEL_CONTEXT_SIZE_K, Math.round(numeric)));
}

export interface ChatMessageInput {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
}

export interface ChatToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatCompletionResult {
  content: string;
  toolCalls: ChatToolCall[];
  reasoning: string;
  usage: ModelUsage | null;
}

export interface ModelUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export class ModelRemoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelRemoteError";
  }
}

export class ModelEmptyResponseError extends ModelRemoteError {
  constructor(message: string) {
    super(message);
    this.name = "ModelEmptyResponseError";
  }
}

interface ChatCompletionRequest {
  messages: ChatMessageInput[];
  temperature?: number;
  baseUrl?: string;
  modelName?: string;
  apiKey?: string;
  apiType?: ModelApiType;
  tools?: ChatToolDefinition[];
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
}

export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

function keyHint(apiKey: string) {
  return maskSecret(apiKey);
}

function parseAvailableModels(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  } catch {
    return [];
  }
}

function publicModel(row: typeof modelConfigs.$inferSelect) {
  const contextSizeK = normalizeContextSizeK(row.contextSizeK);
  return {
    id: row.id,
    displayName: row.displayName,
    baseUrl: row.baseUrl,
    modelName: row.modelName,
    apiKeyHint: row.apiKeyHint,
    apiType: normalizeApiType(row.apiType),
    availableModels: parseAvailableModels(row.availableModels),
    isDefault: Boolean(row.isDefault),
    contextSizeK,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function normalizeOpenAiBaseUrl(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, "");
}

function modelListBaseUrls(baseUrl: string) {
  const urls = [baseUrl];
  try {
    const url = new URL(baseUrl);
    const pathname = url.pathname.replace(/\/+$/, "");
    if (pathname === "") {
      url.pathname = "/v1";
      urls.push(normalizeOpenAiBaseUrl(url.toString()));
    }
  } catch {
    // The normal URL validation happens in the fetch call; keep the original
    // value here so the provider error remains visible to the caller.
  }
  return [...new Set(urls)];
}

export class ModelService {
  list() {
    const row = this.getDefaultRaw();
    return row ? [publicModel(row)] : [];
  }

  getDefaultRaw() {
    const row = getDb().select().from(modelConfigs).where(eq(modelConfigs.id, singletonModelId)).get()
      ?? getDb().select().from(modelConfigs).where(eq(modelConfigs.isDefault, 1)).get()
      ?? getDb().select().from(modelConfigs).limit(1).get();
    if (!row) return null;
    return row.id === singletonModelId ? row : this.moveToSingleton(row);
  }

  getDecryptedDefault(): ResolvedModel | null {
    const row = this.getDefaultRaw();
    if (!row) return null;
    return this.decryptRow(row);
  }

  /** Resolve a model by id, falling back to the default when the id is unknown. */
  getDecryptedById(id: string | undefined | null): ResolvedModel | null {
    if (!id) return this.getDecryptedDefault();
    const row = getDb().select().from(modelConfigs).where(eq(modelConfigs.id, id)).get();
    return this.decryptRow(row ?? this.getDefaultRaw());
  }

  private decryptRow(row: typeof modelConfigs.$inferSelect | null | undefined): ResolvedModel | null {
    if (!row) return null;
    return {
      id: row.id,
      displayName: row.displayName,
      baseUrl: normalizeOpenAiBaseUrl(row.baseUrl),
      modelName: row.modelName,
      apiKey: decryptSecret(row.encryptedApiKey),
      apiType: normalizeApiType(row.apiType),
      contextSizeK: normalizeContextSizeK(row.contextSizeK)
    };
  }

  getContextSizeK(modelId?: string) {
    const row = modelId
      ? getDb().select().from(modelConfigs).where(eq(modelConfigs.id, modelId)).get()
      : undefined;
    const resolved = row ?? this.getDefaultRaw();
    return normalizeContextSizeK(resolved?.contextSizeK);
  }

  getContextMaxTokens(modelId?: string) {
    return this.getContextSizeK(modelId) * 1000;
  }

  create(input: ModelInput) {
    const existing = this.getDefaultRaw();
    return this.saveSingleton(input, existing);
  }

  update(id: string, input: ModelInput) {
    const existing = getDb().select().from(modelConfigs).where(eq(modelConfigs.id, id)).get() ?? this.getDefaultRaw();
    if (!existing) throw new Error("Model config not found");
    return this.saveSingleton(input, existing);
  }

  remove(id: string) {
    getDb().delete(modelConfigs).where(eq(modelConfigs.id, id)).run();
  }

  async test(input: { id?: string; baseUrl?: string; modelName?: string; apiType?: ModelApiType; apiKey?: string }) {
    const config = input.id ? getDb().select().from(modelConfigs).where(eq(modelConfigs.id, input.id)).get() : this.getDefaultRaw();
    const baseUrl = input.baseUrl ? normalizeOpenAiBaseUrl(input.baseUrl) : config?.baseUrl;
    const modelName = input.modelName ?? config?.modelName;
    // A freshly typed (unsaved) key wins over the stored one so the user can test
    // before saving; an empty string falls back to the stored key.
    const apiKey = input.apiKey?.trim() || (config ? decryptSecret(config.encryptedApiKey) : undefined);
    const apiType = input.apiType ? normalizeApiType(input.apiType) : normalizeApiType(config?.apiType);
    if (!baseUrl || !modelName || !apiKey) {
      throw new Error("Missing model connection fields");
    }
    try {
      const response = await this.chatCompletion({
        baseUrl,
        modelName,
        apiKey,
        apiType,
        temperature: 0,
        messages: [{ role: "user", content: "Return only the word OK." }]
      });
      return { ok: true, response };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`模型连接测试失败：${message}`);
    }
  }

  /**
   * Fetch the upstream model catalog so the UI can offer a dropdown instead of a
   * free-text model name. Works with both OpenAI-compatible (`GET /models`) and
   * Responses-only gateways that expose `GET /responses/models` or a models list
   * nested under `data` / `models`.
   */
  async listAvailableModels(input: { id?: string; baseUrl?: string; apiKey?: string; apiType?: ModelApiType }) {
    const needsConfig = !input.baseUrl || !input.apiKey;
    const config = needsConfig ? (input.id ? getDb().select().from(modelConfigs).where(eq(modelConfigs.id, input.id)).get() : this.getDefaultRaw()) : null;
    const baseUrl = input.baseUrl !== undefined ? normalizeOpenAiBaseUrl(input.baseUrl) : config?.baseUrl;
    const apiKey = input.apiKey?.trim() || (config ? decryptSecret(config.encryptedApiKey) : undefined);
    const apiType = input.apiType ? normalizeApiType(input.apiType) : normalizeApiType(config?.apiType);
    if (!baseUrl || !apiKey) throw new Error("缺少 Base URL 或 API Key，无法拉取模型列表");

    const paths = apiType === "responses"
      ? ["/models", "/responses/models"]
      : ["/models"];
    let lastError: string | null = null;
    for (const candidateBaseUrl of modelListBaseUrls(baseUrl)) {
      for (const path of paths) {
        try {
          const response = await this.fetchModels(`${candidateBaseUrl}${path}`, apiKey);
          const text = await response.text();
          let data: unknown;
          try {
            data = text ? JSON.parse(text) : null;
          } catch {
            lastError = `模型列表返回了非 JSON 响应：${text.slice(0, 200)}`;
            continue;
          }
          if (!response.ok) {
            lastError = this.extractProviderError(data) ?? `HTTP ${response.status} ${response.statusText}`;
            continue;
          }
          const models = this.extractModelIds(data);
          if (models.length === 0) {
            lastError = "上游接口没有返回任何模型";
            continue;
          }
          return { models };
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
    }
    throw new Error(`拉取模型列表失败：${lastError ?? "未知错误"}`);
  }

  private extractModelIds(data: unknown): string[] {
    const container = Array.isArray(data)
      ? data
      : [
        (data as { data?: unknown } | null)?.data,
        (data as { models?: unknown } | null)?.models,
        (data as { items?: unknown } | null)?.items
      ].find((candidate) => Array.isArray(candidate)) as unknown[] | undefined;
    if (!Array.isArray(container)) return [];
    const ids = container
      .map((item) => {
        if (typeof item === "string") return item;
        if (!item || typeof item !== "object") return "";
        const record = item as Record<string, unknown>;
        for (const key of ["id", "name", "model", "model_name", "slug"]) {
          const value = record[key];
          if (typeof value === "string" && value.trim()) return value.trim();
        }
        return "";
      })
      .filter((id) => id.length > 0);
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
  }

  async chatCompletion(input: ChatCompletionRequest) {
    const result = await this.chatCompletionResult(input);
    return result.content;
  }

  async chatCompletionResult(input: ChatCompletionRequest) {
    const request = this.buildChatRequest(input);
    if (request.apiType === "responses") return this.responsesCompletionResult(request, input.signal);
    const response = await this.fetchChatCompletion(request, input.signal);
    const text = await response.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new ModelRemoteError(`模型接口返回了非 JSON 响应：${text.slice(0, 300)}`);
    }
    if (!response.ok) {
      throw new ModelRemoteError(this.extractProviderError(data) ?? `HTTP ${response.status} ${response.statusText}`);
    }
    const result = this.extractChatResult(data);
    if (!result.content && result.toolCalls.length === 0) {
      const usage = this.extractUsageSummary(data);
      throw new ModelEmptyResponseError(`模型接口返回了空 assistant 消息（缺少 choices[0].message.content 或 tool_calls）${usage ? `，${usage}` : ""}：${text.slice(0, 500)}`);
    }
    return { ...result, usage: this.extractUsage(data) };
  }

  async chatCompletionStream(input: ChatCompletionRequest, onDelta: (delta: string) => void, onReasoningDelta?: (delta: string) => void) {
    const request = this.buildChatRequest(input);
    if (request.apiType === "responses") return this.responsesCompletionStream(request, input.signal, onDelta, onReasoningDelta);
    const attempt = async (withUsage: boolean): Promise<Response> => {
      const body: Record<string, unknown> = { ...request.body, stream: true };
      if (withUsage) body.stream_options = { include_usage: true };
      return this.fetchChatCompletion({ ...request, body }, input.signal);
    };
    let response = await attempt(true);
    if (!response.ok && (response.status === 400 || response.status === 422)) {
      const text = await response.text();
      if (/stream_options|include_usage|unknown parameter|extra field|unexpected field/i.test(text)) {
        response = await attempt(false);
      } else {
        let data: unknown;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = null;
        }
        throw new ModelRemoteError(`HTTP ${response.status} ${response.statusText}: ${this.extractProviderError(data) ?? text.slice(0, 300)}`);
      }
    }
    if (!response.ok || !response.body) {
      const text = await response.text();
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      throw new ModelRemoteError(`HTTP ${response.status} ${response.statusText}: ${this.extractProviderError(data) ?? text.slice(0, 300)}`);
    }
    return this.readChatStream(response.body, onDelta, input.signal, onReasoningDelta);
  }

  private buildChatRequest(input: ChatCompletionRequest) {
    const needsDefaultConfig = !input.baseUrl || !input.modelName || !input.apiKey;
    const config = needsDefaultConfig ? this.getDecryptedDefault() : null;
    const baseUrl = input.baseUrl ? normalizeOpenAiBaseUrl(input.baseUrl) : config?.baseUrl;
    const modelName = input.modelName ?? config?.modelName;
    const apiKey = input.apiKey ?? config?.apiKey;
    const apiType = normalizeApiType(input.apiType ?? config?.apiType);
    if (!baseUrl || !modelName || !apiKey) {
      throw new Error("Missing model connection fields");
    }
    const instructions = input.messages.filter((message) => message.role === "system").map((message) => message.content ?? "").join("\n\n");
    const body: Record<string, unknown> = apiType === "responses"
      ? {
        model: modelName,
        input: this.toResponsesInput(input.messages),
        ...(instructions ? { instructions } : {}),
        temperature: input.temperature ?? 0.2,
        ...(input.reasoningEffort ? { reasoning: { effort: input.reasoningEffort } } : {}),
        ...(input.tools?.length ? { tools: this.toResponsesTools(input.tools), tool_choice: "auto" } : {})
      }
      : {
        model: modelName,
        messages: input.messages,
        temperature: input.temperature ?? 0.2,
        ...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {}),
        ...(input.tools?.length ? { tools: input.tools, tool_choice: "auto" } : {})
      };
    return { baseUrl, apiKey, apiType, modelName, body };
  }

  private endpointFor(apiType: ModelApiType) {
    return apiType === "responses" ? "/responses" : "/chat/completions";
  }

  private async fetchChatCompletion(request: { baseUrl: string; apiKey: string; apiType: ModelApiType; body: Record<string, unknown> }, signal?: AbortSignal) {
    try {
      return await fetch(`${request.baseUrl}${this.endpointFor(request.apiType)}`, {
        method: "POST",
        headers: {
          "authorization": `Bearer ${request.apiKey}`,
          "content-type": "application/json"
        },
        signal,
        body: JSON.stringify(request.body)
      });
    } catch (error) {
      if (this.isAbortError(error) || signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new ModelRemoteError(`模型接口请求失败：${message}`);
    }
  }

  private async fetchModels(url: string, apiKey: string) {
    try {
      return await fetch(url, {
        method: "GET",
        headers: { "authorization": `Bearer ${apiKey}`, "accept": "application/json" }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ModelRemoteError(`模型列表请求失败：${message}`);
    }
  }

  private isAbortError(error: unknown) {
    return error instanceof Error && error.name === "AbortError";
  }

  /**
   * Convert OpenAI Chat Completions messages into the Responses API `input`
   * array. System prompts become `instructions`; tool calls and tool results use
   * the `function_call` / `function_call_output` item shapes.
   */
  private toResponsesInput(messages: ChatMessageInput[]) {
    const input: Array<Record<string, unknown>> = [];
    for (const message of messages) {
      if (message.role === "system") continue;
      if (message.role === "tool") {
        input.push({ type: "function_call_output", call_id: message.tool_call_id ?? "", output: message.content ?? "" });
        continue;
      }
      if (message.role === "assistant") {
        if (message.content) input.push({ role: "assistant", content: message.content });
        for (const call of message.tool_calls ?? []) {
          input.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
        }
        continue;
      }
      // User messages that only carry tool results are already handled above.
      input.push({ role: "user", content: message.content ?? "" });
    }
    return input;
  }

  private responsesInstructions(messages: ChatMessageInput[]) {
    return messages.filter((message) => message.role === "system").map((message) => message.content ?? "").join("\n\n");
  }

  private toResponsesTools(tools: ChatToolDefinition[]) {
    return tools.map((tool) => ({
      type: "function",
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters
    }));
  }

  private async responsesCompletionResult(request: { baseUrl: string; apiKey: string; apiType: ModelApiType; body: Record<string, unknown>; modelName: string }, signal?: AbortSignal) {
    const response = await this.fetchChatCompletion(request, signal);
    const text = await response.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new ModelRemoteError(`模型接口返回了非 JSON 响应：${text.slice(0, 300)}`);
    }
    if (!response.ok) {
      throw new ModelRemoteError(this.extractProviderError(data) ?? `HTTP ${response.status} ${response.statusText}`);
    }
    const result = this.extractResponsesResult(data);
    if (!result.content && result.toolCalls.length === 0) {
      const usage = this.extractUsageSummary(data);
      throw new ModelEmptyResponseError(`模型接口返回了空 assistant 消息（Responses 输出缺少 message 或 function_call）${usage ? `，${usage}` : ""}：${text.slice(0, 500)}`);
    }
    return { ...result, usage: this.extractResponsesUsage(data) ?? this.extractUsage(data) };
  }

  private async responsesCompletionStream(request: { baseUrl: string; apiKey: string; apiType: ModelApiType; body: Record<string, unknown> }, signal: AbortSignal | undefined, onDelta: (delta: string) => void, onReasoningDelta?: (delta: string) => void) {
    const body = { ...request.body, stream: true };
    const response = await this.fetchChatCompletion({ ...request, body }, signal);
    if (!response.ok || !response.body) {
      const text = await response.text();
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      throw new ModelRemoteError(`HTTP ${response.status} ${response.statusText}: ${this.extractProviderError(data) ?? text.slice(0, 300)}`);
    }
    return this.readResponsesStream(response.body, onDelta, signal, onReasoningDelta);
  }

  /** Extract text, function calls, and reasoning from a Responses API result. */
  private extractResponsesResult(data: unknown): ChatCompletionResult {
    const empty: ChatCompletionResult = { content: "", toolCalls: [], reasoning: "", usage: null };
    if (!data || typeof data !== "object") return empty;
    const output = (data as { output?: unknown }).output;
    if (!Array.isArray(output)) return empty;
    const contents: string[] = [];
    const reasonings: string[] = [];
    const toolCalls: ChatToolCall[] = [];
    for (const item of output) {
      if (!item || typeof item !== "object") continue;
      const itemType = (item as { type?: unknown }).type;
      if (itemType === "function_call") {
        const callId = (item as { call_id?: unknown }).call_id;
        const name = (item as { name?: unknown }).name;
        const args = (item as { arguments?: unknown }).arguments;
        if (typeof name === "string") {
          toolCalls.push({
            id: typeof callId === "string" && callId ? callId : `call_${toolCalls.length}_${name}`,
            type: "function",
            function: { name, arguments: typeof args === "string" ? args : "{}" }
          });
        }
        continue;
      }
      if (itemType === "reasoning") {
        const summary = (item as { summary?: unknown }).summary;
        if (Array.isArray(summary)) {
          reasonings.push(summary.map((part) => (part && typeof part === "object" ? String((part as { text?: unknown }).text ?? "") : "")).join(""));
        }
        continue;
      }
      // Assistant output text: either `output_text` convenience or a message item.
      const itemContent = (item as { content?: unknown }).content;
      if (Array.isArray(itemContent)) {
        contents.push(this.extractContent(itemContent));
      } else if (typeof (item as { text?: unknown }).text === "string") {
        contents.push((item as { text: string }).text);
      }
    }
    const directText = (data as { output_text?: unknown }).output_text;
    const content = (contents.join("") || (typeof directText === "string" ? directText : "")).trim();
    return { content, toolCalls, reasoning: reasonings.join("").trim(), usage: null };
  }

  private async readResponsesStream(body: ReadableStream<Uint8Array>, onDelta: (delta: string) => void, signal?: AbortSignal, onReasoningDelta?: (delta: string) => void): Promise<ChatCompletionResult> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    // Keyed by call_id so argument deltas (which reference item_id) and the final
    // completed payload (which references call_id) resolve to the same tool call.
    const toolCalls = new Map<string, ChatToolCall>();
    const itemIdToCallId = new Map<string, string>();
    let buffer = "";
    let content = "";
    let reasoning = "";
    let usage: ModelUsage | null = null;

    const upsertCall = (key: string, callId: string, name?: string, args?: string, append = false) => {
      const existing = toolCalls.get(key) ?? { id: callId || key, type: "function" as const, function: { name: "", arguments: "" } };
      if (callId) existing.id = callId;
      if (name) existing.function.name = name;
      if (args !== undefined) existing.function.arguments = append ? existing.function.arguments + args : args;
      toolCalls.set(key, existing);
    };

    const applyEvent = (eventName: string, payload: Record<string, unknown>) => {
      if (eventName === "response.output_text.delta" || eventName === "response.refusal.delta") {
        const delta = typeof payload.delta === "string" ? payload.delta : "";
        if (delta) { content += delta; onDelta(delta); }
        return;
      }
      if (eventName === "response.reasoning_summary_text.delta" || eventName === "response.reasoning_text.delta") {
        const delta = typeof payload.delta === "string" ? payload.delta : "";
        if (delta) { reasoning += delta; onReasoningDelta?.(delta); }
        return;
      }
      if (eventName === "response.output_item.added" || eventName === "response.output_item.done") {
        const item = payload.item as Record<string, unknown> | undefined;
        if (item && item.type === "function_call") {
          const itemId = typeof item.id === "string" && item.id ? item.id : "";
          const callId = typeof item.call_id === "string" && item.call_id ? item.call_id : itemId;
          if (itemId && callId) itemIdToCallId.set(itemId, callId);
          upsertCall(callId, callId,
            typeof item.name === "string" ? item.name : undefined,
            typeof item.arguments === "string" ? item.arguments : undefined);
        }
        return;
      }
      if (eventName === "response.function_call_arguments.delta") {
        const itemId = typeof payload.item_id === "string" ? payload.item_id : "";
        const callId = itemIdToCallId.get(itemId) ?? itemId;
        upsertCall(callId, callId, undefined, typeof payload.delta === "string" ? payload.delta : "", true);
        return;
      }
      if (eventName === "response.function_call_arguments.done") {
        const itemId = typeof payload.item_id === "string" ? payload.item_id : "";
        const callId = itemIdToCallId.get(itemId) ?? itemId;
        if (typeof payload.arguments === "string") upsertCall(callId, callId, undefined, payload.arguments);
        return;
      }
      if (eventName === "response.completed" || eventName === "response.done") {
        const responseObj = payload.response as Record<string, unknown> | undefined;
        if (!responseObj) return;
        const completed = this.extractResponsesResult(responseObj);
        if (completed.content && !content) content = completed.content;
        for (const call of completed.toolCalls) upsertCall(call.id, call.id, call.function.name, call.function.arguments);
        const completedUsage = this.extractResponsesUsage(responseObj);
        if (completedUsage) usage = completedUsage;
      }
    };

    const handleData = (data: string) => {
      const trimmed = data.trim();
      if (!trimmed || trimmed === "[DONE]") return;
      let payload: unknown;
      try {
        payload = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (payload && typeof payload === "object" && "error" in payload) {
        throw new ModelRemoteError(this.extractProviderError(payload) ?? "模型流返回了未知错误");
      }
      const record = (payload ?? {}) as Record<string, unknown>;
      const eventName = typeof record.type === "string" ? record.type : "";
      applyEvent(eventName, record);
      const chunkUsage = this.extractResponsesUsage(record) ?? this.extractUsage(record);
      if (chunkUsage) usage = chunkUsage;
    };

    try {
      while (true) {
        this.throwIfAborted(signal);
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          // Responses SSE carries `event:` then `data:`; we only need the data.
          if (line.startsWith("data:")) handleData(line.slice(5));
        }
      }
      buffer += decoder.decode();
      for (const line of buffer.split(/\r?\n/)) {
        if (line.startsWith("data:")) handleData(line.slice(5));
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }

    return {
      content: content.trim(),
      toolCalls: [...toolCalls.values()].filter((call) => call.function.name),
      reasoning: reasoning.trim(),
      usage
    };
  }

  private extractResponsesUsage(data: unknown): ModelUsage | null {
    if (!data || typeof data !== "object") return null;
    const usage = (data as { usage?: unknown }).usage;
    if (!usage || typeof usage !== "object") return null;
    const inputTokens = (usage as { input_tokens?: unknown }).input_tokens;
    const outputTokens = (usage as { output_tokens?: unknown }).output_tokens;
    const totalTokens = (usage as { total_tokens?: unknown }).total_tokens;
    if (typeof inputTokens !== "number" || typeof outputTokens !== "number") return null;
    return {
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      totalTokens: typeof totalTokens === "number" ? totalTokens : inputTokens + outputTokens
    };
  }

  private extractChatResult(data: unknown): ChatCompletionResult {
    if (!data || typeof data !== "object" || !("choices" in data)) return { content: "", toolCalls: [], reasoning: "", usage: null };
    const choices = (data as { choices?: unknown }).choices;
    if (!Array.isArray(choices)) return { content: "", toolCalls: [], reasoning: "", usage: null };
    const first = choices[0];
    if (!first || typeof first !== "object" || !("message" in first)) return { content: "", toolCalls: [], reasoning: "", usage: null };
    const message = (first as { message?: unknown }).message;
    if (!message || typeof message !== "object") return { content: "", toolCalls: [], reasoning: "", usage: null };
    const content = (message as { content?: unknown }).content;
    return {
      content: this.extractContent(content),
      toolCalls: this.extractToolCalls(message),
      reasoning: this.extractReasoning(message),
      usage: null
    };
  }

  private extractContent(content: unknown, trim = true) {
    if (typeof content === "string") return trim ? content.trim() : content;
    if (!Array.isArray(content)) return "";
    const text = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      })
      .join("");
    return trim ? text.trim() : text;
  }

  private extractToolCalls(message: object) {
    const toolCalls = (message as { tool_calls?: unknown }).tool_calls;
    if (Array.isArray(toolCalls)) return toolCalls.map((call, index) => this.normalizeToolCall(call, index)).filter(this.isToolCall);

    const functionCall = (message as { function_call?: unknown }).function_call;
    const normalized = this.normalizeLegacyFunctionCall(functionCall);
    return normalized ? [normalized] : [];
  }

  private normalizeLegacyFunctionCall(functionCall: unknown): ChatToolCall | null {
    if (!functionCall || typeof functionCall !== "object") return null;
    const name = (functionCall as { name?: unknown }).name;
    const args = (functionCall as { arguments?: unknown }).arguments;
    if (typeof name !== "string") return null;
    return {
      id: `legacy_${name}`,
      type: "function",
      function: {
        name,
        arguments: typeof args === "string" ? args : "{}"
      }
    };
  }

  private normalizeToolCall(call: unknown, index: number): ChatToolCall | null {
    if (!call || typeof call !== "object") return null;
    const fn = (call as { function?: unknown }).function;
    if (!fn || typeof fn !== "object") return null;
    const name = (fn as { name?: unknown }).name;
    const args = (fn as { arguments?: unknown }).arguments;
    if (typeof name !== "string") return null;
    const id = (call as { id?: unknown }).id;
    return {
      id: typeof id === "string" && id ? id : `call_${index}_${name}`,
      type: "function",
      function: {
        name,
        arguments: typeof args === "string" ? args : "{}"
      }
    };
  }

  private async readChatStream(body: ReadableStream<Uint8Array>, onDelta: (delta: string) => void, signal?: AbortSignal, onReasoningDelta?: (delta: string) => void): Promise<ChatCompletionResult> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const toolCalls = new Map<number, ChatToolCall>();
    let buffer = "";
    let content = "";
    let reasoning = "";
    let usage: ModelUsage | null = null;

    const applyData = (raw: string) => {
      const data = raw.trim();
      if (!data || data === "[DONE]") return;
      let payload: unknown;
      try {
        payload = JSON.parse(data);
      } catch {
        return;
      }
      if (payload && typeof payload === "object" && "error" in payload) {
        throw new ModelRemoteError(this.extractProviderError(payload) ?? "模型流返回了未知错误");
      }
      const chunkUsage = this.extractUsage(payload);
      if (chunkUsage) usage = chunkUsage;
      const delta = this.extractStreamDelta(payload);
      if (delta.reasoning) {
        reasoning += delta.reasoning;
        onReasoningDelta?.(delta.reasoning);
      }
      if (delta.content) {
        content += delta.content;
        onDelta(delta.content);
      }
      for (const partial of delta.toolCalls) {
        const current = toolCalls.get(partial.index) ?? {
          id: "",
          type: "function" as const,
          function: { name: "", arguments: "" }
        };
        if (partial.id) current.id = partial.id;
        if (partial.name) current.function.name += partial.name;
        if (partial.arguments) current.function.arguments += partial.arguments;
        toolCalls.set(partial.index, current);
      }
    };

    try {
      while (true) {
        this.throwIfAborted(signal);
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("data:")) applyData(line.slice(5));
        }
      }
      buffer += decoder.decode();
      for (const line of buffer.split(/\r?\n/)) {
        if (line.startsWith("data:")) applyData(line.slice(5));
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }

    return {
      content: content.trim(),
      toolCalls: [...toolCalls.values()].filter(this.isToolCall),
      reasoning: reasoning.trim(),
      usage
    };
  }

  private extractUsage(data: unknown): ModelUsage | null {
    if (!data || typeof data !== "object" || !("usage" in data)) return null;
    const usage = (data as { usage?: unknown }).usage;
    if (!usage || typeof usage !== "object") return null;
    const promptTokens = (usage as { prompt_tokens?: unknown }).prompt_tokens;
    const completionTokens = (usage as { completion_tokens?: unknown }).completion_tokens;
    const totalTokens = (usage as { total_tokens?: unknown }).total_tokens;
    if (typeof promptTokens !== "number" || typeof completionTokens !== "number") return null;
    return {
      promptTokens,
      completionTokens,
      totalTokens: typeof totalTokens === "number" ? totalTokens : promptTokens + completionTokens
    };
  }

  private throwIfAborted(signal?: AbortSignal) {
    if (!signal?.aborted) return;
    const error = new Error("Agent 操作已中断");
    error.name = "AbortError";
    throw error;
  }

  private extractStreamDelta(data: unknown) {
    const empty = { content: "", reasoning: "", toolCalls: [] as Array<{ index: number; id?: string; name?: string; arguments?: string }> };
    if (!data || typeof data !== "object" || !("choices" in data)) return empty;
    const choices = (data as { choices?: unknown }).choices;
    if (!Array.isArray(choices)) return empty;
    const first = choices[0];
    if (!first || typeof first !== "object" || !("delta" in first)) return empty;
    const delta = (first as { delta?: unknown }).delta;
    if (!delta || typeof delta !== "object") return empty;
    const content = (delta as { content?: unknown }).content;
    const toolCallData = (delta as { tool_calls?: unknown }).tool_calls;
    const toolCalls: Array<{ index: number; id?: string; name?: string; arguments?: string }> = [];
    if (Array.isArray(toolCallData)) {
      for (const item of toolCallData) {
        if (!item || typeof item !== "object") continue;
        const index = (item as { index?: unknown }).index;
        if (typeof index !== "number") continue;
        const fn = (item as { function?: { name?: unknown; arguments?: unknown } }).function;
        toolCalls.push({
          index,
          id: typeof (item as { id?: unknown }).id === "string" ? (item as { id: string }).id : undefined,
          name: typeof fn?.name === "string" ? fn.name : undefined,
          arguments: typeof fn?.arguments === "string" ? fn.arguments : undefined
        });
      }
    }
    return {
      // Stream chunks may begin or end with whitespace. Trimming per chunk
      // corrupts prose, Markdown, and reasoning when the chunks are joined.
      content: this.extractContent(content, false),
      reasoning: this.extractReasoning(delta, false),
      toolCalls
    };
  }

  private extractReasoning(message: object, trim = true) {
    for (const key of ["reasoning", "reasoning_content", "reasoning_text"] as const) {
      if (key in message) {
        const value = (message as Record<string, unknown>)[key];
        if (typeof value === "string") return trim ? value.trim() : value;
      }
    }
    return "";
  }

  private isToolCall(call: unknown): call is ChatToolCall {
    return Boolean(
      call
      && typeof call === "object"
      && "id" in call
      && "type" in call
      && "function" in call
      && typeof (call as { id?: unknown }).id === "string"
      && (call as { type?: unknown }).type === "function"
      && typeof (call as { function?: { name?: unknown; arguments?: unknown } }).function?.name === "string"
      && typeof (call as { function?: { name?: unknown; arguments?: unknown } }).function?.arguments === "string"
    );
  }

  private extractProviderError(data: unknown) {
    if (!data || typeof data !== "object") return null;
    if ("error" in data) {
      const error = (data as { error?: unknown }).error;
      if (typeof error === "string") return error;
      if (error && typeof error === "object" && "message" in error) {
        const message = (error as { message?: unknown }).message;
        if (typeof message === "string") return message;
      }
    }
    if ("message" in data) {
      const message = (data as { message?: unknown }).message;
      if (typeof message === "string") return message;
    }
    return null;
  }

  private extractUsageSummary(data: unknown) {
    if (!data || typeof data !== "object" || !("usage" in data)) return "";
    const usage = (data as { usage?: unknown }).usage;
    if (!usage || typeof usage !== "object") return "";
    const promptTokens = (usage as { prompt_tokens?: unknown }).prompt_tokens;
    const completionTokens = (usage as { completion_tokens?: unknown }).completion_tokens;
    const totalTokens = (usage as { total_tokens?: unknown }).total_tokens;
    const parts = [
      typeof promptTokens === "number" ? `prompt_tokens=${promptTokens}` : "",
      typeof completionTokens === "number" ? `completion_tokens=${completionTokens}` : "",
      typeof totalTokens === "number" ? `total_tokens=${totalTokens}` : ""
    ].filter(Boolean);
    return parts.length > 0 ? `usage: ${parts.join(", ")}` : "";
  }

  private moveToSingleton(row: typeof modelConfigs.$inferSelect) {
    const now = nowIso();
    const singleton = getDb().select().from(modelConfigs).where(eq(modelConfigs.id, singletonModelId)).get();
    if (singleton) return singleton;
    getDb().insert(modelConfigs).values({ ...row, id: singletonModelId, isDefault: 1, updatedAt: now }).run();
    this.deleteExtraConfigs();
    return getDb().select().from(modelConfigs).where(eq(modelConfigs.id, singletonModelId)).get()!;
  }

  private normalizeModelList(values: unknown): string[] {
    if (!Array.isArray(values)) return [];
    return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()))];
  }

  private deleteExtraConfigs() {
    getSqlite().prepare("DELETE FROM model_configs WHERE id <> ?").run(singletonModelId);
  }

  private saveSingleton(input: ModelInput, existing: typeof modelConfigs.$inferSelect | null) {
    const now = nowIso();
    const displayName = input.displayName ?? existing?.displayName;
    const baseUrl = input.baseUrl !== undefined ? normalizeOpenAiBaseUrl(input.baseUrl) : existing?.baseUrl;
    const modelName = input.modelName ?? existing?.modelName;
    const apiKey = input.apiKey || (existing ? decryptSecret(existing.encryptedApiKey) : "");
    const apiType = input.apiType !== undefined ? normalizeApiType(input.apiType) : normalizeApiType(existing?.apiType);
    const availableModels = input.availableModels !== undefined
      ? JSON.stringify(this.normalizeModelList(input.availableModels))
      : (existing?.availableModels ?? "[]");
    const contextSizeK = input.contextSizeK !== undefined
      ? normalizeContextSizeK(input.contextSizeK)
      : normalizeContextSizeK(existing?.contextSizeK);
    if (!displayName || !baseUrl || !modelName || !apiKey) {
      throw new Error("Missing model connection fields");
    }
    const row: typeof modelConfigs.$inferInsert = {
      id: singletonModelId,
      displayName,
      baseUrl,
      modelName,
      apiType,
      availableModels,
      encryptedApiKey: encryptSecret(apiKey),
      apiKeyHint: keyHint(apiKey),
      isDefault: 1,
      contextSizeK,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };

    this.deleteExtraConfigs();
    const singleton = getDb().select().from(modelConfigs).where(eq(modelConfigs.id, singletonModelId)).get();
    if (singleton) {
      getDb().update(modelConfigs).set(row).where(eq(modelConfigs.id, singletonModelId)).run();
    } else {
      getDb().insert(modelConfigs).values(row).run();
    }
    const saved = getDb().select().from(modelConfigs).where(eq(modelConfigs.id, singletonModelId)).get();
    if (!saved) throw new Error("Model config save failed");
    return publicModel(saved);
  }
}
