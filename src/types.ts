/**
 * types.ts — Type definitions for the task management system.
 */

export type TaskStatus = "pending" | "in_progress" | "completed";

/** Stored counters are task-local; inclusive reports are derived, never stored here. */
export interface TaskExecutionStats {
  /** New counters allocate shared work once; absent on legacy, potentially overlapping records. */
  usageAttribution?: "exclusive";
  /** Report-only warning when multiple legacy usage records contribute to a rollup. */
  legacyUsageOverlap?: boolean;
  startedAt: number;
  completedAt?: number;
  /** Wall-clock duration from task start to completion. */
  durationMs?: number;
  /** Allocated active agent time, excluding user waits and time attributed to other tasks. */
  activeDurationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Allocated provider-reported total, including cache-read and cache-write tokens. */
  totalTokens?: number;
  costUsd?: number;
}

export type CompletedTaskExecutionStats = TaskExecutionStats & {
  completedAt: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
};

export function isTaskExecutionStats(value: unknown): value is TaskExecutionStats {
  if (!value || typeof value !== "object") return false;
  const stats = value as Record<string, unknown>;
  if (stats.usageAttribution !== undefined && stats.usageAttribution !== "exclusive") return false;
  if (stats.legacyUsageOverlap !== undefined && typeof stats.legacyUsageOverlap !== "boolean") return false;
  if (typeof stats.startedAt !== "number" || !Number.isFinite(stats.startedAt)) return false;
  for (const key of [
    "completedAt",
    "durationMs",
    "activeDurationMs",
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "totalTokens",
    "costUsd",
  ] as const) {
    if (stats[key] !== undefined && (typeof stats[key] !== "number" || !Number.isFinite(stats[key]))) {
      return false;
    }
  }
  return true;
}

export function isCompletedTaskExecutionStats(value: unknown): value is CompletedTaskExecutionStats {
  if (!isTaskExecutionStats(value)) return false;
  const stats = value as TaskExecutionStats;
  return [stats.completedAt, stats.durationMs, stats.inputTokens, stats.outputTokens]
    .every((part) => typeof part === "number" && Number.isFinite(part));
}

export interface Task {
  id: string;
  /** Parent task for prompt-scoped subtasks (for example, #13 for #13.1). */
  parentTaskId?: string;
  subject: string;
  description: string;
  status: TaskStatus;
  activeForm?: string;
  owner?: string;
  metadata: Record<string, any> & { executionStats?: TaskExecutionStats };
  blocks: string[];
  blockedBy: string[];
  createdAt: number;
  updatedAt: number;
}

/** Minimal records retained after automatic cleanup, without restoring task rows or usage. */
export type CompletedTaskRecord = Pick<Task, "id" | "parentTaskId">;
export type TaskProgress = Pick<Task, "id" | "parentTaskId" | "status" | "blockedBy">;

/** Serialized store format on disk. */
export interface TaskStoreData {
  nextId: number;
  /** Next direct-child ordinal per parent. Optional for legacy store files. */
  nextSubtaskIds?: Record<string, number>;
  completedTaskHistory?: CompletedTaskRecord[];
  /** Prevent replaying legacy history after an explicit clear or deletion. */
  historyInitialized?: boolean;
  tasks: Task[];
}

/** Background process associated with a task. */
export interface BackgroundProcess {
  taskId: string;
  pid: number;
  command?: string;
  output: string[];
  status: "running" | "completed" | "error" | "stopped";
  exitCode?: number;
  startedAt: number;
  completedAt?: number;
  proc: import("node:child_process").ChildProcess;
  abortController: AbortController;
  waiters: Array<() => void>;
}
