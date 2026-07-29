export function parseMemoryToMb(value: string | number | null | undefined, fallbackMb = 512) {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallbackMb;
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d+(?:\.\d+)?)\s*([gGmM])?$/);
  if (!match) return fallbackMb;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return fallbackMb;
  return match[2]?.toLowerCase() === "g" ? amount * 1024 : amount;
}

export function formatMemoryConfig(valueMb: number) {
  return valueMb % 1024 === 0 ? `${valueMb / 1024}G` : `${valueMb}M`;
}

export function formatBytes(bytes: number) {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatMemoryMb(value: number) {
  return value >= 1024 ? `${(value / 1024).toFixed(value % 1024 === 0 ? 0 : 1)} GB` : `${value} MB`;
}
