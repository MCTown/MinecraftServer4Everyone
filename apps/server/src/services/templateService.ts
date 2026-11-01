import { createWriteStream } from "node:fs";
import { access, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { appConfig } from "../config.js";
import { resolveWithin } from "../security/pathSandbox.js";
import type { FileEntry } from "../types.js";
import { textExtensions } from "./fileService.js";

const maxEditableBytes = 2 * 1024 * 1024;

async function exists(target: string) {
  return access(target).then(() => true, () => false);
}

function toRelative(base: string, target: string) {
  return path.relative(base, target).split(path.sep).join("/") || ".";
}

export function referenceTemplatePaths(root = appConfig.templatesDir) {
  return {
    // Startup replaces `reference` with the bundled snapshot, so user edits live beside it.
    custom: path.join(root, "reference-custom"),
    reference: path.join(root, "reference"),
    bundled: path.join(appConfig.projectRoot, "templates", "reference")
  };
}

/** The MCDReforged template new instances copy: user override, runtime snapshot, then bundled. */
export async function resolveReferenceTemplateDir(root = appConfig.templatesDir) {
  const paths = referenceTemplatePaths(root);
  for (const candidate of [paths.custom, paths.reference, paths.bundled]) {
    if (await exists(candidate)) return candidate;
  }
  throw new Error("找不到 MCDReforged 模板目录");
}

/** Edits the MCDReforged reference template copy-on-write, keeping the default snapshot intact. */
export class TemplateService {
  constructor(private readonly root = appConfig.templatesDir) {}

  private get paths() {
    return referenceTemplatePaths(this.root);
  }

  async getState() {
    const customized = await exists(this.paths.custom);
    const base = await resolveReferenceTemplateDir(this.root);
    return { customized, files: await this.walk(base) };
  }

  /** Materialize the override from the default template before the first change. */
  private async ensureCustom() {
    const { custom } = this.paths;
    if (await exists(custom)) return custom;
    const source = await resolveReferenceTemplateDir(this.root);
    await mkdir(path.dirname(custom), { recursive: true });
    const staging = await mkdtemp(`${custom}.staging-`);
    try {
      await cp(source, staging, { recursive: true, force: true });
      await rename(staging, custom);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    return custom;
  }

  private async walk(base: string, directory = base): Promise<FileEntry[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const result: FileEntry[] = [];
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      const info = await stat(fullPath);
      const type = entry.isDirectory() ? "directory" : "file";
      result.push({
        name: entry.name,
        path: toRelative(base, fullPath),
        type,
        size: info.size,
        modifiedAt: info.mtime.toISOString(),
        editable: type === "file" && textExtensions.has(path.extname(entry.name).toLowerCase())
      });
      if (type === "directory") result.push(...await this.walk(base, fullPath));
    }
    return result.sort((a, b) => a.path.localeCompare(b.path));
  }

  private assertNotRoot(userPath: string, target: string, base: string) {
    if (path.resolve(target) === path.resolve(base) || !userPath.trim()) throw new Error("不能操作模板根目录");
  }

  async readText(userPath: string) {
    const base = await resolveReferenceTemplateDir(this.root);
    const target = await resolveWithin(base, userPath, { mustExist: true });
    const info = await stat(target);
    if (!info.isFile()) throw new Error("目标不是文件");
    if (!textExtensions.has(path.extname(target).toLowerCase())) throw new Error("该文件类型不支持文本编辑");
    if (info.size > maxEditableBytes) throw new Error("文件超过 2 MB，无法在线编辑");
    return readFile(target, "utf8");
  }

  async writeText(userPath: string, content: string) {
    const base = await this.ensureCustom();
    const target = await resolveWithin(base, userPath);
    this.assertNotRoot(userPath, target, base);
    if (!textExtensions.has(path.extname(target).toLowerCase())) throw new Error("该文件类型不支持文本编辑");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }

  async createFolder(userPath: string) {
    const base = await this.ensureCustom();
    const target = await resolveWithin(base, userPath);
    this.assertNotRoot(userPath, target, base);
    await mkdir(target, { recursive: true });
  }

  async saveStream(directoryPath: string, fileName: string, stream: NodeJS.ReadableStream) {
    const base = await this.ensureCustom();
    const safeName = path.basename(fileName).replace(/[<>:"/\\|?*]/g, "_") || "upload.bin";
    const directory = await resolveWithin(base, directoryPath);
    await mkdir(directory, { recursive: true });
    const destination = await resolveWithin(base, path.join(path.relative(base, directory), safeName));
    // Write beside the target first so a failed upload never truncates an existing plugin.
    const partial = `${destination}.${Date.now()}.partial`;
    try {
      await pipeline(stream, createWriteStream(partial));
      await rename(partial, destination);
    } finally {
      await rm(partial, { force: true });
    }
    return toRelative(base, destination);
  }

  async remove(userPath: string) {
    const base = await this.ensureCustom();
    const target = await resolveWithin(base, userPath, { mustExist: true });
    this.assertNotRoot(userPath, target, base);
    await rm(target, { recursive: true, force: true });
  }

  /** Drop the override; new instances fall back to the bundled default template. */
  async reset() {
    await rm(this.paths.custom, { recursive: true, force: true });
    return this.getState();
  }
}
