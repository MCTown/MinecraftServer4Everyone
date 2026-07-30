import { randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { create as createTar } from "tar";
import { appConfig } from "../config.js";
import type { MapSnapshot, MapSnapshotFile } from "../types.js";
import { externalChunkFilePattern, regionFilePattern } from "./mapAnvil.js";
import {
  allowedMapDirectories,
  assertRelativePath,
  copyHandleToPath,
  mapFilePattern,
  openMapDirectory,
  openMapFileIn,
  preserveFrom,
  requireLinux,
  type MapDirectoryHandle,
  type OpenedMapFile
} from "./mapFs.js";

const maxSnapshotsPerServer = 20;
const maxSnapshotFiles = 256;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const backupNamePattern = new RegExp(`^\\d{1,3}-(?:${regionFilePattern.source.slice(1, -1)}|${externalChunkFilePattern.source.slice(1, -1)})$`, "i");

function assertServerId(serverId: string) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(serverId)) throw new Error("服务端标识无效");
  return serverId;
}

function assertSnapshotId(id: string) {
  if (!uuidPattern.test(id)) throw new Error("快照标识无效");
  return id;
}

/** Persists metadata via temp file + rename + directory fsync so a crash never leaves a half-written snapshot. */
async function writeMetadataDurably(root: string, snapshot: MapSnapshot) {
  const tempPath = path.join(root, `.metadata-${randomUUID()}.json`);
  const handle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, path.join(root, "metadata.json"));
  const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await directory.sync().catch(() => undefined);
  } finally {
    await directory.close();
  }
}

export interface SnapshotSource {
  /** Server-relative POSIX path, e.g. `server/world/region/r.0.0.mca`. */
  path: string;
  directory: MapDirectoryHandle;
  fileName: string;
}

export class MapSnapshotStore {
  root(serverId: string) {
    return path.join(appConfig.mapSnapshotsDir, assertServerId(serverId));
  }

  private snapshotDir(serverId: string, snapshotId: string) {
    return path.join(this.root(serverId), assertSnapshotId(snapshotId));
  }

  backupPath(serverId: string, snapshotId: string, backupName: string) {
    if (!backupNamePattern.test(backupName)) throw new Error("快照文件名无效");
    return path.join(this.snapshotDir(serverId, snapshotId), "files", backupName);
  }

  private validate(serverId: string, id: string, snapshot: MapSnapshot) {
    if (snapshot.id !== id || snapshot.serverId !== serverId || !Array.isArray(snapshot.files) || snapshot.files.length > maxSnapshotFiles) {
      throw new Error("快照元数据无效");
    }
    for (const file of snapshot.files) {
      assertRelativePath(file.path);
      if (!mapFilePattern.test(path.posix.basename(file.path))) throw new Error("快照路径无效");
      if (!allowedMapDirectories.includes(path.posix.basename(path.posix.dirname(file.path)) as never)) throw new Error("快照路径无效");
      if (file.missing) {
        if (file.backupName !== "") throw new Error("快照元数据无效");
        continue;
      }
      if (!backupNamePattern.test(file.backupName)) throw new Error("快照文件名无效");
    }
    return snapshot;
  }

