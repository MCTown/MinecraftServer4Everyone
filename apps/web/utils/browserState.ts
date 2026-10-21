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
