import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, rm, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type {
  MapChunkPreview,
  MapMutationPlan,
  MapMutationSelection,
  MapSnapshot,
  ServerRecord
} from "../types.js";
import {
  headerSize,
  previewFromNbt,
  regionFilePattern,
  sectorSize
} from "./mapAnvil.js";
import {
  allowedMapDirectories,
  assertCanPreserveOwnership,
  assertFreeSpace,
  assertMapFileName,
  assertRelativePath,
  copyHandleToPath,
  createTempIn,
  entryPath,
  listExternalChunkFiles,
  mapFileExists,
  openMapDirectory,
  openMapFileIn,
  preserveFrom,
  removeFileIn,
  renameInto,
  requireLinux,
  sweepTempFiles,
  syncDirectory,
  type MapDirectoryHandle
} from "./mapFs.js";
import { MapSnapshotStore, type SnapshotSource } from "./mapSnapshotStore.js";
import { decompressChunk, parseNbt } from "./nbt.js";
import { ProcessManager } from "./processManager.js";
import { ServerService } from "./serverService.js";

const maxChunkBytes = 1_024 * sectorSize;
const maxSelectedChunks = 1_024;

interface Coordinate {
  localX: number;
  localZ: number;
}

interface NormalizedSelection {
  mode: MapMutationSelection["mode"];
  regionPath: string;
  regionFilePath: string;
  regionFileName: string;
  regionX: number;
  regionZ: number;
  coordinates: Coordinate[];
}

interface MutationTarget {
  /** Server-relative POSIX path. */
  path: string;
  directory: MapDirectoryHandle;
  fileName: string;
  /** Region files get their header patched; `.mcc` sidecars are only ever deleted. */
  kind: "region" | "external";
}

function coordinateKey(coordinate: Coordinate) {
  return `${coordinate.localX}:${coordinate.localZ}`;
}

function assertLocal(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 31) throw new Error("区块坐标超出区域范围");
  return value;
}

export class MapService {
  private readonly snapshots = new MapSnapshotStore();

  constructor(
    private readonly serverService: ServerService,
    private readonly processManager: ProcessManager
  ) {}

  private async serverBase(serverId: string) {
    const server = await this.serverService.requireServer(serverId);
    const info = await stat(server.directory);
    if (!info.isDirectory()) throw new Error("服务端工作目录不可用");
    return { server, base: await realpath(server.directory) };
  }

  private normalizeSelection(selection: MapMutationSelection): NormalizedSelection {
    assertRelativePath(selection.regionPath);
    assertRelativePath(selection.regionFilePath);
    if (path.posix.basename(selection.regionPath) !== "region") throw new Error("所选目录不是 region 目录");
    if (path.posix.dirname(selection.regionFilePath) !== selection.regionPath) throw new Error("区域文件不属于所选 region 目录");
    const regionFileName = path.posix.basename(selection.regionFilePath);
    const match = regionFilePattern.exec(regionFileName);
    if (!match) throw new Error("区域文件路径无效");

    let coordinates: Coordinate[] = [];
    if (selection.mode === "chunks") {
      const chunks = selection.chunks ?? [];
      if (chunks.length === 0) throw new Error("至少选择一个区块");
      if (chunks.length > maxSelectedChunks) throw new Error(`单次最多选择 ${maxSelectedChunks} 个区块`);
      const seen = new Map<string, Coordinate>();
      for (const chunk of chunks) {
        const coordinate = { localX: assertLocal(chunk.localX), localZ: assertLocal(chunk.localZ) };
        seen.set(coordinateKey(coordinate), coordinate);
      }
      coordinates = [...seen.values()];
    } else if (selection.mode === "rectangle") {
      const rectangle = selection.rectangle;
      if (!rectangle) throw new Error("矩形选择无效");
      const minX = assertLocal(rectangle.minX);
      const minZ = assertLocal(rectangle.minZ);
      const maxX = assertLocal(rectangle.maxX);
      const maxZ = assertLocal(rectangle.maxZ);
      if (minX > maxX || minZ > maxZ) throw new Error("矩形选择的起点必须不大于终点");
      for (let z = minZ; z <= maxZ; z += 1) for (let x = minX; x <= maxX; x += 1) coordinates.push({ localX: x, localZ: z });
    }
    coordinates.sort((a, b) => a.localZ - b.localZ || a.localX - b.localX);

    return {
      mode: selection.mode,
      regionPath: selection.regionPath,
      regionFilePath: selection.regionFilePath,
      regionFileName,
      regionX: Number(match[1]),
      regionZ: Number(match[2]),
      coordinates
    };
  }

