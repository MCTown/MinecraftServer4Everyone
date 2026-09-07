import type { ConsoleLogEntry } from "~/types/app";

export interface ConsoleLogBufferLimits {
  maxEntries: number;
  maxLines: number;
}

// One DB row is one raw stdout chunk, not one line: a single entry can carry 100+ lines.
// Capping entries alone therefore does not bound how much text the console actually lays out,
// so a line cap guards against a mod dumping a huge stack trace.
export const defaultConsoleLogBufferLimits: ConsoleLogBufferLimits = { maxEntries: 800, maxLines: 12000 };

export function countTextLines(text: string) {
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

/**
 * Holds the console history as a plain (non-reactive) array so appends stay cheap, and hands out
 * a fresh array identity through snapshot() for a shallowRef to publish. Dedup is O(1) via a Set
 * instead of a linear scan, because the REST fetch and the socket snapshot can replay the same ids.
 */
export function createConsoleLogBuffer(limits: ConsoleLogBufferLimits = defaultConsoleLogBufferLimits) {
  let entries: ConsoleLogEntry[] = [];
  const ids = new Set<string>();
  const lineCounts = new Map<string, number>();
  let totalLines = 0;
  let snapshotCache: ConsoleLogEntry[] | null = null;

  function track(entry: ConsoleLogEntry) {
    const lines = countTextLines(entry.text);
    ids.add(entry.id);
    lineCounts.set(entry.id, lines);
    totalLines += lines;
  }

  function forget(entry: ConsoleLogEntry) {
    ids.delete(entry.id);
    totalLines -= lineCounts.get(entry.id) ?? 1;
    lineCounts.delete(entry.id);
  }

  function trim() {
    let removed = 0;
    while (entries.length - removed > limits.maxEntries) {
      forget(entries[removed]!);
      removed += 1;
    }
    // Always keep one entry, even when it alone exceeds the line cap.
    while (totalLines > limits.maxLines && entries.length - removed > 1) {
      forget(entries[removed]!);
      removed += 1;
    }
    if (!removed) return;
    entries = entries.slice(removed);
  }

  function replaceAll(next: ConsoleLogEntry[]) {
    entries = [];
    ids.clear();
    lineCounts.clear();
    totalLines = 0;
    for (const entry of next) {
      if (ids.has(entry.id)) continue;
      entries.push(entry);
      track(entry);
    }
    trim();
    snapshotCache = null;
  }

  return {
    get size() {
      return entries.length;
    },
    get lineCount() {
      return totalLines;
    },
    has(id: string) {
      return ids.has(id);
    },
    append(entry: ConsoleLogEntry) {
      if (ids.has(entry.id)) return false;
      entries.push(entry);
      track(entry);
      trim();
      snapshotCache = null;
      return true;
    },
    reset(next: ConsoleLogEntry[]) {
      replaceAll(next);
    },
    clear() {
      replaceAll([]);
    },
    snapshot() {
      if (!snapshotCache) snapshotCache = entries.slice();
      return snapshotCache;
    }
  };
}
