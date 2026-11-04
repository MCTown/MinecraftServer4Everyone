export interface BackendNode {
  id: string;
  name: string;
}

export interface BackendRegistry {
  defaultNodeId: string;
  nodes: BackendNode[];
  canManage: boolean;
  managementDisabledReason: string;
}

export function useBackendNodes() {
  const { api } = useApi();
  const registry = useState<BackendRegistry>("connector-node-registry", () => ({ defaultNodeId: "", nodes: [], canManage: false, managementDisabledReason: "" }));
  const error = useState<string>("connector-node-error", () => "");
  const revision = useState<number>("connector-node-revision", () => 0);
  async function refresh() {
    const current = ++revision.value;
    try {
      const result = await api<BackendRegistry>("/api/connector/nodes");
      if (current === revision.value) { registry.value = result; error.value = ""; }
    } catch (cause: any) {
      if (current === revision.value) error.value = cause?.data?.error ?? "无法读取后端节点，请检查连接器";
      throw cause;
    }
  }
  async function add(input: { name: string; url: string; accessKey: string }) {
    const current = ++revision.value;
    const result = await api<BackendRegistry & { node: BackendNode }>("/api/connector/nodes", { method: "POST", body: input });
    if (current === revision.value) { const { node, ...snapshot } = result; registry.value = snapshot; error.value = ""; }
    return result.node;
  }
  async function remove(id: string) {
    const current = ++revision.value;
    const result = await api<BackendRegistry>(`/api/connector/nodes/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (current === revision.value) { registry.value = result; error.value = ""; }
    return result;
  }
  return { registry, error, refresh, add, remove };
}
