export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path === "/login") return;

  if (import.meta.server) {
    return;
  }

  const { api } = useApi();
  try {
    await api("/api/auth/verify");
  } catch {
    return navigateTo("/login", { replace: true });
  }
});
