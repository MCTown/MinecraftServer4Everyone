import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { open, readdir, realpath, rename, rm, stat, statfs, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { resolveWithin } from "../security/pathSandbox.js";
import { externalChunkFilePattern, regionFilePattern } from "./mapAnvil.js";

export const allowedMapDirectories = ["region", "poi", "entities"] as const;
export const mapFilePattern = new RegExp(`^(?:${regionFilePattern.source.slice(1, -1)}|${externalChunkFilePattern.source.slice(1, -1)})$`, "i");
const tempPrefix = ".map-tmp-";
const copyChunkSize = 256 * 1024;
const freeSpaceMargin = 16 * 1024 * 1024;

export function requireLinux() {
  if (process.platform !== "linux") throw new Error("地图预览和高危操作目前仅支持 Linux 服务端环境");
}

export function assertRelativePath(value: string) {
  const normalized = value.replaceAll("\\", "/");
  if (
    !value ||
    value !== normalized ||
    value.includes("\0") ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split("/").includes("..") ||
    path.posix.normalize(normalized) !== normalized
  ) {
    throw new Error("地图路径无效");
  }
}

export function assertMapFileName(name: string, pattern: RegExp = mapFilePattern) {
  if (!pattern.test(name)) throw new Error(`目标不是受支持的地图文件：${name}`);
  return name;
}

export interface MapDirectoryHandle {
  base: string;
  relative: string;
  absolute: string;
  handle: FileHandle;
}

export interface OpenedMapFile {
  handle: FileHandle;
  info: Stats;
}

/**
 * Opens a `region`/`poi`/`entities` directory and pins it by file descriptor so every
 * later lookup goes through `/proc/self/fd/<fd>/<name>` and cannot be redirected by a
 * symlink swap between the check and the operation.
 */
export async function openMapDirectory(base: string, relativePath: string, allowedNames: readonly string[] = allowedMapDirectories): Promise<MapDirectoryHandle> {
  requireLinux();
  assertRelativePath(relativePath);
  const absolute = await resolveWithin(base, relativePath, { mustExist: true });
  if (!allowedNames.includes(path.basename(absolute))) throw new Error("地图目录无效");
  const handle = await open(absolute, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: false });
    if (!opened.isDirectory()) throw new Error("地图目录不可用");
    const current = await realpath(absolute);
    const relative = path.relative(base, current);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("地图目录超出服务端范围");
    const currentInfo = await stat(current);
    if (currentInfo.dev !== opened.dev || currentInfo.ino !== opened.ino) throw new Error("地图目录在读取时发生变化");
    return { base, relative: relativePath, absolute: current, handle };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export function entryPath(directory: MapDirectoryHandle, name: string) {
  return `/proc/self/fd/${directory.handle.fd}/${name}`;
}

export async function openMapFileIn(directory: MapDirectoryHandle, name: string, pattern: RegExp = mapFilePattern): Promise<OpenedMapFile> {
  assertMapFileName(name, pattern);
  const handle = await open(entryPath(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat({ bigint: false });
    if (!info.isFile()) throw new Error("目标不是普通文件");
    if (info.nlink !== 1) throw new Error("目标存在硬链接，拒绝操作以避免影响其他文件");
    return { handle, info };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function mapFileExists(directory: MapDirectoryHandle, name: string) {
  try {
    const opened = await openMapFileIn(directory, name);
    await opened.handle.close();
    return true;
  } catch {
    return false;
  }
}

export interface PreserveAttributes {
  mode: number;
  uid: number;
  gid: number;
  atime: Date;
  mtime: Date;
}

export function preserveFrom(info: { mode: number; uid: number; gid: number; atime: Date; mtime: Date }): PreserveAttributes {
  return { mode: info.mode & 0o7777, uid: info.uid, gid: info.gid, atime: info.atime, mtime: info.mtime };
}

/**
 * Replacing a file in place recreates its inode, so ownership must be reapplied. Only
 * root can hand a file to another uid/gid, so refuse up front rather than silently
 * leaving a world file the Minecraft service account can no longer write.
 */
export function assertCanPreserveOwnership(relativePath: string, info: { uid: number; gid: number }) {
  const uid = process.getuid?.() ?? info.uid;
  const gid = process.getgid?.() ?? info.gid;
  if (uid === 0) return;
  if (info.uid !== uid || info.gid !== gid) {
    throw new Error(
      `${relativePath} 的属主为 ${info.uid}:${info.gid}，当前进程（${uid}:${gid}）无法在改写后恢复该属主。请以相同账户或 root 运行后重试，避免服务端启动时无法读写地图文件。`
    );
  }
}

async function applyAttributes(target: FileHandle, attributes: PreserveAttributes, chown: boolean) {
  await target.chmod(attributes.mode);
  if (chown && !(attributes.uid === process.getuid?.() && attributes.gid === process.getgid?.())) {
    try {
      await target.chown(attributes.uid, attributes.gid);
    } catch (error) {
      throw new Error(
        `无法保留地图文件的原有属主 ${attributes.uid}:${attributes.gid}，已中止操作以避免服务端下次启动无法读写该文件（${error instanceof Error ? error.message : "未知错误"}）`
      );
    }
  }
  await target.utimes(attributes.atime, attributes.mtime);
}

export async function assertFreeSpace(directory: MapDirectoryHandle, bytes: number) {
  try {
    const info = await statfs(directory.absolute);
    const available = Number(info.bavail) * Number(info.bsize);
    if (available < bytes + freeSpaceMargin) {
      throw new Error(`目标磁盘剩余空间不足，需要约 ${Math.ceil((bytes + freeSpaceMargin) / 1_048_576)} MiB，实际可用 ${Math.floor(available / 1_048_576)} MiB`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("目标磁盘剩余空间不足")) throw error;
  }
}

/**
 * Streams `size` bytes from an already-opened handle into a freshly created file.
 * Re-stats the source afterwards so a file that changed underneath us fails loudly
 * instead of producing a silently truncated copy.
 */
export async function copyHandleToPath(
  source: FileHandle,
  destination: string,
  size: number,
  attributes?: PreserveAttributes,
  options: { chown?: boolean } = {}
) {
  const target = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const buffer = Buffer.alloc(copyChunkSize);
  let position = 0;
  try {
    while (position < size) {
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, size - position), position);
      if (bytesRead === 0) throw new Error("文件在复制期间被截断");
      let written = 0;
      while (written < bytesRead) {
        const result = await target.write(buffer, written, bytesRead - written, position + written);
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    const after = await source.stat({ bigint: false });
    if (after.size !== size) throw new Error("文件在复制期间大小发生变化");
    if (attributes) await applyAttributes(target, attributes, options.chown ?? false);
    await target.sync();
  } finally {
    await target.close();
  }
}

export async function syncDirectory(directory: MapDirectoryHandle) {
  await directory.handle.sync().catch(() => undefined);
}

export async function createTempIn(directory: MapDirectoryHandle) {
  const name = `${tempPrefix}${randomUUID()}`;
  return { name, target: entryPath(directory, name) };
}

/** Removes leftover temp files from a previous crash. Only safe while holding the exclusive lock. */
export async function sweepTempFiles(directory: MapDirectoryHandle) {
  let entries;
  try {
    entries = await readdir(directory.absolute, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(tempPrefix)) continue;
    await rm(entryPath(directory, entry.name), { force: true }).catch(() => undefined);
  }
}

export async function renameInto(directory: MapDirectoryHandle, tempName: string, finalName: string) {
  assertMapFileName(finalName);
  await rename(entryPath(directory, tempName), entryPath(directory, finalName));
  await syncDirectory(directory);
}

export async function removeFileIn(directory: MapDirectoryHandle, name: string) {
  assertMapFileName(name);
  const opened = await openMapFileIn(directory, name);
  await opened.handle.close();
  await rm(entryPath(directory, name), { force: true });
  await syncDirectory(directory);
}

export async function listExternalChunkFiles(directory: MapDirectoryHandle, regionX: number, regionZ: number) {
  let entries;
  try {
    entries = await readdir(directory.absolute, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = externalChunkFilePattern.exec(entry.name);
    if (!match) continue;
    const chunkX = Number(match[1]);
    const chunkZ = Number(match[2]);
    if (Math.floor(chunkX / 32) === regionX && Math.floor(chunkZ / 32) === regionZ) names.push(entry.name);
  }
  return names.sort();
}
