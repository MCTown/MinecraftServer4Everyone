import { constants, createWriteStream, type Stats } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, link, readFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";
import yauzl, { type Entry } from "yauzl";
import { list as listTar, extract as extractTar, type ReadEntry } from "tar";
import { normalizeUserPath, resolveWithin } from "../security/pathSandbox.js";
import type { FileEntry } from "../types.js";

const temporaryPrefix = ".file-manager-";
const maxTextBytes = 2 * 1024 * 1024;
const maxArchiveEntries = 100_000;
const maxExtractedBytes = 20 * 1024 ** 3;
const locks = new Map<string, Promise<unknown>>();

export function fileManagerError(message: string, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function relativePath(input = ".") {
  let normalized: string;
  try { normalized = normalizeUserPath(input).split(path.sep).join("/"); }
  catch (error) { throw fileManagerError((error as Error).message); }
  if (normalized.split("/").some((part) => part.startsWith(temporaryPrefix))) throw fileManagerError("不能访问文件操作的临时目录");
  return normalized || ".";
}

function entryName(name: string) {
  if (!name.trim() || name !== name.trim() || /[\x00-\x1f/\\]/.test(name) || name === "." || name === ".." || name.startsWith(temporaryPrefix)) {
    throw fileManagerError("文件名无效，不能包含路径分隔符或控制字符");
  }
  return name;
}

function isWithin(parent: string, child: string) {
  return child === parent || child.startsWith(`${parent}/`);
}

async function optionalStat(target: string) {
  try { return await lstat(target); } catch (error: any) { if (error.code === "ENOENT") return null; throw error; }
}

/** UI file operations share one implementation; templates supply a copy-on-write base. */
export class FileManagerService {
  constructor(
    private readonly getBase: (write: boolean) => Promise<string>,
    private readonly editableExtensions: ReadonlySet<string>,
    private readonly mutationKey?: string
  ) {}

  private async base(write = false) { return realpath(await this.getBase(write)); }

  private async target(base: string, input: string, mustExist = true) {
    const relative = relativePath(input);
    // Do not follow even in-root links: edits/moves must affect the displayed entry,
    // not its referent. Check every ancestor, including dangling symlinks.
    let current = base;
    for (const part of relative === "." ? [] : relative.split("/")) {
      current = path.join(current, part);
      const info = await optionalStat(current);
      if (info?.isSymbolicLink()) throw fileManagerError("文件管理器不支持操作符号链接");
    }
    return resolveWithin(base, relative, { mustExist });
  }

  private async absent(target: string) {
    if (await optionalStat(target)) throw fileManagerError(`目标已存在，请先重命名：${path.basename(target)}`, 409);
  }

  private async directory(base: string, input: string) {
    const target = await this.target(base, input);
    if (!(await lstat(target)).isDirectory()) throw fileManagerError("目标不是文件夹");
    return target;
  }

  private async mutate<T>(action: (base: string) => Promise<T>) {
    // Serialize UI mutations, including the first template copy-on-write.
    const key = this.mutationKey ?? await this.base();
    const previous = locks.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => action(await this.base(true)));
    locks.set(key, current);
    try { return await current; } finally { if (locks.get(key) === current) locks.delete(key); }
  }

  private async entries(base: string, directory: string): Promise<FileEntry[]> {
    const target = await this.directory(base, directory);
    const result: FileEntry[] = [];
    for (const entry of await readdir(target, { withFileTypes: true })) {
      if (entry.name.startsWith(temporaryPrefix) || entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) continue;
      const info = await lstat(path.join(target, entry.name));
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) continue;
      result.push({
        name: entry.name, path: path.posix.join(directory === "." ? "" : directory, entry.name),
        type: info.isDirectory() ? "directory" : "file", size: info.size, modifiedAt: info.mtime.toISOString(),
        editable: info.isFile() && info.nlink === 1 && info.size <= maxTextBytes && this.editableExtensions.has(path.extname(entry.name).toLowerCase())
      });
    }
    return result.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
  }

  async list(directory = ".") { return this.entries(await this.base(), relativePath(directory)); }

  async search(directory: string, filter: string, deep = false) {
    const base = await this.base();
    const results: FileEntry[] = [];
    let visited = 0;
    const walk = async (current: string, depth: number): Promise<void> => {
      if (depth > 32 || visited > 20_000 || results.length >= 1_000) return;
      for (const entry of await this.entries(base, current)) {
        visited++;
        if (entry.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())) results.push(entry);
        if (deep && entry.type === "directory") await walk(entry.path, depth + 1);
        if (visited > 20_000 || results.length >= 1_000) break;
      }
    };
    await walk(relativePath(directory), 0);
    return results;
  }

  async download(input: string) {
    const base = await this.base();
    const target = await this.target(base, input);
    const info = await lstat(target);
    if (!info.isFile() || info.nlink !== 1) throw fileManagerError("目标不是可读取的普通文件");
    return { absolutePath: target, fileName: path.basename(target), size: info.size };
  }

  async readText(input: string) {
    const file = await this.download(input);
    if (!this.editableExtensions.has(path.extname(file.fileName).toLowerCase())) throw fileManagerError("该文件类型不支持文本编辑");
    if (file.size > maxTextBytes) throw fileManagerError("文件超过 2 MB，无法在线编辑");
    return readFile(file.absolutePath, "utf8");
  }

  async save(input: string, content: string) {
    return this.mutate(async (base) => {
      if (!this.editableExtensions.has(path.extname(input).toLowerCase())) throw fileManagerError("该文件类型不支持文本编辑");
      if (Buffer.byteLength(content) > maxTextBytes) throw fileManagerError("文本内容超过 2 MB");
      const target = await this.target(base, input);
      const handle = await open(target, constants.O_WRONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1) throw fileManagerError("不能编辑链接或特殊文件");
        await handle.truncate(0);
        await handle.writeFile(content, "utf8");
      } finally { await handle.close(); }
    });
  }

  async create(directory: string, name: string, folder: boolean) {
    return this.mutate(async (base) => {
      const parent = await this.directory(base, directory);
      const target = path.join(parent, entryName(name));
      await this.absent(target);
      if (folder) await mkdir(target);
      else { const handle = await open(target, "wx"); await handle.close(); }
    });
  }

  private sources(inputs: string[]) {
    const sources = [...new Set(inputs.map(relativePath))];
    if (!sources.length || sources.includes(".")) throw fileManagerError("不能操作根目录或空的文件选择");
    return sources.filter((source) => !sources.some((other) => source !== other && isWithin(other, source)));
  }

  async remove(inputs: string[]) {
    return this.mutate(async (base) => {
      const targets = await Promise.all(this.sources(inputs).map((input) => this.target(base, input)));
      for (const target of targets) await rm(target, { recursive: true });
    });
  }

  async rename(input: string, name: string) {
    return this.mutate(async (base) => {
      if (relativePath(input) === ".") throw fileManagerError("不能重命名根目录");
      const source = await this.target(base, input);
      const destination = path.join(path.dirname(source), entryName(name));
      if (source === destination) return;
      await this.absent(destination);
      await rename(source, destination);
    });
  }

  private async walk(base: string, input: string, visit: (absolute: string, relative: string, directory: boolean) => Promise<void>): Promise<void> {
    const target = await this.target(base, input);
    const info = await lstat(target);
    if ((!info.isDirectory() && !info.isFile()) || (info.isFile() && info.nlink !== 1)) throw fileManagerError("不能复制或压缩链接及特殊文件");
    await visit(target, input, info.isDirectory());
    if (info.isDirectory()) {
      for (const entry of await readdir(target)) {
        if (entry.startsWith(temporaryPrefix)) throw fileManagerError("目录内有正在进行的文件操作，请稍后重试");
        await this.walk(base, path.posix.join(input, entry), visit);
      }
    }
  }

  async transfer(inputs: string[], destination: string, move: boolean) {
    return this.mutate(async (base) => {
      const parent = await this.directory(base, destination);
      const sources = this.sources(inputs);
      const plans: { source: string; target: string; input: string }[] = [];
      const names = new Set<string>();
      // Preflight the entire batch before changing anything, never silently overwrite.
      for (const input of sources) {
        const source = await this.target(base, input);
        const target = path.join(parent, path.basename(source));
        if (parent === source || parent.startsWith(`${source}${path.sep}`)) throw fileManagerError("不能复制或移动到自身及其子目录");
        if (names.has(target)) throw fileManagerError("选择中存在同名文件，请分开操作", 409);
        names.add(target);
        await this.absent(target);
        await this.walk(base, input, async () => undefined);
        plans.push({ source, target, input });
      }
      for (const plan of plans) {
        if (move) { await this.absent(plan.target); await rename(plan.source, plan.target); }
        else await this.walk(base, plan.input, async (source, relative, directory) => {
          const target = path.join(plan.target, path.posix.relative(plan.input, relative));
          if (directory) await mkdir(target);
          else await copyFile(source, target, constants.COPYFILE_EXCL);
        });
      }
    });
  }

  async upload(directory: string, name: string, stream: NodeJS.ReadableStream) {
    return this.mutate(async (base) => {
      // Folder uploads send their relative parent separately, never in filename.
      const relative = relativePath(directory);
      const parent = await this.target(base, relative, false);
      await mkdir(parent, { recursive: true });
      const target = path.join(parent, entryName(name));
      await this.absent(target);
      const staging = await mkdtemp(path.join(base, temporaryPrefix));
      try {
        const partial = path.join(staging, "upload");
        await pipeline(stream, createWriteStream(partial, { flags: "wx" }));
        if ((stream as NodeJS.ReadableStream & { truncated?: boolean }).truncated) throw fileManagerError("上传文件超过大小限制", 413);
        await link(partial, target); // exclusive publish; failed uploads never truncate a file
      } finally { await rm(staging, { recursive: true, force: true }); }
    });
  }

  async archive(inputs: string[], directory: string, name: string) {
    return this.mutate(async (base) => {
      const parent = await this.directory(base, directory);
      entryName(name);
      if (!name.toLowerCase().endsWith(".zip")) throw fileManagerError("压缩文件名必须以 .zip 结尾");
      const target = path.join(parent, name);
      await this.absent(target);
      const files: { absolute: string; name: string; directory: boolean }[] = [];
      const names = new Set<string>();
      for (const input of this.sources(inputs)) {
        const source = await this.target(base, input);
        if (target.startsWith(`${source}${path.sep}`)) throw fileManagerError("不能将压缩包放入被压缩的目录");
        await this.walk(base, input, async (absolute, relative, directory) => {
          const archiveName = path.posix.join(path.posix.basename(input), path.posix.relative(input, relative));
          if (names.has(archiveName)) throw fileManagerError("压缩内容包含同名路径", 409);
          names.add(archiveName);
          files.push({ absolute, name: archiveName, directory });
          if (files.length > maxArchiveEntries) throw fileManagerError("压缩条目超过 100000 项");
        });
      }
      const staging = await mkdtemp(path.join(base, temporaryPrefix));
      const zip = new ZipFile();
      try {
        const partial = path.join(staging, "archive.zip");
        const writing = pipeline(zip.outputStream, createWriteStream(partial, { flags: "wx" }));
        zip.on("error", (error) => (zip.outputStream as Readable).destroy(error));
        for (const file of files) {
          if (file.directory) zip.addEmptyDirectory(file.name);
          else zip.addFile(file.absolute, file.name);
        }
        zip.end();
        await writing;
        await link(partial, target);
      } finally { await rm(staging, { recursive: true, force: true }); }
    });
  }

  async unarchive(input: string, directory: string) {
    return this.mutate(async (base) => {
      const source = await this.target(base, input);
      const sourceInfo = await lstat(source);
      if (!sourceInfo.isFile() || sourceInfo.nlink !== 1) throw fileManagerError("目标不是可读取的普通压缩文件");
      const destination = await this.directory(base, directory);
      const staging = await mkdtemp(path.join(base, temporaryPrefix));
      try {
        if (/\.zip$/i.test(source)) await extractSafeZip(source, staging);
        else if (/\.(tar|tar\.gz|tgz)$/i.test(source)) await extractSafeTar(source, staging);
        else throw fileManagerError("仅支持解压 ZIP、TAR、TAR.GZ 和 TGZ 文件");
        const names = await readdir(staging);
        // Check the whole extracted tree before publishing. Existing directories
        // can merge, but existing files/links are always a conflict.
        const preflight = async (from: string, to: string): Promise<void> => {
          const sourceInfo = await lstat(from), targetInfo = await optionalStat(to);
          if (targetInfo && (!sourceInfo.isDirectory() || !targetInfo.isDirectory() || targetInfo.isSymbolicLink())) {
            throw fileManagerError(`解压目标已存在：${path.relative(destination, to)}`, 409);
          }
          if (sourceInfo.isDirectory()) for (const name of await readdir(from)) await preflight(path.join(from, name), path.join(to, name));
        };
        for (const name of names) await preflight(path.join(staging, name), path.join(destination, name));
        const publish = async (from: string, to: string): Promise<void> => {
          if ((await lstat(from)).isDirectory()) {
            const existing = await optionalStat(to);
            if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) throw fileManagerError("解压目标在操作时发生变化", 409);
            if (!existing) await mkdir(to);
            for (const name of await readdir(from)) await publish(path.join(from, name), path.join(to, name));
          } else await link(from, to);
        };
        for (const name of names) await publish(path.join(staging, name), path.join(destination, name));
      } finally { await rm(staging, { recursive: true, force: true }); }
    });
  }
}

