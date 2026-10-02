export type AppTheme = "dark" | "light";

export function resolveTheme(value: unknown): AppTheme {
  return value === "light" ? "light" : "dark";
}

export function oppositeTheme(theme: AppTheme): AppTheme {
  return theme === "dark" ? "light" : "dark";
}
