import { readBrowserState, writeBrowserState } from "~/utils/browserState";

interface PendingRequest {
  requestId: string;
  scopeId: string;
  content: string;
  reasoningEffort: "minimal" | "low" | "medium" | "high";
}

/** Keep unacknowledged submissions across page exits; retries use the same admission id. */
export function useAgentDelivery() {
  const { api } = useApi();
  const pending = useState<PendingRequest[]>("agent-delivery", () => []);
  const sending = useState<boolean>("agent-delivery-sending", () => false);
  function restore() { pending.value = readBrowserState<PendingRequest[]>("outbox") ?? []; }
  async function flush() {
    if (sending.value) return;
    sending.value = true;
    try {
      for (const item of [...pending.value]) {
        const prefix = item.scopeId === "global" ? "/api/agent" : `/api/servers/${encodeURIComponent(item.scopeId)}/agent`;
        try {
          await api(`${prefix}/requests`, { method: "POST", body: item });
          pending.value = pending.value.filter((entry) => entry.requestId !== item.requestId);
          writeBrowserState("outbox", pending.value);
        } catch { /* Retain the exact request, never turn an uncertain send into a new task. */ }
      }
    } finally { sending.value = false; }
  }
  async function send(scopeId: string, content: string, reasoningEffort: PendingRequest["reasoningEffort"]) {
    pending.value.push({ requestId: crypto.randomUUID(), scopeId, content, reasoningEffort });
    writeBrowserState("outbox", pending.value);
    await flush();
  }
  function discard(requestId: string) {
    pending.value = pending.value.filter((entry) => entry.requestId !== requestId);
    writeBrowserState("outbox", pending.value);
  }
  function discardScope(scopeId: string) {
    pending.value = pending.value.filter((entry) => entry.scopeId !== scopeId);
    writeBrowserState("outbox", pending.value);
  }
  return { pending, sending, restore, flush, send, discard, discardScope };
}
