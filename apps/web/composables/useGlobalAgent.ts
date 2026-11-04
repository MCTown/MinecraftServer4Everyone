import type { AgentActivity, AgentConfirmationRequest, AgentContextUsage, AgentFocusInstance, AgentMessage, AgentRetryState, AgentStatus, AgentToolConfigRequired } from "~/types/app";

/**
 * Dashboard-level Agent conversation. Mirrors the per-instance agent's REST and
 * WebSocket contract, but is not bound to a server: the backend agent lists
 * instances and emits `focus_instance` to route the UI into an instance console.
 *
 * Kept as its own composable (rather than folded into pages/index.vue) so the
 * dashboard can own this state without the instance workspace's socket logic.
 */
export function useGlobalAgent() {
  const { api, websocketUrl } = useApi();
  const delivery = useAgentDelivery();
  const confirmation = ref<AgentConfirmationRequest | null>(null);
  const toolConfigRequired = ref<AgentToolConfigRequired | null>(null);

  const messages = ref<AgentMessage[]>([]);
  const historyLoad = useResourceLoadState();
  const contextLoad = useResourceLoadState();
  let messageRevision = 0;
  const status = ref<AgentStatus>("idle");
  const retry = ref<AgentRetryState | null>(null);
  const activeModel = ref("");
  const contextUsage = ref<AgentContextUsage>({
    contextSizeK: 120,
    maxTokens: 120000,
    usedTokens: 0,
    remainingTokens: 120000,
    remainingRatio: 1,
    remainingPercent: 100
  });
  const focus = ref<(AgentFocusInstance & { id?: string }) | null>(null);

  const busy = computed(() => ["thinking", "running", "waiting_confirmation", "retrying"].includes(status.value)
    || delivery.pending.value.some((item) => item.scopeId === "global"));

  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempt = 0;
  let generation = 0;
  let closedIntentionally = false;
  const baseDelayMs = 1000;
  const maxDelayMs = 10000;

  function localId() {
    return globalThis.crypto?.randomUUID?.() ?? `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function appendMessage(role: AgentMessage["role"], content: string): AgentMessage {
    messageRevision += 1;
    const message: AgentMessage = { id: localId(), serverId: "", role, content, status: null, createdAt: new Date().toISOString() };
    messages.value = [...messages.value, message];
    return message;
  }

  function upsertMessage(id: string, role: AgentMessage["role"], content: string, messageStatus: AgentStatus | null, focusServerId?: string | null) {
    messageRevision += 1;
    const index = messages.value.findIndex((message) => message.id === id);
    if (index >= 0) {
      const existing = messages.value[index];
      if (!existing) return;
      messages.value[index] = { ...existing, content, status: messageStatus, focusServerId: focusServerId ?? existing.focusServerId ?? null };
      return;
    }
    messages.value = [...messages.value, { id, serverId: "", role, content, status: messageStatus, createdAt: new Date().toISOString(), focusServerId: focusServerId ?? null }];
  }

  function appendDelta(id: string, delta: string) {
    messageRevision += 1;
    const index = messages.value.findIndex((message) => message.id === id);
    if (index >= 0) {
      const existing = messages.value[index];
      if (!existing) return;
      messages.value[index] = { ...existing, content: existing.content + delta, status: existing.status ?? "running" };
      return;
    }
    messages.value = [...messages.value, { id, serverId: "", role: "agent", content: delta, status: "running", createdAt: new Date().toISOString() }];
  }

  function updateActivity(id: string, content: string, activity: AgentActivity, createdAt: string | undefined, delta: boolean) {
    messageRevision += 1;
    const index = messages.value.findIndex((message) => message.id === id);
    if (index >= 0) {
      const existing = messages.value[index];
      if (!existing) return;
      messages.value[index] = { ...existing, content: delta ? existing.content + content : content, activity, status: activity.status };
      return;
    }
    messages.value = [...messages.value, { id, serverId: "", role: "system", content, activity, status: activity.status, createdAt: createdAt ?? activity.startedAt }];
  }

  function isTerminal(value?: AgentStatus) {
    return value === "completed" || value === "failed" || value === "cancelled";
  }

  async function loadMessages() {
    const revision = messageRevision;
    await Promise.all([
      historyLoad.run(() => api<AgentMessage[]>("/api/agent/messages"), (loaded) => {
        if (revision === messageRevision) messages.value = loaded;
      }),
      loadContextUsage()
    ]);
  }

  async function loadContextUsage() {
    try {
      await contextLoad.run(() => api<AgentContextUsage>("/api/agent/context-usage"), (data) => { contextUsage.value = data; });
    } catch {
      // Keep the previous estimate if the endpoint is temporarily unavailable.
    }
  }

  function handleEvent(payload: {
    type?: string; status?: AgentStatus; content?: string; messageId?: string; messages?: AgentMessage[];
    activity?: AgentActivity; createdAt?: string; retry?: AgentRetryState; focus?: (AgentFocusInstance & { id?: string }) | null; modelName?: string | null;
    confirmation?: AgentConfirmationRequest | null;
    toolConfigRequired?: AgentToolConfigRequired | null;
  }) {
    if (payload.type === "snapshot" && payload.messages) {
      messageRevision += 1;
      historyLoad.acceptSnapshot();
      messages.value = payload.messages;
      retry.value = payload.retry ?? null;
      confirmation.value = payload.confirmation ?? null;
      toolConfigRequired.value = payload.toolConfigRequired ?? null;
      if (payload.focus) focus.value = payload.focus;
      if (payload.status) status.value = payload.status;
      if (payload.modelName !== undefined && payload.modelName !== null) activeModel.value = payload.modelName;
      void loadContextUsage();
    }
    if (payload.type === "model") {
      activeModel.value = payload.modelName ?? "";
    }
    if (payload.type === "confirmation_required") confirmation.value = payload.confirmation ?? null;
    if (payload.type === "confirmation_resolved") confirmation.value = null;
    if (payload.type === "tool_config_required") toolConfigRequired.value = payload.toolConfigRequired ?? null;
    if ((payload.type === "activity" || payload.type === "activity_delta") && payload.messageId && payload.activity) {
      updateActivity(payload.messageId, payload.content ?? "", payload.activity, payload.createdAt, payload.type === "activity_delta");
    }
    if (payload.type === "status" && payload.status) {
      status.value = payload.status;
      if (payload.status !== "retrying") retry.value = null;
    }
    if (payload.type === "focus_instance" && payload.focus) {
      focus.value = payload.focus;
    }
    if (payload.type === "retry_scheduled" && payload.retry) {
      retry.value = payload.retry;
      if (payload.status) status.value = payload.status;
    }
    if (payload.type === "retry_cleared") {
      retry.value = null;
      if (payload.status) status.value = payload.status;
    }
    if (payload.type === "log" && payload.content) {
      if (payload.messageId) upsertMessage(payload.messageId, "system", payload.content, null);
      else appendMessage("system", payload.content);
    }
    if (payload.type === "message" && payload.messageId) {
      if (isTerminal(payload.status)) retry.value = null;
      const existing = messages.value.find((message) => message.id === payload.messageId);
      const nextContent = payload.content === undefined || payload.content === null
        ? (existing?.content ?? "")
        : (isTerminal(payload.status) && !payload.content && existing?.content ? existing.content : payload.content);
      upsertMessage(payload.messageId, "agent", nextContent, payload.status ?? "completed");
    } else if (payload.type === "message" && payload.content) {
      appendMessage("agent", payload.content);
    }
    if (payload.type === "message_delta" && payload.messageId && payload.content) {
      appendDelta(payload.messageId, payload.content);
    }
    if (payload.type === "error" && payload.content) {
      if (payload.messageId) upsertMessage(payload.messageId, "agent", payload.content, payload.status ?? "failed");
      else appendMessage("agent", payload.content);
      if (payload.status) status.value = payload.status;
    }
    if (payload.type === "done") {
      retry.value = null;
      if (payload.status) status.value = payload.status;
      void loadMessages().catch(() => undefined);
      void loadContextUsage().catch(() => undefined);
    }
  }

  function connect() {
    if (!process.client) return;
    generation += 1;
    const current = generation;
    closedIntentionally = false;
    socket?.close();
    const next = new WebSocket(websocketUrl("/ws/agent/global"));
    socket = next;
    next.onopen = () => { reconnectAttempt = 0; };
    next.onmessage = (event) => {
      if (socket !== next) return;
      handleEvent(JSON.parse(event.data));
    };
    next.onclose = () => {
      if (socket !== next || closedIntentionally || current !== generation) return;
      reconnectAttempt += 1;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(reconnectAttempt - 1, 4));
      reconnectTimer = setTimeout(connect, delay);
    };
    next.onerror = () => next.close();
  }

  function close() {
    closedIntentionally = true;
    generation += 1;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    socket?.close();
    socket = undefined;
  }

  async function send(content: string, reasoningEffort: "minimal" | "low" | "medium" | "high" = "high") {
    const text = content.trim();
    if (!text || busy.value) return;
    appendMessage("user", text);
    status.value = "thinking";
    await delivery.send("global", text, reasoningEffort);
  }

  async function retryNow() {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "retry" }));
    else await api("/api/agent/retry", { method: "POST" }).catch(() => undefined);
    retry.value = null;
  }

  /** Switch the model used by this conversation; empty clears back to the default. */
  async function setModel(modelName: string | undefined) {
    const value = modelName?.trim();
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "set-model", modelName: value }));
      activeModel.value = value ?? activeModel.value;
      return;
    }
    const result = await api<{ modelName: string | null }>("/api/agent/model", { method: "POST", body: { modelName: value } }).catch(() => null);
    activeModel.value = result?.modelName ?? value ?? "";
  }

  async function cancel() {
    if (!busy.value) return;
    delivery.discardScope("global");
    status.value = "cancelled";
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "cancel" }));
    else await api("/api/agent/cancel", { method: "POST" }).catch(() => undefined);
  }

  async function clearContext() {
    if (busy.value) return;
    await api("/api/agent/context", { method: "DELETE" });
    messageRevision += 1;
    historyLoad.acceptSnapshot();
    messages.value = [];
    status.value = "idle";
    focus.value = null;
    await loadContextUsage();
  }

  async function compressContext() {
    if (busy.value) return;
    const result = await api<{ ok: boolean; compressed: number }>("/api/agent/context/compress", { method: "POST" });
    if (result?.compressed) appendMessage("system", `已压缩 ${result.compressed} 条历史消息为摘要。`);
    await loadMessages();
  }

  function consumeFocus() {
    const value = focus.value;
    focus.value = null;
    return value;
  }

  async function resolveConfirmation(approved: boolean) {
    const current = confirmation.value;
    if (!current) return;
    await api("/api/agent/confirmation", { method: "POST", body: { confirmationId: current.id, approved } });
    if (confirmation.value?.id === current.id) confirmation.value = null;
  }

  async function acknowledgeFocus(id?: string) {
    if (id) await api("/api/agent/focus/ack", { method: "POST", body: { id } });
    if (!id || focus.value?.id === id) focus.value = null;
  }

  return {
    messages, status, retry, contextUsage, focus, busy, historyLoad, contextLoad, activeModel, confirmation, resolveConfirmation, acknowledgeFocus, toolConfigRequired,
    loadMessages, loadContextUsage, connect, close, send, retryNow, cancel, clearContext, compressContext, consumeFocus, setModel
  };
}
