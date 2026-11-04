import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { NODE_ID_PATTERN, parseNodeConfig } from "./config.js";

function failure(status, message) { return Object.assign(new Error(message), { status }); }

function parseState(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.removedIds)
    || value.removedIds.some((id) => typeof id !== "string" || !NODE_ID_PATTERN.test(id))
    || new Set(value.removedIds).size !== value.removedIds.length) throw new Error("无效的节点状态文件");
  const added = parseNodeConfig({ nodes: value.added });
  if (added.nodes.some((node) => value.removedIds.includes(node.id))) throw new Error("节点状态文件包含已删除的节点 ID");
  if (typeof value.defaultNodeId !== "string" || (value.defaultNodeId && !NODE_ID_PATTERN.test(value.defaultNodeId))) throw new Error("无效的默认节点 ID");
  return { version: 1, added: added.nodes, removedIds: value.removedIds, defaultNodeId: value.defaultNodeId };
}

/** A private overlay, never a rewrite of configured nodes or environment keys.
 * In particular, the launcher's ephemeral local port/key must not be persisted.
 * One process owns a state file; writes are serialized and published atomically.
 */
export class NodeRegistry extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.queue = Promise.resolve();
    this.state = { version: 1, added: [], removedIds: [], defaultNodeId: "" };
    if (config.registryFile) {
      try { this.state = parseState(JSON.parse(readFileSync(config.registryFile, "utf8"))); }
      catch (error) {
        if (error.code !== "ENOENT") throw new Error("无法读取连接器节点状态文件，请检查权限和格式（不会自动覆盖）");
      }
    }
    this.merge(this.state);
  }

  merge(state) {
    const seeds = this.config.nodes.filter((node) => !state.removedIds.includes(node.id));
    if (state.added.some((node) => seeds.some((seed) => seed.id === node.id))) throw new Error("配置文件与前端管理的节点 ID 冲突");
    const nodes = [...seeds, ...state.added];
    if (nodes.length > 100) throw failure(409, "最多支持 100 个后端节点");
    const defaultNodeId = [state.defaultNodeId, this.config.defaultNodeId].find((id) => nodes.some((node) => node.id === id)) ?? nodes[0]?.id ?? "";
    return { nodes, defaultNodeId };
  }

  snapshot() { return this.merge(this.state); }

  update(transform) {
    const operation = this.queue.then(async () => {
      if (!this.config.registryFile) throw failure(403, "未配置节点状态存储，无法修改后端节点");
      const next = transform(this.state);
      this.merge(next);
      const file = this.config.registryFile;
      const temporary = `${file}.${randomUUID()}.tmp`;
      let handle;
      try {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        handle = await open(temporary, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporary, file);
      } catch {
        throw failure(503, "节点配置保存失败，请检查连接器存储目录权限和磁盘空间；原配置未改变");
      } finally {
        await handle?.close().catch(() => {});
        await unlink(temporary).catch(() => {});
      }
      this.state = next;
      this.emit("change");
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async add(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some((key) => !["name", "url", "accessKey"].includes(key))) throw failure(400, "只允许提交节点名称、地址和访问密钥");
    let node;
    try { [node] = parseNodeConfig({ nodes: [{ id: `node_${randomUUID().replaceAll("-", "")}`, name: input.name, url: input.url, accessKey: input.accessKey }] }).nodes; }
    catch (error) { throw failure(400, error.message.replace(/节点 node_[a-f0-9]+/g, "节点")); }
    await this.update((state) => {
      const current = this.merge(state);
      if (current.nodes.some((item) => item.url === node.url)) throw failure(409, "该后端地址已添加，请刷新节点列表，不要重复提交");
      return { ...state, added: [...state.added, node] };
    });
    return { id: node.id, name: node.name };
  }

  async remove(id) {
    await this.update((state) => {
      const current = this.merge(state);
      if (!current.nodes.some((node) => node.id === id)) throw failure(404, "后端节点不存在或已被移除");
      return {
        ...state,
        added: state.added.filter((node) => node.id !== id),
        removedIds: [...state.removedIds, id],
        defaultNodeId: current.defaultNodeId === id ? current.nodes.find((node) => node.id !== id)?.id ?? "" : current.defaultNodeId
      };
    });
  }
}