  /**
   * Identity of the exact thing being destroyed. Embedded in the confirmation phrase so a
   * phrase typed for one selection cannot authorize a different selection of equal size.
   */
  private selectionToken(selection: NormalizedSelection) {
    const canonical = JSON.stringify({
      mode: selection.mode,
      file: selection.regionFilePath,
      chunks: selection.coordinates.map((coordinate) => [coordinate.localX, coordinate.localZ])
    });
    return createHash("sha256").update(canonical).digest("hex").slice(0, 8);
  }

  private confirmationPhrase(selection: NormalizedSelection, token: string) {
    const label = selection.mode === "region" ? "整个区域" : `${selection.coordinates.length} 个区块`;
    return `删除 ${label}：${selection.regionFilePath} #${token}`;
  }

  private async openTargets(base: string, selection: NormalizedSelection) {
    const directories: MapDirectoryHandle[] = [];
    const targets: MutationTarget[] = [];
    try {
      for (const name of allowedMapDirectories) {
        const relative = name === "region" ? selection.regionPath : selection.regionPath.replace(/(^|\/)region$/, `$1${name}`);
        if (name !== "region" && relative === selection.regionPath) continue;
        let directory: MapDirectoryHandle;
        try {
          directory = await openMapDirectory(base, relative, [name]);
        } catch (error) {
          if (name === "region") throw error;
          continue;
        }
        directories.push(directory);

        if (await mapFileExists(directory, selection.regionFileName)) {
          targets.push({
            path: path.posix.join(relative, selection.regionFileName),
            directory,
            fileName: selection.regionFileName,
            kind: "region"
          });
        } else if (name === "region") {
          throw new Error("目标区域文件不存在或不是受支持的普通文件");
        }

        // Oversized chunks live in `c.<x>.<z>.mcc` sidecars next to the region file.
        for (const sidecar of await listExternalChunkFiles(directory, selection.regionX, selection.regionZ)) {
          const match = /^c\.(-?\d+)\.(-?\d+)\.mcc$/i.exec(sidecar);
          if (!match) continue;
          const localX = Number(match[1]) - selection.regionX * 32;
          const localZ = Number(match[2]) - selection.regionZ * 32;
          const selected = selection.mode === "region" || selection.coordinates.some((coordinate) => coordinate.localX === localX && coordinate.localZ === localZ);
          if (!selected) continue;
          targets.push({ path: path.posix.join(relative, sidecar), directory, fileName: sidecar, kind: "external" });
        }
      }
      return { directories, targets };
    } catch (error) {
      for (const directory of directories) await directory.handle.close().catch(() => undefined);
      throw error;
    }
  }

  private async closeDirectories(directories: MapDirectoryHandle[]) {
    for (const directory of directories) await directory.handle.close().catch(() => undefined);
  }

  private async readChunkRecord(base: string, selection: { regionPath: string; regionFileName: string }, localX: number, localZ: number) {
    const directory = await openMapDirectory(base, selection.regionPath, ["region"]);
    let handle: FileHandle | undefined;
    try {
      const opened = await openMapFileIn(directory, selection.regionFileName, regionFilePattern);
      handle = opened.handle;
      if (opened.info.size < headerSize) throw new Error("MCA 文件头不足 8192 字节");
      const header = Buffer.alloc(headerSize);
      const headerRead = await handle.read(header, 0, header.length, 0);
      if (headerRead.bytesRead !== header.length) throw new Error("无法读取 MCA 文件头");
      const entryOffset = (localZ * 32 + localX) * 4;
      const sectorOffset = header.readUIntBE(entryOffset, 3);
      const sectorCount = header[entryOffset + 3]!;
      if (sectorOffset < 2 || sectorCount === 0) return null;
      const end = (sectorOffset + sectorCount) * sectorSize;
      if (end > opened.info.size) throw new Error("区块分配超出 MCA 文件范围");
      const chunkBuffer = Buffer.alloc(Math.min(sectorCount * sectorSize, maxChunkBytes));
      const chunkRead = await handle.read(chunkBuffer, 0, chunkBuffer.length, sectorOffset * sectorSize);
      if (chunkRead.bytesRead < 5) throw new Error("区块数据不完整");
      const length = chunkBuffer.readUInt32BE(0);
      if (length < 1 || length + 4 > chunkRead.bytesRead) throw new Error("区块长度字段无效");
      return { compressed: chunkBuffer.subarray(5, 4 + length), compression: chunkBuffer[4]! };
    } finally {
      await handle?.close();
      await directory.handle.close();
    }
  }

