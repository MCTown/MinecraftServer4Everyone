import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { appConfig, defaultSystemPrompt } from "../config.js";
import { nowIso } from "../utils/time.js";
import * as schema from "./schema.js";

let sqlite: Database.Database | null = null;
let database: BetterSQLite3Database<typeof schema> | null = null;

export function initDatabase() {
  sqlite = new Database(appConfig.databasePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      directory TEXT NOT NULL,
      status TEXT NOT NULL,
      java_path TEXT,
      java_version TEXT,
      min_memory TEXT NOT NULL,
      max_memory TEXT NOT NULL,
      jar_file TEXT NOT NULL,
      start_args TEXT NOT NULL,
      server_type TEXT,
      minecraft_version TEXT,
      modpack_name TEXT,
      prompt_override TEXT,
      use_global_prompt INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS console_logs (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      stream TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_console_logs_server_created ON console_logs(server_id, created_at);

    CREATE TABLE IF NOT EXISTS model_configs (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      model_name TEXT NOT NULL,
      encrypted_api_key TEXT NOT NULL,
      api_key_hint TEXT NOT NULL,
      is_default INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_messages (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_messages_server_created ON agent_messages(server_id, created_at);

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      version TEXT NOT NULL,
      path TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      built_in INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      original_name TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);

  database = drizzle(sqlite, { schema });
  const existingPrompt = sqlite.prepare("SELECT value FROM app_settings WHERE key = ?").get("global_system_prompt");
  if (!existingPrompt) {
    sqlite.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run("global_system_prompt", defaultSystemPrompt, nowIso());
  }
}

export function getDb() {
  if (!database) {
    throw new Error("Database has not been initialized");
  }
  return database;
}

export function getSqlite() {
  if (!sqlite) {
    throw new Error("Database has not been initialized");
  }
  return sqlite;
}
