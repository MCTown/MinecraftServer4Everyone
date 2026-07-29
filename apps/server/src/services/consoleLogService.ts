import { asc, desc, eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { consoleLogs } from "../db/schema.js";
import type { ConsoleLogEntry } from "../types.js";
import { createId } from "../utils/id.js";
import { nowIso } from "../utils/time.js";
import { eventBus } from "./eventBus.js";

function rowToLog(row: typeof consoleLogs.$inferSelect): ConsoleLogEntry {
  return {
    id: row.id,
    serverId: row.serverId,
    stream: row.stream as ConsoleLogEntry["stream"],
    text: row.text,
    createdAt: row.createdAt
  };
}

function stripInteractivePromptRedraws(text: string) {
  // MCDReforged's prompt-toolkit redraws its input prompt when stdout is piped.
  // These empty lines are terminal UI artifacts, not server log output.
  return text.replace(/(^|\n)>[ \t]*\r?\n(?:[ \t]*\r?\n){2,}[ \t]*/g, "$1");
}

export class ConsoleLogService {
  clear(serverId: string) {
    getDb().delete(consoleLogs).where(eq(consoleLogs.serverId, serverId)).run();
    eventBus.emit("consoleClear", { serverId });
  }

  append(serverId: string, stream: ConsoleLogEntry["stream"], text: string) {
    const cleanText = stripInteractivePromptRedraws(text);
    if (!cleanText) return null;
    const entry: ConsoleLogEntry = {
      id: createId("log"),
      serverId,
      stream,
      text: cleanText,
      createdAt: nowIso()
    };
    getDb().insert(consoleLogs).values(entry).run();
    eventBus.emit("console", entry);
    return entry;
  }

  list(serverId: string, limit = 300) {
    const rows = getDb()
      .select()
      .from(consoleLogs)
      .where(eq(consoleLogs.serverId, serverId))
      .orderBy(desc(consoleLogs.createdAt))
      .limit(Math.min(Math.max(limit, 1), 2000))
      .all();
    return rows.reverse().map(rowToLog);
  }

  listAll(serverId: string) {
    return getDb()
      .select()
      .from(consoleLogs)
      .where(eq(consoleLogs.serverId, serverId))
      .orderBy(asc(consoleLogs.createdAt))
      .all()
      .map(rowToLog);
  }
}