  async previewChunk(serverId: string, userPath: string, localX: number, localZ: number): Promise<MapChunkPreview> {
    requireLinux();
    assertLocal(localX);
    assertLocal(localZ);
    assertRelativePath(userPath);
    const regionFileName = assertMapFileName(path.posix.basename(userPath), regionFilePattern);
    const regionPath = path.posix.dirname(userPath);
    const match = regionFilePattern.exec(regionFileName)!;
    const regionX = Number(match[1]);
    const regionZ = Number(match[2]);
    const { base } = await this.serverBase(serverId);

    const empty = (reason: string | null): MapChunkPreview => ({
      path: userPath,
      regionX,
      regionZ,
      localX,
      localZ,
      chunkX: regionX * 32 + localX,
      chunkZ: regionZ * 32 + localZ,
      dataVersion: null,
      cells: [],
      unsupportedReason: reason
    });

    const record = await this.readChunkRecord(base, { regionPath, regionFileName }, localX, localZ);
    if (!record) return empty("该区块尚未生成");
    try {
      const root = parseNbt(decompressChunk(record.compressed, record.compression));
      return previewFromNbt(root, regionX, regionZ, localX, localZ, userPath);
    } catch (error) {
      return empty(error instanceof Error ? error.message : "区块 NBT 无法解码");
    }
  }

  private async ensureStopped(serverId: string): Promise<ServerRecord> {
    const server = await this.serverService.requireServer(serverId);
    if (server.status !== "stopped") throw new Error("高危地图操作要求服务端状态严格为已停止");
    if (this.processManager.getActiveServerId() === serverId || await this.processManager.hasActiveServerProcesses(serverId)) {
      throw new Error("检测到服务端仍有活动进程，无法执行高危地图操作");
    }
    return server;
  }

  async planMutation(serverId: string, selection: MapMutationSelection): Promise<MapMutationPlan> {
    requireLinux();
    const { server, base } = await this.serverBase(serverId);
    const normalized = this.normalizeSelection(selection);
    const { directories, targets } = await this.openTargets(base, normalized);
    try {
      const token = this.selectionToken(normalized);
      return {
        mode: normalized.mode,
        confirmationPhrase: this.confirmationPhrase(normalized, token),
        selectionToken: token,
        affectedPaths: targets.filter((target) => target.kind === "region").map((target) => target.path),
        affectedChunkCount: normalized.mode === "region" ? null : normalized.coordinates.length,
        externalChunkFiles: targets.filter((target) => target.kind === "external").map((target) => target.path),
        requiresStoppedServer: true,
        serverStatus: server.status
      };
    } finally {
      await this.closeDirectories(directories);
    }
  }

  /**
   * Rewrites only the 8 KiB header of a copy, then atomically renames it over the original.
   * Chunk payload sectors are left in place; Minecraft reclaims them on next save.
   */
  private async patchRegionHeader(target: MutationTarget, coordinates: Coordinate[]) {
    const opened = await openMapFileIn(target.directory, target.fileName, regionFilePattern);
    const attributes = preserveFrom(opened.info);
    assertCanPreserveOwnership(target.path, opened.info);
    await assertFreeSpace(target.directory, opened.info.size);
    let tempName = "";
    try {
      if (opened.info.size < headerSize) throw new Error(`${target.path} 的文件头不足 8192 字节`);
      const temp = await createTempIn(target.directory);
      tempName = temp.name;
      await copyHandleToPath(opened.handle, temp.target, opened.info.size, attributes, { chown: true });

      const tempHandle = await open(temp.target, constants.O_RDWR | constants.O_NOFOLLOW);
      try {
        const header = Buffer.alloc(headerSize);
        const read = await tempHandle.read(header, 0, header.length, 0);
        if (read.bytesRead !== header.length) throw new Error(`无法读取 ${target.path} 的文件头`);
        for (const coordinate of coordinates) {
          const offset = (coordinate.localZ * 32 + coordinate.localX) * 4;
          header.fill(0, offset, offset + 4);
          header.fill(0, sectorSize + offset, sectorSize + offset + 4);
        }
        await tempHandle.write(header, 0, header.length, 0);
        await tempHandle.sync();
      } finally {
        await tempHandle.close();
      }

      const latest = await openMapFileIn(target.directory, target.fileName, regionFilePattern);
      try {
        if (latest.info.dev !== opened.info.dev || latest.info.ino !== opened.info.ino || latest.info.size !== opened.info.size) {
          throw new Error(`${target.path} 在操作期间发生变化`);
        }
      } finally {
        await latest.handle.close();
      }

      await renameInto(target.directory, tempName, target.fileName);
      tempName = "";
    } finally {
      await opened.handle.close();
      if (tempName) await rm(entryPath(target.directory, tempName), { force: true }).catch(() => undefined);
    }
  }

