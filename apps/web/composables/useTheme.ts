import { oppositeTheme, resolveTheme, type AppTheme } from "~/utils/theme";

export function useTheme() {
  // A cookie also lets SSR render the right palette before the first paint.
  const preference = useCookie<string | null>("mcsa_theme", {
    path: "/",
    sameSite: "lax",
    maxAge: 365 * 24 * 60 * 60
  });
  const theme = useState<AppTheme>("app-theme", () => resolveTheme(preference.value));

  // Nuxt broadcasts cookie updates between tabs; keep the shared state in sync.
  watch(preference, (value) => { theme.value = resolveTheme(value); });

  function setTheme(value: AppTheme) {
    theme.value = value;
    preference.value = value;
  }

  return {
    theme,
    isDark: computed(() => theme.value === "dark"),
    setTheme,
    toggleTheme: () => setTheme(oppositeTheme(theme.value))
  };
}
