/** Browser storage is best effort (private mode / quota restrictions must not break the UI). */
export function readBrowserState<T>(key: string): T | null {
  try { return JSON.parse(localStorage.getItem(`mcsa:${key}`) ?? "null") as T | null; } catch { return null; }
}

export function writeBrowserState(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(`mcsa:${key}`);
    else localStorage.setItem(`mcsa:${key}`, JSON.stringify(value));
  } catch { /* Storage is optional. */ }
}

/** Migrate the former single-backend state only to the built-in local node. */
export function readNodeBrowserState<T>(nodeId: string, key: string): T | null {
  const scoped = readBrowserState<T>(nodeStateKey(nodeId, key));
  if (scoped !== null || nodeId !== "local") return scoped;
  const legacy = readBrowserState<T>(key);
  if (legacy !== null) {
    writeBrowserState(nodeStateKey(nodeId, key), legacy);
    writeBrowserState(key, null);
  }
  return legacy;
}
import { nodeStateKey } from "./nodeRouting";
