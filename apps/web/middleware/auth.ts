import { routeNodeId } from "~/utils/nodeRouting";

export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path === "/login") return;

  if (import.meta.server) {
    return;
  }

  const { api } = useApi();
  const backendNodes = useBackendNodes();
  try {
    await api("/api/auth/verify");
    await backendNodes.refresh();
    const nodes = backendNodes.registry.value;
    if (!nodes.nodes.some((node) => node.id === routeNodeId(to.query.node))) {
      const { node, ...query } = to.query;
      if (nodes.defaultNodeId || node !== undefined) {
        return navigateTo({ path: to.path, query: { ...query, ...(nodes.defaultNodeId ? { node: nodes.defaultNodeId } : {}) } }, { replace: true });
      }
    }
  } catch (error: any) {
    // Only a real 401 means the session is gone. Network errors and 5xx
    // responses (for example while the backend is restarting) must not kick
    // the user back to the login page.
    const status = error?.response?.status ?? error?.statusCode ?? error?.status;
    if (status === 401) {
      return navigateTo("/login", { replace: true });
    }
  }
});