  private async restoreFile(serverId: string, snapshotId: string, file: MapSnapshot["files"][number], directory: MapDirectoryHandle) {
    const fileName = assertMapFileName(path.posix.basename(file.path));
    if (file.missing) {
      // The snapshot recorded the file as absent, so restoring means removing it again.
      await rm(entryPath(directory, fileName), { force: true });
      await syncDirectory(directory);
      return;
    }
    const backup = await this.snapshots.openBackup(serverId, snapshotId, file.backupName);
    let tempName = "";
    try {
      if (backup.info.size !== file.size) throw new Error(`快照文件 ${file.backupName} 大小与元数据不一致`);
      await assertFreeSpace(directory, backup.info.size);
      const existing = await openMapFileIn(directory, fileName).catch(() => null);
      const attributes = existing ? preserveFrom(existing.info) : preserveFrom(backup.info);
      if (existing) {
        assertCanPreserveOwnership(file.path, existing.info);
        await existing.handle.close();
      }
      const temp = await createTempIn(directory);
      tempName = temp.name;
      await copyHandleToPath(backup.handle, temp.target, backup.info.size, attributes, { chown: true });
      await renameInto(directory, tempName, fileName);
      tempName = "";
    } finally {
      await backup.handle.close();
      if (tempName) await rm(entryPath(directory, tempName), { force: true }).catch(() => undefined);
    }
  }

  /**
   * True when the on-disk file already equals what the snapshot recorded, so a compensating
   * restore can skip it instead of reporting an untouched file as unrecoverable.
   */
  private async alreadyMatchesSnapshot(file: MapSnapshot["files"][number], directory: MapDirectoryHandle) {
    const fileName = path.posix.basename(file.path);
    const opened = await openMapFileIn(directory, fileName).catch(() => null);
    if (!opened) return file.missing;
    try {
      if (file.missing) return false;
      return opened.info.size === file.size && opened.info.mtime.toISOString() === file.modifiedAt;
    } finally {
      await opened.handle.close();
    }
  }

  /** Best-effort undo after a partially applied mutation. Never throws. */
  private async compensate(serverId: string, snapshot: MapSnapshot, base: string) {
    const restored: string[] = [];
    const failed: string[] = [];
    for (const file of snapshot.files) {
      let directory: MapDirectoryHandle | null = null;
      try {
        directory = await openMapDirectory(base, path.posix.dirname(file.path));
        if (await this.alreadyMatchesSnapshot(file, directory)) continue;
        await this.restoreFile(serverId, snapshot.id, file, directory);
        restored.push(file.path);
      } catch {
        failed.push(file.path);
      } finally {
        await directory?.handle.close().catch(() => undefined);
      }
    }
    return { restored, failed };
  }

  async deleteSelection(
    serverId: string,
    selection: MapMutationSelection,
    confirmationPhrase: string,
    snapshotName: string,
    snapshotDescription: string
  ) {
    requireLinux();
    return this.processManager.runExclusive(async () => {
      const server = await this.ensureStopped(serverId);
      const { base } = await this.serverBase(serverId);
      const normalized = this.normalizeSelection(selection);
      const token = this.selectionToken(normalized);
      if (confirmationPhrase !== this.confirmationPhrase(normalized, token)) {
        throw new Error("高危操作确认词与本次选择不匹配，请重新生成删除计划并逐字输入确认词");
      }

      const { directories, targets } = await this.openTargets(base, normalized);
      try {
        for (const directory of directories) await sweepTempFiles(directory);
        const sources: SnapshotSource[] = targets.map((target) => ({ path: target.path, directory: target.directory, fileName: target.fileName }));
        const snapshot = await this.snapshots.create(serverId, sources, "delete", snapshotName, snapshotDescription);

        const applied: string[] = [];
        try {
          for (const target of targets) {
            if (normalized.mode === "region" || target.kind === "external") await removeFileIn(target.directory, target.fileName);
            else await this.patchRegionHeader(target, normalized.coordinates);
            applied.push(target.path);
          }
        } catch (error) {
          const recovery = await this.compensate(serverId, snapshot, base);
          const detail = error instanceof Error ? error.message : "未知错误";
          throw new Error(
            recovery.failed.length === 0
              ? `删除失败并已自动回滚到操作前状态（快照 ${snapshot.id}）：${detail}`
              : `删除失败且自动回滚未完成，以下文件仍需人工从快照 ${snapshot.id} 恢复：${recovery.failed.join("、")}。原始错误：${detail}`
          );
        }

        await this.snapshots.prune(serverId, [snapshot.id]);
        await this.snapshots.sweepExports(serverId);
        return { ok: true, snapshot, appliedPaths: applied, serverStatus: server.status };
      } finally {
        await this.closeDirectories(directories);
      }
    });
  }

