/** VueFinder 4.8 merges its built-in persistent defaults over config props.
 * Seed only missing browser preferences before it creates its store; keep the
 * user's later list/grid and tree choices intact. `persist` controls paths,
 * not these display preferences. Storage must remain optional. */
export function initializeFileManagerPreferences(id: string, storage?: Pick<Storage, "getItem" | "setItem">, showTreeView = true) {
  try {
    const target = storage ?? localStorage;
    const key = `vuefinder_config_${id}`;
    const stored = JSON.parse(target.getItem(key) ?? "null");
    const preferences = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
    target.setItem(key, JSON.stringify({ view: "list", showTreeView, showThumbnails: false, ...preferences }));
  } catch { /* Private mode or exhausted quota must not prevent browsing. */ }
}
