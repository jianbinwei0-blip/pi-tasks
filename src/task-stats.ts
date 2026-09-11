import { isTaskExecutionStats, type Task, type TaskExecutionStats } from "./types.js";

/**
 * Build inclusive reports from task-local counters. Never persist these rollups:
 * each own record contributes once to itself and each reachable ancestor.
 * Dependency edges, display order, and visibility do not affect accounting.
 */
export function aggregateTaskExecutionStats(
  tasks: Task[],
  ownStatsForTask = (task: Task): TaskExecutionStats | undefined => (
    isTaskExecutionStats(task.metadata.executionStats) ? task.metadata.executionStats : undefined
  ),
  nowMs = Date.now(),
): Map<string, TaskExecutionStats> {
  const tasksById = new Map(tasks.map(task => [task.id, task]));
  const ownStats = new Map(tasks.map(task => [task.id, ownStatsForTask(task)]));
  const reports = new Map<string, TaskExecutionStats>();
  const legacyRecords = new Map<string, number>();

  for (const task of tasks) {
    const own = ownStats.get(task.id);
    if (!own) continue;
    const visited = new Set<string>();
    let target: Task | undefined = task;
    while (target && !visited.has(target.id)) {
      visited.add(target.id);
      const targetOwn = ownStats.get(target.id);
      let report = reports.get(target.id);
      if (!report) {
        // Keep the task's wall-clock window; active agent time is additive instead.
        report = { startedAt: targetOwn?.startedAt ?? own.startedAt };
        if (targetOwn?.completedAt !== undefined) report.completedAt = targetOwn.completedAt;
        if (targetOwn?.durationMs !== undefined) report.durationMs = targetOwn.durationMs;
        if (!targetOwn && target.status === "completed") report.completedAt = target.updatedAt;
        reports.set(target.id, report);
      }
      if (!targetOwn) {
        report.startedAt = Math.min(report.startedAt, own.startedAt);
        if (report.completedAt !== undefined) {
          report.durationMs = Math.max(0, report.completedAt - report.startedAt);
        }
      }
      for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"] as const) {
        if (own[key] !== undefined) report[key] = (report[key] ?? 0) + Math.max(0, own[key]);
      }
      if (hasLegacyTaskUsage(own)) {
        const count = (legacyRecords.get(target.id) ?? 0) + 1;
        legacyRecords.set(target.id, count);
        if (count > 1) report.legacyUsageOverlap = true;
      }
      // Resolve legacy fallbacks per record, not after mixing reported and missing totals.
      report.totalTokens = (report.totalTokens ?? 0) + (calculateTotalTokens(own) ?? 0);
      const activeDurationMs = own.activeDurationMs ?? own.durationMs ?? (own.completedAt ?? nowMs) - own.startedAt;
      report.activeDurationMs = (report.activeDurationMs ?? 0) + Math.max(0, activeDurationMs);
      target = target.parentTaskId ? tasksById.get(target.parentTaskId) : undefined;
    }
  }
  return reports;
}

/** Legacy records lack the provenance needed to safely deduplicate shared foreground work. */
export function hasLegacyTaskUsage(stats: TaskExecutionStats | undefined): boolean {
  return stats !== undefined && stats.usageAttribution !== "exclusive"
    && ((calculateTotalTokens(stats) ?? 0) > 0 || (stats.costUsd ?? 0) > 0);
}

/** Foreground work belongs to active leaves, not also to their active ancestors. */
export function foregroundTaskIds(tasks: Task[], activeTaskIds: ReadonlySet<string>): string[] {
  const tasksById = new Map(tasks.map(task => [task.id, task]));
  const candidates = tasks.filter(task => (
    task.status === "in_progress" && activeTaskIds.has(task.id) && !task.metadata.agentId
  ));
  const ancestors = new Set<string>();
  for (const task of candidates) {
    const visited = new Set([task.id]);
    let parentId = task.parentTaskId;
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      ancestors.add(parentId);
      parentId = tasksById.get(parentId)?.parentTaskId;
    }
  }
  return candidates.filter(task => !ancestors.has(task.id)).map(task => task.id);
}

export type OutputTokenRateStats = Pick<
  TaskExecutionStats,
  "startedAt" | "completedAt" | "durationMs" | "activeDurationMs" | "outputTokens"
>;

export type TotalTokenStats = Pick<
  TaskExecutionStats,
  "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "totalTokens"
>;

export type CacheHitRatioStats = Pick<
  TaskExecutionStats,
  "inputTokens" | "cacheReadTokens" | "cacheWriteTokens"
>;

const TOKEN_STAT_DECIMAL_PLACES = 1;

function formatTokenStatDecimal(value: number): string {
  return value.toFixed(TOKEN_STAT_DECIMAL_PLACES);
}

/** Format model cost in USD to cent precision. */
export function formatCostUsd(costUsd: number): string {
  const value = Number.isFinite(costUsd) ? costUsd : 0;
  return `$${value.toFixed(2)}`;
}

/** Format an input, output, or total token count with at most one decimal place. */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  return `${formatTokenStatDecimal(tokens / 1000).replace(/\.0$/, "")}k`;
}

function compactWidgetTotalTokenCount(tokens: number): string {
  if (tokens < 1_000_000) return formatTokenCount(tokens);

  return `${formatTokenStatDecimal(tokens / 1_000_000)}M`;
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
  return totalTokens === undefined ? undefined : `${formatTokenCount(totalTokens)} tok`;
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
  return ratio === undefined ? undefined : `${formatTokenStatDecimal(ratio * 100)}% cache hit`;
}

/** Format the cache hit ratio for the compact widget. */
export function formatCompactCacheHitRatio(stats: CacheHitRatioStats): string | undefined {
  const ratio = calculateCacheHitRatio(stats);
  return ratio === undefined ? undefined : `⨀${formatTokenStatDecimal(ratio * 100)}%`;
}

/**
 * Calculate average output-token throughput across accumulated active agent time.
 * Legacy stats without an active duration fall back to their wall-clock execution window.
 * Returns undefined until both output usage and a positive duration are available.
 */
export function calculateOutputTokenRate(
  stats: OutputTokenRateStats,
  nowMs = Date.now(),
): number | undefined {
  const outputTokens = stats.outputTokens ?? 0;
  const durationMs = stats.activeDurationMs
    ?? stats.durationMs
    ?? (stats.completedAt ?? nowMs) - stats.startedAt;
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
  return rate === undefined ? undefined : `${formatTokenStatDecimal(rate)} tok/s`;
}

/** Format output-token throughput for the compact widget. */
export function formatCompactOutputTokenRate(
  stats: OutputTokenRateStats,
  nowMs = Date.now(),
): string | undefined {
  const rate = calculateOutputTokenRate(stats, nowMs);
  return rate === undefined ? undefined : `${formatTokenStatDecimal(rate)} t/s`;
}