function archivePath(name: string) {
  if (!name || name.includes("\\") || /[\x00-\x1f]/.test(name) || name.startsWith("/") || /^[a-zA-Z]:/.test(name)) throw fileManagerError("压缩包包含不安全路径");
  return relativePath(name);
}

async function extractSafeZip(source: string, destination: string) {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(source, { lazyEntries: true, strictFileNames: true }, (error, zip) => error ? reject(error) : resolve(zip!)));
  let count = 0, bytes = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry: Entry) => {
        void (async () => {
          if (++count > maxArchiveEntries || (bytes += entry.uncompressedSize) > maxExtractedBytes) throw fileManagerError("压缩包超过解压限制（100000 项 / 20 GB）");
          const relative = archivePath(entry.fileName);
          const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
          if ((entry.generalPurposeBitFlag & 1) || (unixType && unixType !== 0o100000 && unixType !== 0o040000)) throw fileManagerError("不支持加密压缩包、链接或特殊文件");
          if (relative === ".") { if (!entry.fileName.endsWith("/")) throw fileManagerError("压缩条目路径无效"); zip.readEntry(); return; }
          const target = path.join(destination, relative);
          if (entry.fileName.endsWith("/")) await mkdir(target, { recursive: true });
          else {
            await mkdir(path.dirname(target), { recursive: true });
            const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream!)));
            let actual = 0;
            await pipeline(stream, new Transform({ transform(chunk, _encoding, callback) {
              actual += chunk.length;
              callback(actual > entry.uncompressedSize ? fileManagerError("压缩条目大小与声明不符") : null, chunk);
            } }), createWriteStream(target, { flags: "wx" }));
          }
          zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });
  } finally { zip.close(); }
}

async function extractSafeTar(source: string, destination: string) {
  let count = 0, bytes = 0;
  let failure: Error | undefined;
  const validate = (name: string, entry: Stats | ReadEntry) => {
    try {
      archivePath(name);
      if (!("type" in entry) || (entry.type !== "File" && entry.type !== "Directory")) throw fileManagerError("压缩包中不允许链接或特殊文件");
      if (++count > maxArchiveEntries || (bytes += entry.size ?? 0) > maxExtractedBytes) throw fileManagerError("压缩包超过解压限制（100000 项 / 20 GB）");
    } catch (error) { failure = error as Error; }
    return !failure;
  };
  await listTar({ file: source, strict: true, filter: validate });
  if (failure) throw failure;
  count = 0; bytes = 0;
  await extractTar({ file: source, cwd: destination, strict: true, preservePaths: false, noChmod: true, keep: true, filter: validate });
  if (failure) throw failure;
}
