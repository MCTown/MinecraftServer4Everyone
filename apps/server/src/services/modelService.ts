import { eq } from "drizzle-orm";
import { getDb, getSqlite } from "../db/client.js";
import { modelConfigs } from "../db/schema.js";
import { decryptSecret, encryptSecret, maskSecret } from "../security/encrypt.js";
import { nowIso } from "../utils/time.js";

const singletonModelId = "default_model";

export interface ModelInput {
  displayName?: string;
  baseUrl?: string;
  modelName?: string;
  apiKey?: string;
  isDefault?: boolean;
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
  tools?: ChatToolDefinition[];
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
}

export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

function keyHint(apiKey: string) {
  return maskSecret(apiKey);
}

function publicModel(row: typeof modelConfigs.$inferSelect) {
  return {
    id: row.id,
    displayName: row.displayName,
    baseUrl: row.baseUrl,
    modelName: row.modelName,
    apiKeyHint: row.apiKeyHint,
    isDefault: Boolean(row.isDefault),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function normalizeOpenAiBaseUrl(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, "");
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

  getDecryptedDefault() {
    const row = this.getDefaultRaw();
    if (!row) return null;
    return {
      id: row.id,
      displayName: row.displayName,
      baseUrl: normalizeOpenAiBaseUrl(row.baseUrl),
      modelName: row.modelName,
      apiKey: decryptSecret(row.encryptedApiKey)
    };
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

  async test(input: { id?: string; baseUrl?: string; modelName?: string }) {
    const config = input.id ? getDb().select().from(modelConfigs).where(eq(modelConfigs.id, input.id)).get() : this.getDefaultRaw();
    const baseUrl = input.baseUrl ? normalizeOpenAiBaseUrl(input.baseUrl) : config?.baseUrl;
    const modelName = input.modelName ?? config?.modelName;
    const apiKey = config ? decryptSecret(config.encryptedApiKey) : undefined;
    if (!baseUrl || !modelName || !apiKey) {
      throw new Error("Missing model connection fields");
    }
    try {
      const response = await this.chatCompletion({
        baseUrl,
        modelName,
        apiKey,
        temperature: 0,
        messages: [{ role: "user", content: "Return only the word OK." }]
      });
      return { ok: true, response };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`模型连接测试失败：${message}`);
    }
  }

  async chatCompletion(input: { messages: ChatMessageInput[]; temperature?: number; baseUrl?: string; modelName?: string; apiKey?: string; reasoningEffort?: ReasoningEffort; signal?: AbortSignal }) {
    const result = await this.chatCompletionResult(input);
    return result.content;
  }

  async chatCompletionResult(input: ChatCompletionRequest) {
    const request = this.buildChatRequest(input);
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
    return result;
  }

  async chatCompletionStream(input: ChatCompletionRequest, onDelta: (delta: string) => void) {
    const request = this.buildChatRequest(input);
    const response = await fetch(`${request.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${request.apiKey}`,
        "content-type": "application/json"
      },
      signal: input.signal,
      body: JSON.stringify({ ...request.body, stream: true })
    });
    if (!response.ok || !response.body) {
      const text = await response.text();
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      throw new Error(this.extractProviderError(data) ?? `HTTP ${response.status} ${response.statusText}: ${text.slice(0, 300)}`);
    }
    return this.readChatStream(response.body, onDelta, input.signal);
  }

  private buildChatRequest(input: ChatCompletionRequest) {
    const needsDefaultConfig = !input.baseUrl || !input.modelName || !input.apiKey;
    const config = needsDefaultConfig ? this.getDecryptedDefault() : null;
    const baseUrl = input.baseUrl ? normalizeOpenAiBaseUrl(input.baseUrl) : config?.baseUrl;
    const modelName = input.modelName ?? config?.modelName;
    const apiKey = input.apiKey ?? config?.apiKey;
    if (!baseUrl || !modelName || !apiKey) {
      throw new Error("Missing model connection fields");
    }
    return {
      baseUrl,
      apiKey,
      body: {
        model: modelName,
        messages: input.messages,
        temperature: input.temperature ?? 0.2,
        ...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {}),
        ...(input.tools?.length ? { tools: input.tools, tool_choice: "auto" } : {})
      }
    };
  }

  private async fetchChatCompletion(request: { baseUrl: string; apiKey: string; body: Record<string, unknown> }, signal?: AbortSignal) {
    try {
      return await fetch(`${request.baseUrl}/chat/completions`, {
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

  private isAbortError(error: unknown) {
    return error instanceof Error && error.name === "AbortError";
  }

  private extractChatResult(data: unknown): ChatCompletionResult {
    if (!data || typeof data !== "object" || !("choices" in data)) return { content: "", toolCalls: [], reasoning: "" };
    const choices = (data as { choices?: unknown }).choices;
    if (!Array.isArray(choices)) return { content: "", toolCalls: [], reasoning: "" };
    const first = choices[0];
    if (!first || typeof first !== "object" || !("message" in first)) return { content: "", toolCalls: [], reasoning: "" };
    const message = (first as { message?: unknown }).message;
    if (!message || typeof message !== "object") return { content: "", toolCalls: [], reasoning: "" };
    const content = (message as { content?: unknown }).content;
    return {
      content: this.extractContent(content),
      toolCalls: this.extractToolCalls(message),
      reasoning: this.extractReasoning(message)
    };
  }

  private extractContent(content: unknown) {
    if (typeof content === "string") return content.trim();
    if (!Array.isArray(content)) return "";
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      })
      .join("")
      .trim();
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

  private async readChatStream(body: ReadableStream<Uint8Array>, onDelta: (delta: string) => void, signal?: AbortSignal): Promise<ChatCompletionResult> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const toolCalls = new Map<number, ChatToolCall>();
    let buffer = "";
    let content = "";
    let reasoning = "";

    const applyData = (raw: string) => {
      const data = raw.trim();
      if (!data || data === "[DONE]") return;
      let payload: unknown;
      try {
        payload = JSON.parse(data);
      } catch {
        return;
      }
      const delta = this.extractStreamDelta(payload);
      if (delta.content) {
        content += delta.content;
        onDelta(delta.content);
      }
      if (delta.reasoning) reasoning += delta.reasoning;
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

    return {
      content: content.trim(),
      toolCalls: [...toolCalls.values()].filter(this.isToolCall),
      reasoning: reasoning.trim()
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
      content: this.extractContent(content),
      reasoning: this.extractReasoning(delta),
      toolCalls
    };
  }

  private extractReasoning(message: object) {
    for (const key of ["reasoning", "reasoning_content", "reasoning_text"] as const) {
      if (key in message) {
        const value = (message as Record<string, unknown>)[key];
        if (typeof value === "string") return value.trim();
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

  private deleteExtraConfigs() {
    getSqlite().prepare("DELETE FROM model_configs WHERE id <> ?").run(singletonModelId);
  }

  private saveSingleton(input: ModelInput, existing: typeof modelConfigs.$inferSelect | null) {
    const now = nowIso();
    const displayName = input.displayName ?? existing?.displayName;
    const baseUrl = input.baseUrl !== undefined ? normalizeOpenAiBaseUrl(input.baseUrl) : existing?.baseUrl;
    const modelName = input.modelName ?? existing?.modelName;
    const apiKey = input.apiKey || (existing ? decryptSecret(existing.encryptedApiKey) : "");
    if (!displayName || !baseUrl || !modelName || !apiKey) {
      throw new Error("Missing model connection fields");
    }
    const row: typeof modelConfigs.$inferInsert = {
      id: singletonModelId,
      displayName,
      baseUrl,
      modelName,
      encryptedApiKey: encryptSecret(apiKey),
      apiKeyHint: keyHint(apiKey),
      isDefault: 1,
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
