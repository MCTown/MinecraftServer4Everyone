import type { DirEntry, Driver, FsData, ArchiveParams, DeleteParams, RenameParams, TransferParams, UnarchiveParams, SearchParams, SaveParams, UploaderContext } from "vuefinder";
import type { FileEntry } from "../types/app";

const storage = "files";
export const finderRoot = `${storage}://`;

export function fromFinderPath(input = finderRoot): string {
  const relative = input.startsWith(finderRoot) ? input.slice(finderRoot.length) : input;
  if (relative.includes("://") || relative.startsWith("/") || relative.includes("\\") || relative.split("/").includes("..")) throw new Error("无效的文件路径");
  return relative.replace(/\/$/, "") || ".";
}

export function toFinderPath(input: string) { return finderRoot + (input === "." ? "" : input); }

export function toFinderEntry(file: FileEntry): DirEntry {
  const parent = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ".";
  const extension = file.name.includes(".") ? file.name.split(".").at(-1)!.toLowerCase() : "";
  const images: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", ico: "image/x-icon", avif: "image/avif" };
  return {
    dir: toFinderPath(parent), basename: file.name, extension, path: toFinderPath(file.path), storage,
    type: file.type === "directory" ? "dir" : "file", file_size: file.type === "file" ? file.size : null,
    last_modified: Math.floor(new Date(file.modifiedAt).getTime() / 1000),
    mime_type: file.editable ? "text/plain" : /\.(zip|tar|tar\.gz|tgz)$/i.test(file.name) ? "application/zip" : images[extension] ?? "application/octet-stream",
    visibility: "private"
  };
}

export interface FileManagerTransport {
  request<T>(suffix: string, options?: { method?: "GET" | "POST" | "PUT"; body?: unknown; query?: Record<string, string>; signal?: AbortSignal }): Promise<T>;
  url(suffix: string, path: string): string;
  configureUploader(uppy: any, context: UploaderContext): void;
  changed(): void;
  busy(active: boolean): void;
}

/** Keep VueFinder's storage protocol out of our REST API and filesystem sandbox. */
export function createFileManagerDriver(transport: FileManagerTransport): Driver {
  async function list(params?: { path?: string; signal?: AbortSignal }): Promise<FsData> {
    const path = fromFinderPath(params?.path);
    let files: FileEntry[];
    try { files = await transport.request<FileEntry[]>("", { query: { path }, signal: params?.signal }); }
    catch (error) {
      // A remembered directory may have been removed by another browser or the
      // server process. Recover to the root instead of reopening a broken view.
      if (path !== "." && (error as { statusCode?: number })?.statusCode === 404) return list({ path: finderRoot, signal: params?.signal });
      throw error;
    }
    return { storages: [storage], dirname: toFinderPath(path), files: files.map(toFinderEntry), read_only: false };
  }
  async function mutate(suffix: string, body: unknown, path: string) {
    transport.busy(true);
    try {
      await transport.request(suffix, { method: "POST", body });
      transport.changed();
      return { ...await list({ path }), read_only: false };
    } finally { transport.busy(false); }
  }
  return {
    list,
    configureUploader: transport.configureUploader,
    delete: (params: DeleteParams) => mutate("/delete", { sources: params.items.map((item) => fromFinderPath(item.path)) }, params.path),
    rename: (params: RenameParams) => mutate("/rename", { path: fromFinderPath(params.item.startsWith(finderRoot) ? params.item : `${params.path.replace(/\/$/, "")}/${params.item}`), name: params.name }, params.path),
    copy: (params: TransferParams) => mutate("/copy", { sources: params.sources.map(fromFinderPath), destination: fromFinderPath(params.destination) }, params.path ?? params.destination),
    move: (params: TransferParams) => mutate("/move", { sources: params.sources.map(fromFinderPath), destination: fromFinderPath(params.destination) }, params.path ?? params.destination),
    archive: (params: ArchiveParams) => mutate("/archive", { sources: params.items.map((item) => fromFinderPath(item.path)), destination: fromFinderPath(params.destination ?? params.path), name: params.name }, params.path),
    unarchive: (params: UnarchiveParams) => mutate("/unarchive", { path: fromFinderPath(params.item), destination: fromFinderPath(params.destination ?? params.path) }, params.path),
    createFile: (params) => mutate("/create", { path: fromFinderPath(params.path), name: params.name, type: "file" }, params.path),
    createFolder: (params) => mutate("/create", { path: fromFinderPath(params.path), name: params.name, type: "directory" }, params.path),
    getContent: (params) => transport.request<{ content: string }>("/text", { query: { path: fromFinderPath(params.path) }, signal: params.signal }),
    getDownloadUrl: (params) => transport.url("/download", fromFinderPath(params.path)),
    getPreviewUrl: (params) => transport.url("/preview", fromFinderPath(params.path)),
    search: async (params: SearchParams) => {
      if (!params.filter.trim()) return [];
      const files = await transport.request<FileEntry[]>("/search", { query: { path: fromFinderPath(params.path), filter: params.filter, deep: params.deep ? "1" : "0" }, signal: params.signal });
      return files.filter((file) => !params.size || params.size === "all" || (params.size === "small" ? file.size < 1024 ** 2 : params.size === "medium" ? file.size >= 1024 ** 2 && file.size < 100 * 1024 ** 2 : file.size >= 100 * 1024 ** 2)).map(toFinderEntry);
    },
    save: async (params: SaveParams) => {
      transport.busy(true);
      try {
        await transport.request("/text", { method: "PUT", body: { path: fromFinderPath(params.path), content: params.content }, signal: params.signal });
        transport.changed();
        return params.path;
      } finally { transport.busy(false); }
    }
  };
}
