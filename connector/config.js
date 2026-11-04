import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const NODE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function parseNodeConfig(value, env = process.env) {
  if (!value || !Array.isArray(value.nodes) || value.nodes.length > 100) {
    throw new Error("连接器配置必须包含 0–100 个 nodes");
  }
  const ids = new Set();
  const nodes = value.nodes.map((entry) => {
    if (!entry || !NODE_ID_PATTERN.test(entry.id) || typeof entry.id !== "string" || ids.has(entry.id)) {
      throw new Error("节点 ID 必须唯一，且只能包含 1–64 位字母、数字、下划线和连字符");
    }
    ids.add(entry.id);
    if (typeof entry.name !== "string" || !entry.name.trim() || entry.name.length > 100) throw new Error(`节点 ${entry.id} 缺少有效名称`);
    let url;
    try { url = new URL(entry.url); } catch { throw new Error(`节点 ${entry.id} 的 URL 无效`); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error(`节点 ${entry.id} 必须使用不含路径、凭据或查询参数的 HTTP(S) 地址`);
    }
    const accessKey = entry.accessKeyEnv ? env[entry.accessKeyEnv] : entry.accessKey;
    if (typeof accessKey !== "string" || !accessKey.trim() || accessKey.length > 4096 || /[^\x21-\x7e]/.test(accessKey)) throw new Error(`节点 ${entry.id} 缺少有效的 accessKey / accessKeyEnv（须为可打印 ASCII，不能含空格）`);
    return { id: entry.id, name: entry.name.trim(), url: url.origin, accessKey };
  });
  const defaultNodeId = value.defaultNodeId ?? nodes[0]?.id ?? "";
  if (nodes.length ? !ids.has(defaultNodeId) : defaultNodeId !== "") throw new Error("defaultNodeId 必须指向已配置的节点");
  return { defaultNodeId, nodes };
}

export function loadConnectorConfig(env = process.env) {
  const shared = {
    password: env.APP_PASSWORD ?? "ilovemct",
    secretKey: env.APP_SECRET_KEY ?? "dev-secret-change-me",
    webTarget: env.PROXY_WEB_TARGET ?? `http://127.0.0.1:${env.NUXT_PORT ?? env.NITRO_PORT ?? 3000}`,
    registryFile: resolve(env.CONNECTOR_STATE_FILE ?? ".data/connector/nodes.json")
  };
  if (env.CONNECTOR_NODES_FILE) {
    if (resolve(env.CONNECTOR_NODES_FILE) === shared.registryFile) throw new Error("CONNECTOR_STATE_FILE 不能与 CONNECTOR_NODES_FILE 相同");
    const registry = parseNodeConfig(JSON.parse(readFileSync(env.CONNECTOR_NODES_FILE, "utf8")), env);
    return { ...shared, ...registry };
  }
  if (env.CONNECTOR_ONLY === "true") return { ...shared, nodes: [], defaultNodeId: "" };
  const url = env.PROXY_API_TARGET ?? `http://127.0.0.1:${env.APP_PORT ?? 8787}`;
  if (env.APP_ACCESS_KEY) {
    return { ...shared, ...parseNodeConfig({ nodes: [{ id: "local", name: "本机后端", url, accessKey: env.APP_ACCESS_KEY }] }, env) };
  }
  // Compatibility for manually launched, local-only legacy installations. The
  // combined launcher always supplies a dedicated node key instead.
  const target = new URL(url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || !["http:", "https:"].includes(target.protocol) || target.pathname !== "/" || target.username || target.password || target.search || target.hash) {
    throw new Error("远程后端必须配置 APP_ACCESS_KEY 或 CONNECTOR_NODES_FILE");
  }
  return { ...shared, defaultNodeId: "local", nodes: [{ id: "local", name: "本机后端", url: target.origin, legacyLocalAuth: true }] };
}
