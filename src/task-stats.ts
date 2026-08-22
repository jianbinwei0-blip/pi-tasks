import type { TaskExecutionStats } from "./types.js";

export type OutputTokenRateStats = Pick<
  TaskExecutionStats,
  "startedAt" | "completedAt" | "durationMs" | "outputTokens"
>;

export type TotalTokenStats = Pick<
  TaskExecutionStats,
  "inputTokens" | "outputTokens" | "totalTokens"
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
 * Legacy task records fall back to their persisted input + output counts.
 */
export function calculateTotalTokens(stats: TotalTokenStats): number | undefined {
  const reportedTotal = stats.totalTokens;
  if (reportedTotal !== undefined && Number.isFinite(reportedTotal) && reportedTotal > 0) {
    return reportedTotal;
  }

  const inputTokens = stats.inputTokens ?? 0;
  const outputTokens = stats.outputTokens ?? 0;
  if (
    !Number.isFinite(inputTokens) ||
    inputTokens < 0 ||
    !Number.isFinite(outputTokens) ||
    outputTokens < 0
  ) {
    return undefined;
  }

  const fallbackTotal = inputTokens + outputTokens;
  return fallbackTotal > 0 ? fallbackTotal : undefined;
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
