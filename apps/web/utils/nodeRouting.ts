export function routeNodeId(value: unknown): string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value) ? value : "";
}

export function nodeApiPath(path: string, nodeId: string): string {
  if (!nodeId || /^\/api\/(auth|connector)(\/|$)/.test(path)) return path;
  if (!path.startsWith("/api/")) throw new Error("节点请求必须使用 /api/ 路径");
  return `/api/nodes/${encodeURIComponent(nodeId)}${path.slice(4)}`;
}

export function nodeSocketPath(path: string, nodeId: string): string {
  if (!path.startsWith("/ws/")) throw new Error("实时连接必须使用 /ws/ 路径");
  return nodeId ? `/ws/nodes/${encodeURIComponent(nodeId)}${path.slice(3)}` : path;
}

export function nodeStateKey(nodeId: string, key: string): string {
  return nodeId ? `node:${nodeId}:${key}` : key;
}
