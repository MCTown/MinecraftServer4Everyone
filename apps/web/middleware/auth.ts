export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path === "/login") return;

  if (import.meta.server) {
    return;
  }

  const { api } = useApi();
  try {
    await api("/api/auth/verify");
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
