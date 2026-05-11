import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { desc, eq } from "drizzle-orm";
import { appConfig } from "../config.js";
import { getDb } from "../db/client.js";
import { agentMessages, consoleLogs, servers, uploads } from "../db/schema.js";
import type { ServerRecord, ServerStatus } from "../types.js";
import { createId } from "../utils/id.js";
import { nowIso } from "../utils/time.js";

export interface CreateServerInput {
  name: string;
}

export interface UpdateServerInput {
  name?: string;
  javaPath?: string | null;
  javaVersion?: string | null;
  minMemory?: string;
  maxMemory?: string;
  jarFile?: string;
  startArgs?: string;
  serverType?: string | null;
  minecraftVersion?: string | null;
  modpackName?: string | null;
  promptOverride?: string | null;
  useGlobalPrompt?: boolean;
}

function rowToServer(row: typeof servers.$inferSelect): ServerRecord {
  return {
    id: row.id,
    name: row.name,
    directory: row.directory,
    status: row.status as ServerStatus,
    javaPath: row.javaPath,
    javaVersion: row.javaVersion,
    minMemory: row.minMemory,
    maxMemory: row.maxMemory,
    jarFile: row.jarFile,
    startArgs: row.startArgs,
    serverType: row.serverType,
    minecraftVersion: row.minecraftVersion,
    modpackName: row.modpackName,
    promptOverride: row.promptOverride,
    useGlobalPrompt: row.useGlobalPrompt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function resolveChildPath(root: string, target: string, label: string) {
  const rootPath = path.resolve(root);
  const targetPath = path.resolve(target);
  const relative = path.relative(rootPath, targetPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} is outside of the allowed directory`);
  }
  return targetPath;
}

function isMissingPathError(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function movePathForDeletion(source: string, label: string) {
  const trashPath = path.join(appConfig.deletedServersDir, `${label}-${Date.now()}-${createId("delete")}`);
  await mkdir(appConfig.deletedServersDir, { recursive: true });
  try {
    await rename(source, trashPath);
    return trashPath;
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

function cleanupDeletedPath(target: string | null) {
  if (!target) return;
  void rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 }).catch((error) => {
    console.error(`Failed to clean deleted path ${target}`, error);
  });
}

export class ServerService {
  async listServers() {
    return getDb().select().from(servers).orderBy(desc(servers.createdAt)).all().map(rowToServer);
  }

  async getServer(id: string) {
    const row = getDb().select().from(servers).where(eq(servers.id, id)).get();
    return row ? rowToServer(row) : null;
  }

  async requireServer(id: string) {
    const server = await this.getServer(id);
    if (!server) {
      throw new Error("Server not found");
    }
    return server;
  }

  async createServer(input: CreateServerInput) {
    const now = nowIso();
    const id = createId("server");
    const directory = path.join(appConfig.serversDir, id);
    await mkdir(directory, { recursive: true });

    const row: typeof servers.$inferInsert = {
      id,
      name: input.name.trim() || "未命名服务端",
      directory,
      status: "stopped",
      javaPath: null,
      javaVersion: null,
      minMemory: "1G",
      maxMemory: "2G",
      jarFile: "server.jar",
      startArgs: "nogui",
      serverType: null,
      minecraftVersion: null,
      modpackName: null,
      promptOverride: null,
      useGlobalPrompt: 1,
      createdAt: now,
      updatedAt: now
    };
    getDb().insert(servers).values(row).run();
    return rowToServer(row as typeof servers.$inferSelect);
  }

  async updateServer(id: string, input: UpdateServerInput) {
    await this.requireServer(id);
    const changes: Partial<typeof servers.$inferInsert> = { updatedAt: nowIso() };
    if (input.name !== undefined) changes.name = input.name.trim() || "未命名服务端";
    if (input.javaPath !== undefined) changes.javaPath = input.javaPath;
    if (input.javaVersion !== undefined) changes.javaVersion = input.javaVersion;
    if (input.minMemory !== undefined) changes.minMemory = input.minMemory;
    if (input.maxMemory !== undefined) changes.maxMemory = input.maxMemory;
    if (input.jarFile !== undefined) changes.jarFile = input.jarFile;
    if (input.startArgs !== undefined) changes.startArgs = input.startArgs;
    if (input.serverType !== undefined) changes.serverType = input.serverType;
    if (input.minecraftVersion !== undefined) changes.minecraftVersion = input.minecraftVersion;
    if (input.modpackName !== undefined) changes.modpackName = input.modpackName;
    if (input.promptOverride !== undefined) changes.promptOverride = input.promptOverride;
    if (input.useGlobalPrompt !== undefined) changes.useGlobalPrompt = input.useGlobalPrompt ? 1 : 0;

    getDb().update(servers).set(changes).where(eq(servers.id, id)).run();
    return this.requireServer(id);
  }

  async deleteServer(id: string, confirmName: string) {
    const server = await this.requireServer(id);
    if (confirmName.trim() !== server.name) {
      throw new Error("服务端名称确认不匹配");
    }
    if (!["stopped", "crashed"].includes(server.status)) {
      throw new Error("服务端正在运行或切换状态，请先关闭后再删除");
    }

    const serverDirectory = resolveChildPath(appConfig.serversDir, server.directory, "Server directory");
    const uploadDirectory = resolveChildPath(appConfig.tempUploadsDir, path.join(appConfig.tempUploadsDir, id), "Upload directory");
    const deletedServerDirectory = await movePathForDeletion(serverDirectory, id);
    const deletedUploadDirectory = await movePathForDeletion(uploadDirectory, `${id}-uploads`);

    const db = getDb();
    db.transaction((tx) => {
      tx.delete(consoleLogs).where(eq(consoleLogs.serverId, id)).run();
      tx.delete(agentMessages).where(eq(agentMessages.serverId, id)).run();
      tx.delete(uploads).where(eq(uploads.sessionId, id)).run();
      tx.delete(servers).where(eq(servers.id, id)).run();
    });

    cleanupDeletedPath(deletedServerDirectory);
    cleanupDeletedPath(deletedUploadDirectory);

    return { ok: true, deletedServerId: id };
  }

  async setStatus(id: string, status: ServerStatus) {
    getDb().update(servers).set({ status, updatedAt: nowIso() }).where(eq(servers.id, id)).run();
  }
}
