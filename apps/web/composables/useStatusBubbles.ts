import type { AgentDownloadProgress } from "~/types/app";
import type { StatusBubbleItem, StatusBubbleType } from "~/types/ui";

interface StatusBubbleAction {
  label: string;
  key: string;
}

export function useStatusBubbles() {
  const items = ref<StatusBubbleItem[]>([]);
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  let nextId = 0;
  let nextProgressKey = 0;

  function dismiss(id: number | undefined) {
    if (id === undefined) return;
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
    items.value = items.value.filter((item) => item.id !== id);
  }

  function scheduleDismiss(id: number, durationMs: number) {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
    if (durationMs > 0) timers.set(id, setTimeout(() => dismiss(id), durationMs));
  }

  function show(type: StatusBubbleType, message: string, durationMs = 0, download?: AgentDownloadProgress, action?: StatusBubbleAction) {
    const id = ++nextId;
    items.value = [...items.value, { id, type, message, durationMs, progressKey: ++nextProgressKey, download, actionLabel: action?.label, actionKey: action?.key }];
    scheduleDismiss(id, durationMs);
    return id;
  }

  function update(id: number, type: StatusBubbleType, message: string, durationMs = 0, download?: AgentDownloadProgress, action?: StatusBubbleAction) {
    let updated = false;
    items.value = items.value.map((item) => {
      if (item.id !== id) return item;
      updated = true;
      return { ...item, type, message, durationMs, progressKey: ++nextProgressKey, download, actionLabel: action?.label, actionKey: action?.key };
    });
    if (!updated) return undefined;
    scheduleDismiss(id, durationMs);
    return id;
  }

  function upsert(id: number | undefined, type: StatusBubbleType, message: string, durationMs = 0, download?: AgentDownloadProgress, action?: StatusBubbleAction) {
    if (id !== undefined) {
      const updatedId = update(id, type, message, durationMs, download, action);
      if (updatedId !== undefined) return updatedId;
    }
    return show(type, message, durationMs, download, action);
  }

  function has(id: number | undefined) {
    return id !== undefined && items.value.some((item) => item.id === id);
  }

  function clear() {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    items.value = [];
  }

  return { items, dismiss, show, update, upsert, has, clear };
}