  /** Snapshots the region file (plus siblings and `.mcc` sidecars) selected in the UI. */
  async createManualSnapshot(serverId: string, selection: MapMutationSelection, name: string, description: string) {
    requireLinux();
    return this.processManager.runExclusive(async () => {
      await this.ensureStopped(serverId);
      const { base } = await this.serverBase(serverId);
      const normalized = this.normalizeSelection({ ...selection, mode: "region" });
      const { directories, targets } = await this.openTargets(base, normalized);
      try {
        const sources: SnapshotSource[] = targets.map((target) => ({ path: target.path, directory: target.directory, fileName: target.fileName }));
        const snapshot = await this.snapshots.create(serverId, sources, "manual", name, description);
        await this.snapshots.prune(serverId, [snapshot.id]);
        return snapshot;
      } finally {
        await this.closeDirectories(directories);
      }
    });
  }

  async listSnapshots(serverId: string) {
    await this.serverService.requireServer(serverId);
    return this.snapshots.list(serverId);
  }

  async getSnapshot(serverId: string, snapshotId: string) {
    await this.serverService.requireServer(serverId);
    return this.snapshots.read(serverId, snapshotId);
  }

  async deleteSnapshot(serverId: string, snapshotId: string, confirmationPhrase: string) {
    const snapshot = await this.getSnapshot(serverId, snapshotId);
    if (confirmationPhrase !== snapshot.deleteConfirmationPhrase) throw new Error("删除快照确认词不匹配");
    await this.snapshots.remove(serverId, snapshotId);
    return { ok: true };
  }

  async rollbackSnapshot(serverId: string, snapshotId: string, confirmationPhrase: string) {
    requireLinux();
    return this.processManager.runExclusive(async () => {
      await this.ensureStopped(serverId);
      const snapshot = await this.getSnapshot(serverId, snapshotId);
      if (confirmationPhrase !== snapshot.rollbackConfirmationPhrase) throw new Error("回滚确认词不匹配");
      const { base } = await this.serverBase(serverId);

      const directories = new Map<string, MapDirectoryHandle>();
      try {
        for (const file of snapshot.files) {
          const parent = path.posix.dirname(file.path);
          if (!directories.has(parent)) directories.set(parent, await openMapDirectory(base, parent));
        }
        for (const directory of directories.values()) await sweepTempFiles(directory);

        // Capture current state first; missing files are recorded as such so this snapshot
        // can also undo a whole-region delete.
        const sources: SnapshotSource[] = snapshot.files.map((file) => ({
          path: file.path,
          directory: directories.get(path.posix.dirname(file.path))!,
          fileName: path.posix.basename(file.path)
        }));
        const safety = await this.snapshots.create(serverId, sources, "manual", `回滚前自动快照 ${snapshot.id}`, "回滚前自动保存当前文件");

        try {
          for (const file of snapshot.files) {
            await this.restoreFile(serverId, snapshot.id, file, directories.get(path.posix.dirname(file.path))!);
          }
        } catch (error) {
          const recovery = await this.compensate(serverId, safety, base);
          const detail = error instanceof Error ? error.message : "未知错误";
          throw new Error(
            recovery.failed.length === 0
              ? `回滚失败并已恢复到回滚前状态（快照 ${safety.id}）：${detail}`
              : `回滚失败且恢复未完成，以下文件仍需人工从快照 ${safety.id} 恢复：${recovery.failed.join("、")}。原始错误：${detail}`
          );
        }

        await this.snapshots.prune(serverId, [snapshot.id, safety.id]);
        return { ok: true, snapshot, safetySnapshot: safety };
      } finally {
        for (const directory of directories.values()) await directory.handle.close().catch(() => undefined);
      }
    });
  }

  async openExport(serverId: string, snapshotId: string) {
    const snapshot = await this.getSnapshot(serverId, snapshotId);
    await this.snapshots.sweepExports(serverId);
    return this.snapshots.openExport(serverId, snapshot);
  }
}