  async read(serverId: string, snapshotId: string): Promise<MapSnapshot> {
    const file = path.join(this.snapshotDir(serverId, snapshotId), "metadata.json");
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      throw new Error("快照不存在或元数据缺失");
    }
    return this.validate(serverId, snapshotId, JSON.parse(raw) as MapSnapshot);
  }

  async list(serverId: string) {
    let entries;
    try {
      entries = await readdir(this.root(serverId), { withFileTypes: true });
    } catch {
      return [];
    }
    const snapshots: MapSnapshot[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !uuidPattern.test(entry.name)) continue;
      try {
        snapshots.push(await this.read(serverId, entry.name));
      } catch { /* Skip incomplete snapshot directories. */ }
    }
    return snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }

  /**
   * Copies every source into a new snapshot directory. Sources that do not exist are
   * recorded with `missing: true` so a rollback can reproduce the deletion instead of
   * failing — this is what makes whole-region deletes reversible.
   */
  async create(
    serverId: string,
    sources: SnapshotSource[],
    reason: MapSnapshot["reason"],
    name: string,
    description: string
  ): Promise<MapSnapshot> {
    requireLinux();
    if (sources.length === 0) throw new Error("快照至少需要一个目标文件");
    if (sources.length > maxSnapshotFiles) throw new Error(`单个快照最多包含 ${maxSnapshotFiles} 个文件`);
    const id = randomUUID();
    const root = this.snapshotDir(serverId, id);
    const filesRoot = path.join(root, "files");
    await mkdir(filesRoot, { recursive: true });
    try {
      const files: MapSnapshotFile[] = [];
      for (const source of sources) {
        let opened: OpenedMapFile | null = null;
        try {
          opened = await openMapFileIn(source.directory, source.fileName);
        } catch {
          files.push({ path: source.path, backupName: "", size: 0, modifiedAt: new Date().toISOString(), missing: true });
          continue;
        }
        try {
          const backupName = `${files.length}-${source.fileName}`;
          await copyHandleToPath(opened.handle, path.join(filesRoot, backupName), opened.info.size, preserveFrom(opened.info));
          files.push({
            path: source.path,
            backupName,
            size: opened.info.size,
            modifiedAt: opened.info.mtime.toISOString(),
            missing: false
          });
        } finally {
          await opened.handle.close();
        }
      }
      const snapshot: MapSnapshot = {
        id,
        serverId,
        name: name.trim() || `地图快照 ${new Date().toLocaleString("zh-CN")}`,
        description: description.trim(),
        reason,
        createdAt: new Date().toISOString(),
        files,
        rollbackConfirmationPhrase: `回滚快照 ${id}`,
        deleteConfirmationPhrase: `删除快照 ${id}`
      };
      await writeMetadataDurably(root, snapshot);
      return snapshot;
    } catch (error) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Enforces retention. `protectedIds` are never pruned, so a snapshot currently being
   * rolled back cannot be deleted out from under the restore.
   */
  async prune(serverId: string, protectedIds: string[] = []) {
    const root = this.root(serverId);
    const keep = new Set(protectedIds);
    const snapshots = await this.list(serverId);
    const prunable = snapshots.filter((snapshot) => !keep.has(snapshot.id));
    const removable = prunable.slice(Math.max(0, maxSnapshotsPerServer - keep.size));
    for (const snapshot of removable) {
      await rm(path.join(root, snapshot.id), { recursive: true, force: true }).catch(() => undefined);
    }
    return removable.map((snapshot) => snapshot.id);
  }

  async remove(serverId: string, snapshotId: string) {
    await rm(this.snapshotDir(serverId, snapshotId), { recursive: true, force: true });
  }

  async openBackup(serverId: string, snapshotId: string, backupName: string) {
    const target = this.backupPath(serverId, snapshotId, backupName);
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat({ bigint: false });
      if (!info.isFile()) throw new Error("快照文件不是普通文件");
      return { handle, info };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  /**
   * Builds the archive at a request-unique path and deletes it once the response stream
   * finishes, so concurrent exports never interleave writes into a shared file.
   */
  async openExport(serverId: string, snapshot: MapSnapshot) {
    const exportsRoot = path.join(this.root(serverId), "exports");
    await mkdir(exportsRoot, { recursive: true });
    const output = path.join(exportsRoot, `${snapshot.id}-${randomUUID()}.tar.gz`);
    try {
      await createTar({ gzip: true, file: output, cwd: this.snapshotDir(serverId, snapshot.id) }, ["metadata.json", "files"]);
      const info = await stat(output);
      const stream = createReadStream(output);
      const cleanup = () => { void rm(output, { force: true }).catch(() => undefined); };
      stream.once("close", cleanup);
      stream.once("error", cleanup);
      const safeName = snapshot.name.replace(/[^\w\u4e00-\u9fff.-]+/g, "_").slice(0, 80) || snapshot.id;
      return { size: info.size, stream, fileName: `${safeName}.tar.gz` };
    } catch (error) {
      await rm(output, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** Drops archives left behind by an interrupted download. */
  async sweepExports(serverId: string) {
    const exportsRoot = path.join(this.root(serverId), "exports");
    let entries;
    try {
      entries = await readdir(exportsRoot, { withFileTypes: true });
    } catch {
      return;
    }
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".tar.gz")) continue;
      const target = path.join(exportsRoot, entry.name);
      const info = await stat(target).catch(() => null);
      if (info && info.mtimeMs < cutoff) await rm(target, { force: true }).catch(() => undefined);
    }
  }

  async openSnapshotDirectory(base: string, relativePath: string) {
    return openMapDirectory(base, relativePath);
  }
}
