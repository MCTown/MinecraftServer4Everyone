import { getSqlite } from "../db/client.js";
import type { ChatMessageInput, ChatToolDefinition, ModelUsage } from "../services/modelService.js";
import { cacheUsage } from "./cacheUsage.js";

export interface SessionHeader {
  baseUrl: string;
  modelName: string;
  apiType: string;
  reasoningEffort: string;
  tools: ChatToolDefinition[];
}

/** Model history is an append-only record, independent of presentation messages.
 * Replacements are explicit series boundaries, never destructive log edits.
 * No credentials are stored in request headers.
 */
export class SessionStore {
  messages(scopeId: string): ChatMessageInput[] {
    const messages: ChatMessageInput[] = [];
    for (const row of this.events(scopeId)) {
      if (row.kind === "replace" || row.kind === "clear") messages.length = 0;
      if (row.kind === "append" || row.kind === "replace") messages.push(...JSON.parse(row.payload) as ChatMessageInput[]);
    }
    return messages;
  }

  events(scopeId: string): Array<{ kind: string; payload: string }> {
    return getSqlite().prepare("SELECT kind, payload FROM agent_session_events WHERE scope_id=? ORDER BY seq").all(scopeId) as Array<{ kind: string; payload: string }>;
  }

  exists(scopeId: string) {
    return Boolean(getSqlite().prepare("SELECT 1 FROM agent_session_events WHERE scope_id=? LIMIT 1").get(scopeId));
  }

  private record(scopeId: string, kind: string, payload: unknown) {
    getSqlite().prepare("INSERT INTO agent_session_events(scope_id,kind,payload) VALUES (?,?,?)")
      .run(scopeId, kind, JSON.stringify(payload));
  }

  commit(scopeId: string, messages: ChatMessageInput[], replace = false) {
    const previous = this.messages(scopeId);
    if (!replace && previous.some((message, index) => JSON.stringify(message) !== JSON.stringify(messages[index]))) {
      throw new Error("模型历史前缀发生未声明的修改；必须显式开启新的请求序列");
    }
    if (replace) this.record(scopeId, "replace", messages);
    else if (messages.length > previous.length) this.record(scopeId, "append", messages.slice(previous.length));
  }

  header(scopeId: string): SessionHeader | null {
    const row = getSqlite().prepare("SELECT payload FROM agent_session_events WHERE scope_id=? AND kind='header' ORDER BY seq DESC LIMIT 1")
      .get(scopeId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : null;
  }

  setHeader(scopeId: string, header: SessionHeader) {
    if (JSON.stringify(header) !== JSON.stringify(this.header(scopeId))) this.record(scopeId, "header", header);
  }

  clear(scopeId: string) { this.record(scopeId, "clear", null); }

  saveUsage(scopeId: string, usage: ModelUsage | null) { this.record(scopeId, "usage", usage); }

  cacheUsage(scopeId: string) {
    const row = getSqlite().prepare("SELECT kind,payload FROM agent_session_events WHERE scope_id=? AND kind IN ('usage','clear') ORDER BY seq DESC LIMIT 1")
      .get(scopeId) as { kind: string; payload: string } | undefined;
    return cacheUsage(row?.kind === "usage" ? JSON.parse(row.payload) : null);
  }
}

export const runtimeContextPrefix = "【Runtime context snapshot】\n";

/** Fresh operational facts go AFTER cached history, only when changed. */
export function appendRuntimeContext(messages: ChatMessageInput[], context: string) {
  const content = runtimeContextPrefix + context;
  const previous = [...messages].reverse().find((message) => message.role === "user" && message.content?.startsWith(runtimeContextPrefix));
  if (previous?.content !== content) messages.push({ role: "user", content });
}

/** Select a head span without splitting assistant tool calls from their results. */
export function compactBoundary(messages: ChatMessageInput[], retainTokens: number, estimate: (text: string) => number) {
  let tokens = 0;
  let boundary = messages.length;
  while (boundary > 1 && tokens < retainTokens) tokens += estimate(JSON.stringify(messages[--boundary]));
  while (boundary > 1 && messages[boundary]?.role === "tool") boundary--;
  return boundary;
}
