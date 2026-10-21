import type { AgentContextUsage } from "../types/app";

export function cacheRateLabel(cache: AgentContextUsage["cache"]) {
  if (cache?.status === "inconsistent") return "统计口径异常";
  if (cache?.status !== "available" || typeof cache.rate !== "number" || !Number.isFinite(cache.rate) || cache.rate < 0 || cache.rate > 1) return "暂无数据";
  return `${(cache.rate * 100).toFixed(1)}%`;
}
