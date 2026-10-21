import type { ModelUsage } from "../services/modelService.js";

export function cacheUsage(usage: ModelUsage | null) {
  if (!usage || usage.cacheHitTokens === undefined) return { status: "unavailable" as const };
  const hit = usage.cacheHitTokens;
  const total = usage.promptTokens;
  if (!Number.isFinite(hit) || !Number.isFinite(total) || hit < 0 || total <= 0 || hit > total ||
    (usage.cacheMissTokens !== undefined && usage.cacheMissTokens !== total - hit)) {
    return { status: "inconsistent" as const, hitTokens: hit };
  }
  return { status: "available" as const, hitTokens: hit, inputTokens: total, rate: hit / total };
}
