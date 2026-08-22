import type { TaskExecutionStats } from "./types.js";

export type OutputTokenRateStats = Pick<
  TaskExecutionStats,
  "startedAt" | "completedAt" | "durationMs" | "outputTokens"
>;

export type TotalTokenStats = Pick<
  TaskExecutionStats,
  "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "totalTokens"
>;

export type CacheHitRatioStats = Pick<
  TaskExecutionStats,
  "inputTokens" | "cacheReadTokens" | "cacheWriteTokens"
>;

function compactTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  return `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

function compactWidgetTotalTokenCount(tokens: number): string {
  if (tokens < 1_000_000) return compactTokenCount(tokens);

  // Keep three decimal places without rounding up the provider-reported total.
  const millions = Math.trunc(tokens / 1000) / 1000;
  return `${millions.toFixed(3).replace(/\.?(?:0+)$/, "")}M`;
}

/**
 * Return Pi's provider-reported total when available, including cache traffic.
 * Component-aware records fall back to all token categories; legacy records use input + output.
 */
export function calculateTotalTokens(stats: TotalTokenStats): number | undefined {
  const reportedTotal = stats.totalTokens;
  if (reportedTotal !== undefined && Number.isFinite(reportedTotal) && reportedTotal > 0) {
    return reportedTotal;
  }

  const tokenComponents = [
    stats.inputTokens ?? 0,
    stats.outputTokens ?? 0,
    stats.cacheReadTokens ?? 0,
    stats.cacheWriteTokens ?? 0,
  ];
  if (tokenComponents.some(tokens => !Number.isFinite(tokens) || tokens < 0)) {
    return undefined;
  }

  const fallbackTotal = tokenComponents.reduce((total, tokens) => total + tokens, 0);
  return Number.isFinite(fallbackTotal) && fallbackTotal > 0 ? fallbackTotal : undefined;
}

/** Format a task's total usage as a compact token count. */
export function formatTotalTokens(stats: TotalTokenStats): string | undefined {
  const totalTokens = calculateTotalTokens(stats);
  return totalTokens === undefined ? undefined : `${compactTokenCount(totalTokens)} tok`;
}

/** Format total usage for the compact widget, using sigma and M for millions. */
export function formatCompactTotalTokens(stats: TotalTokenStats): string | undefined {
  const totalTokens = calculateTotalTokens(stats);
  return totalTokens === undefined ? undefined : `Σ${compactWidgetTotalTokenCount(totalTokens)}`;
}

/**
 * Calculate task-wide prompt cache hits using Pi's cache-read / prompt-token formula.
 * Returns undefined until the provider reports cache reads or writes.
 */
export function calculateCacheHitRatio(stats: CacheHitRatioStats): number | undefined {
  const inputTokens = stats.inputTokens ?? 0;
  const cacheReadTokens = stats.cacheReadTokens ?? 0;
  const cacheWriteTokens = stats.cacheWriteTokens ?? 0;
  if (
    !Number.isFinite(inputTokens) ||
    inputTokens < 0 ||
    !Number.isFinite(cacheReadTokens) ||
    cacheReadTokens < 0 ||
    !Number.isFinite(cacheWriteTokens) ||
    cacheWriteTokens < 0 ||
    cacheReadTokens + cacheWriteTokens <= 0
  ) {
    return undefined;
  }

  const promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
  if (!Number.isFinite(promptTokens) || promptTokens <= 0) return undefined;

  const ratio = cacheReadTokens / promptTokens;
  return Number.isFinite(ratio) && ratio >= 0 && ratio <= 1 ? ratio : undefined;
}

/** Format the cache hit ratio as a labeled percentage. */
export function formatCacheHitRatio(stats: CacheHitRatioStats): string | undefined {
  const ratio = calculateCacheHitRatio(stats);
  return ratio === undefined ? undefined : `${(ratio * 100).toFixed(1)}% cache hit`;
}

/** Format the cache hit ratio for the compact widget. */
export function formatCompactCacheHitRatio(stats: CacheHitRatioStats): string | undefined {
  const ratio = calculateCacheHitRatio(stats);
  return ratio === undefined ? undefined : `CH${(ratio * 100).toFixed(1)}%`;
}

/**
 * Calculate average output-token throughput across a task's wall-clock execution window.
 * Returns undefined until both output usage and a positive duration are available.
 */
export function calculateOutputTokenRate(
  stats: OutputTokenRateStats,
  nowMs = Date.now(),
): number | undefined {
  const outputTokens = stats.outputTokens ?? 0;
  const durationMs = stats.durationMs ?? (stats.completedAt ?? nowMs) - stats.startedAt;
  if (
    !Number.isFinite(outputTokens) ||
    outputTokens <= 0 ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0
  ) {
    return undefined;
  }

  const rate = outputTokens / (durationMs / 1000);
  return Number.isFinite(rate) && rate > 0 ? rate : undefined;
}

/** Format average output-token throughput with one decimal place. */
export function formatOutputTokenRate(
  stats: OutputTokenRateStats,
  nowMs = Date.now(),
): string | undefined {
  const rate = calculateOutputTokenRate(stats, nowMs);
  return rate === undefined ? undefined : `${rate.toFixed(1)} tok/s`;
}

/** Format output-token throughput for the compact widget. */
export function formatCompactOutputTokenRate(
  stats: OutputTokenRateStats,
  nowMs = Date.now(),
): string | undefined {
  const rate = calculateOutputTokenRate(stats, nowMs);
  return rate === undefined ? undefined : `${rate.toFixed(1)} t/s`;
}
