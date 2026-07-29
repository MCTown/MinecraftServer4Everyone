import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const servers = sqliteTable("servers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  directory: text("directory").notNull(),
  status: text("status").notNull(),
  javaPath: text("java_path"),
  javaVersion: text("java_version"),
  minMemory: text("min_memory").notNull(),
  maxMemory: text("max_memory").notNull(),
  jarFile: text("jar_file").notNull(),
  startArgs: text("start_args").notNull(),
  startupCommand: text("startup_command"),
  serverType: text("server_type"),
  minecraftVersion: text("minecraft_version"),
  modpackName: text("modpack_name"),
  promptOverride: text("prompt_override"),
  useGlobalPrompt: integer("use_global_prompt").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const consoleLogs = sqliteTable("console_logs", {
  id: text("id").primaryKey(),
  serverId: text("server_id").notNull(),
  stream: text("stream").notNull(),
  text: text("text").notNull(),
  createdAt: text("created_at").notNull()
});

export const modelConfigs = sqliteTable("model_configs", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  baseUrl: text("base_url").notNull(),
  modelName: text("model_name").notNull(),
  encryptedApiKey: text("encrypted_api_key").notNull(),
  apiKeyHint: text("api_key_hint").notNull(),
  isDefault: integer("is_default").notNull(),
  contextSizeK: integer("context_size_k").notNull().default(120),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const agentMessages = sqliteTable("agent_messages", {
  id: text("id").primaryKey(),
  serverId: text("server_id").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  status: text("status"),
  createdAt: text("created_at").notNull()
});

export const skills = sqliteTable("skills", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  version: text("version").notNull(),
  path: text("path").notNull(),
  enabled: integer("enabled").notNull(),
  builtIn: integer("built_in").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const uploads = sqliteTable("uploads", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  originalName: text("original_name").notNull(),
  storedPath: text("stored_path").notNull(),
  size: integer("size").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull()
});
