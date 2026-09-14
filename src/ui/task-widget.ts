/**
 * task-widget.ts — Persistent widget showing task list with status icons and progress.
 *
 * Display style matches Claude Code's task list:
 *   ✔ completed tasks (strikethrough + dim)
 *   ◼ in_progress tasks
 *   ◻ pending tasks
 *   ✳/✽ actively executing task (star spinner with activeForm text)
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import {
  aggregateTaskExecutionStats,
  calculateTotalTokens,
  foregroundTaskIds,
  formatCompactCacheHitRatio,
  formatCompactOutputTokenRate,
  formatCompactTotalTokens,
  formatCostUsd,
  formatTokenCount,
  hasLegacyTaskUsage,
} from "../task-stats.js";
import type { TaskStore } from "../task-store.js";
import type { TasksConfig } from "../tasks-config.js";
import {
  type CompletedTaskExecutionStats,
  isCompletedTaskExecutionStats,
  isTaskExecutionStats,
  type Task,
  type TaskExecutionStats,
} from "../types.js";

// ---- Truncation ----

function truncateFromTop(tasks: Task[], limit: number): Task[] {
  return tasks.slice(-limit);
}

function truncateFromBottom(tasks: Task[], limit: number): Task[] {
  return tasks.slice(0, limit);
}

const TRUNCATE_FNS = { top: truncateFromTop, bottom: truncateFromBottom };

function selectVisibleTasks(
  tasks: Task[],
  limit: number,
  sortOrder: "id" | "status" | "recent" | "oldest",
  hiddenAt: "top" | "bottom",
): Task[] {
  if (sortOrder === "status" && hiddenAt === "top") {
    const unfinished = tasks.filter(task => task.status !== "completed");
    const completed = tasks.filter(task => task.status === "completed");
    const completedSlots = Math.max(0, limit - unfinished.length);
    const firstVisibleCompleted = Math.max(0, completed.length - completedSlots);
    return [...completed.slice(firstVisibleCompleted), ...unfinished];
  }

  return TRUNCATE_FNS[hiddenAt](tasks, limit);
}

interface TaskRow {
  task: Task;
  depth: number;
}

/** Keep selected rows with their ancestors, preserving the configured order among siblings. */
function groupVisibleTasks(tasks: Task[], selected: Task[]): TaskRow[] {
  const tasksById = new Map(tasks.map(task => [task.id, task]));
  const visibleIds = new Set<string>();
  for (const task of selected) {
    let current: Task | undefined = task;
    while (current && !visibleIds.has(current.id)) {
      visibleIds.add(current.id);
      current = current.parentTaskId ? tasksById.get(current.parentTaskId) : undefined;
    }
  }

  const roots: Task[] = [];
  const children = new Map<string, Task[]>();
  for (const task of tasks) {
    if (!visibleIds.has(task.id)) continue;
    if (task.parentTaskId && visibleIds.has(task.parentTaskId)) {
      const siblings = children.get(task.parentTaskId) ?? [];
      siblings.push(task);
      children.set(task.parentTaskId, siblings);
    } else {
      // Deleted/missing parents must not hide a branch or nest it under another root.
      roots.push(task);
    }
  }

  const rows: TaskRow[] = [];
  const visited = new Set<string>();
  const appendBranch = (root: Task) => {
    const stack: TaskRow[] = [{ task: root, depth: 0 }];
    while (stack.length > 0) {
      const row = stack.pop()!;
      if (visited.has(row.task.id)) continue;
      visited.add(row.task.id);
      rows.push(row);
      const descendants = children.get(row.task.id) ?? [];
      for (let i = descendants.length - 1; i >= 0; i--) {
        stack.push({ task: descendants[i], depth: row.depth + 1 });
      }
    }
  };
  for (const root of roots) appendBranch(root);
  // Malformed parent cycles have no root. Render each remaining task once, without looping.
  for (const task of tasks) {
    if (visibleIds.has(task.id) && !visited.has(task.id)) appendBranch(task);
  }
  return rows;
}

// ---- Types ----

export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
  strikethrough(text: string): string;
};

export type UICtx = {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
};

/** Star spinner frames for animated active task indicator (matches Claude Code). */
const SPINNER = ["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽"];

const DEFAULT_MAX_VISIBLE_TASKS = 10;

/** Per-task runtime metrics (elapsed time, token usage/rate, and model cost). */
export interface TaskMetrics {
  usageAttribution?: "exclusive";
  startedAt: number;
  activeDurationMs: number;
  activeStartedAt?: number;
  /** Share of foreground agent time allocated to this task (background agents use 1). */
  activityShare: number;
  continuousActivity: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Format milliseconds as compact stopwatch time (e.g., "2:49", "1:02:03"). */
function formatCompactDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}:${pad2(sec)}`;
  return `${Math.floor(totalMin / 60)}:${pad2(totalMin % 60)}:${pad2(sec)}`;
}

/** Format local clock time in stable 24-hour notation with second precision. */
function formatClockTime(ms: number): string {
  const date = new Date(ms);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function formatWidgetStats(
  theme: Theme,
  stats: TaskExecutionStats | undefined,
  now = Date.now(),
): string {
  if (!stats) return "";

  const durationMs = stats.durationMs ?? (stats.completedAt ?? now) - stats.startedAt;
  const timeline = stats.completedAt === undefined
    ? `${formatClockTime(stats.startedAt)} Δ${formatCompactDuration(durationMs)}`
    : `${formatClockTime(stats.startedAt)} → ${formatClockTime(stats.completedAt)} Δ${formatCompactDuration(durationMs)}`;

  const tokenParts: string[] = [];
  if ((stats.inputTokens ?? 0) > 0) tokenParts.push(`↑${formatTokenCount(stats.inputTokens ?? 0)}`);
  if ((stats.outputTokens ?? 0) > 0) tokenParts.push(`↓${formatTokenCount(stats.outputTokens ?? 0)}`);
  const totalTokens = formatCompactTotalTokens(stats);
  if (totalTokens) tokenParts.push(totalTokens);
  const cacheHitRatio = formatCompactCacheHitRatio(stats);
  if (cacheHitRatio) tokenParts.push(cacheHitRatio);

  const statGroups = [timeline];
  if (tokenParts.length > 0) statGroups.push(tokenParts.join(" "));
  const tokenRate = formatCompactOutputTokenRate(stats, now);
  if (tokenRate) statGroups.push(tokenRate);
  if (stats.costUsd !== undefined && (stats.completedAt !== undefined || stats.costUsd > 0)) {
    statGroups.push(formatCostUsd(stats.costUsd));
  }

  if (stats.legacyUsageOverlap) statGroups.push("legacy overlap possible");
  return ` ${theme.fg("dim", `(${statGroups.join(" · ")})`)}`;
}

// ---- Summary ----

function hasOpenBlocker(task: Task, tasksById: Map<string, Task>): boolean {
  return task.status === "pending" && task.blockedBy.some(blockerId => {
    const blocker = tasksById.get(blockerId);
    return blocker !== undefined && blocker.status !== "completed";
  });
}

function formatStatusParts(
  tasks: Task[],
  tasksById: Map<string, Task>,
  inProgressLabel: "active" | "running",
): string[] {
  let done = 0;
  let inProgress = 0;
  let ready = 0;
  let blocked = 0;

  for (const task of tasks) {
    if (task.status === "completed") {
      done++;
    } else if (task.status === "in_progress") {
      inProgress++;
    } else if (hasOpenBlocker(task, tasksById)) {
      blocked++;
    } else {
      ready++;
    }
  }

  const parts: string[] = [];
  if (done > 0) parts.push(`${done} done`);
  if (inProgress > 0) parts.push(`${inProgress} ${inProgressLabel}`);
  if (ready > 0) parts.push(`${ready} ready`);
  if (blocked > 0) parts.push(`${blocked} blocked`);
  return parts;
}

function formatTaskSummary(tasks: Task[]): string {
  const tasksById = new Map(tasks.map(task => [task.id, task]));
  const topLevelTasks = tasks.filter(task => !task.parentTaskId);
  const subtasks = tasks.filter(task => task.parentTaskId);
  const topLevelParts = formatStatusParts(topLevelTasks, tasksById, "active");

  const topLevelSummary = topLevelParts.length === 1
    ? `${topLevelParts[0]} ${topLevelTasks.length === 1 ? "task" : "tasks"}`
    : `${topLevelTasks.length} tasks (${topLevelParts.join(", ")})`;

  if (subtasks.length === 0) return topLevelSummary;

  const subtaskParts = formatStatusParts(subtasks, tasksById, "running");
  const subtaskSummary = `${subtasks.length} ${subtasks.length === 1 ? "subtask" : "subtasks"} (${subtaskParts.join(", ")})`;
  return `${topLevelSummary} · ${subtaskSummary}`;
}

// ---- Widget ----

export class TaskWidget {
  private uiCtx: UICtx | undefined;
  private widgetFrame = 0;
  private widgetInterval: ReturnType<typeof setInterval> | undefined;
  /** IDs of tasks currently being actively executed (show spinner). */
  private activeTaskIds = new Set<string>();
  /** Whether the foreground Pi agent is currently inside an agent run. */
  private agentActive = false;
  /** Per-task runtime metrics keyed by task ID. */
  private metrics = new Map<string, TaskMetrics>();
  /** Cached TUI instance for requestRender() calls. */
  private tui: any | undefined;
  /** Whether the widget callback is currently registered. */
  private widgetRegistered = false;

  constructor(
    private store: TaskStore,
    private config: TasksConfig = {},
  ) {}

  setStore(store: TaskStore) {
    const now = Date.now();
    for (const [id, metrics] of this.metrics) {
      this.pauseMetricsActivity(metrics, now);
      this.persistMetrics(id, this.store.get(id));
    }
    this.activeTaskIds.clear();
    this.store = store;
  }

  setUICtx(ctx: UICtx) {
    this.uiCtx = ctx;
  }

  private initialActiveDurationMs(existingStats: TaskExecutionStats | undefined, now: number): number {
    if (existingStats?.activeDurationMs !== undefined) {
      return Math.max(0, existingStats.activeDurationMs);
    }
    if (existingStats?.durationMs !== undefined) {
      return Math.max(0, existingStats.durationMs);
    }
    if ((existingStats?.outputTokens ?? 0) > 0) {
      return Math.max(0, (existingStats?.completedAt ?? now) - (existingStats?.startedAt ?? now));
    }
    return 0;
  }

  private createMetrics(
    task: Task,
    startedAt: number,
    existingStats?: TaskExecutionStats,
    now = Date.now(),
  ): TaskMetrics {
    const metrics: TaskMetrics = {
      usageAttribution: hasLegacyTaskUsage(existingStats) ? undefined : "exclusive",
      startedAt,
      activeDurationMs: this.initialActiveDurationMs(existingStats, now),
      activityShare: 0,
      continuousActivity: Boolean(task.metadata?.agentId),
      inputTokens: existingStats?.inputTokens ?? 0,
      outputTokens: existingStats?.outputTokens ?? 0,
      cacheReadTokens: existingStats?.cacheReadTokens ?? 0,
      cacheWriteTokens: existingStats?.cacheWriteTokens ?? 0,
      totalTokens: existingStats ? (calculateTotalTokens(existingStats) ?? 0) : 0,
      costUsd: existingStats?.costUsd ?? 0,
    };
    return metrics;
  }

  private resumeMetricsActivity(metrics: TaskMetrics, now = Date.now()) {
    if (metrics.activeStartedAt === undefined) metrics.activeStartedAt = now;
  }

  private pauseMetricsActivity(metrics: TaskMetrics, now = Date.now()) {
    if (metrics.activeStartedAt === undefined) return;
    metrics.activeDurationMs += Math.max(0, now - metrics.activeStartedAt) * metrics.activityShare;
    metrics.activeStartedAt = undefined;
  }

  private currentActiveDurationMs(metrics: TaskMetrics, now = Date.now()): number {
    const currentInterval = metrics.activeStartedAt === undefined
      ? 0
      : Math.max(0, now - metrics.activeStartedAt) * metrics.activityShare;
    return metrics.activeDurationMs + currentInterval;
  }

  private snapshotMetrics(metrics: TaskMetrics, now = Date.now()): TaskExecutionStats {
    return {
      ...(metrics.usageAttribution ? { usageAttribution: metrics.usageAttribution } : {}),
      startedAt: metrics.startedAt,
      activeDurationMs: this.currentActiveDurationMs(metrics, now),
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      cacheReadTokens: metrics.cacheReadTokens,
      cacheWriteTokens: metrics.cacheWriteTokens,
      totalTokens: metrics.totalTokens,
      costUsd: metrics.costUsd,
    };
  }

  private persistUnfinishedMetrics(taskId: string, task?: Task) {
    const metrics = this.metrics.get(taskId);
    if (!metrics || !task || task.status === "completed") return;

    const existingStats = isTaskExecutionStats(task.metadata?.executionStats)
      ? task.metadata.executionStats
      : undefined;
    const executionStats: TaskExecutionStats = {
      ...existingStats,
      ...this.snapshotMetrics(metrics),
    };
    delete executionStats.completedAt;
    delete executionStats.durationMs;
    if (metrics.costUsd === 0 && existingStats?.costUsd === undefined) {
      delete executionStats.costUsd;
    }
    this.store.update(taskId, { metadata: { executionStats } });
  }

  /** Reassign active time with the same ownership rule as foreground token usage. */
  private syncMetricsActivity(tasks = this.store.list(), now = Date.now()) {
    const foreground = new Set(foregroundTaskIds(tasks, this.activeTaskIds));
    for (const task of tasks) {
      const metrics = this.metrics.get(task.id);
      if (!metrics) continue;
      metrics.continuousActivity = Boolean(task.metadata.agentId);
      const active = task.status === "in_progress" && this.activeTaskIds.has(task.id);
      const share = !active ? 0 : metrics.continuousActivity ? 1
        : this.agentActive && foreground.has(task.id) ? 1 / foreground.size : 0;
      if (metrics.activityShare === share) continue;
      this.pauseMetricsActivity(metrics, now);
      metrics.activityShare = share;
      if (share > 0) this.resumeMetricsActivity(metrics, now);
    }
  }

  /** Mark foreground agent activity so idle waits do not dilute token throughput. */
  setAgentActive(active: boolean) {
    if (this.agentActive === active) return;
    this.agentActive = active;
    this.syncMetricsActivity();
    if (!active) {
      for (const taskId of this.activeTaskIds) {
        this.persistUnfinishedMetrics(taskId, this.store.get(taskId));
      }
    }
    this.update();
  }

  /** Persist the fact that a task started even before it completes. */
  private persistStartMetrics(taskId: string, startedAt: number, existingStats?: TaskExecutionStats) {
    const executionStats: TaskExecutionStats = {
      ...existingStats,
      ...(!hasLegacyTaskUsage(existingStats) ? { usageAttribution: "exclusive" as const } : {}),
      startedAt,
      inputTokens: existingStats?.inputTokens ?? 0,
      outputTokens: existingStats?.outputTokens ?? 0,
      cacheReadTokens: existingStats?.cacheReadTokens ?? 0,
      cacheWriteTokens: existingStats?.cacheWriteTokens ?? 0,
      totalTokens: existingStats ? (calculateTotalTokens(existingStats) ?? 0) : 0,
    };
    if (existingStats?.costUsd !== undefined) {
      executionStats.costUsd = existingStats.costUsd;
    }

    this.store.update(taskId, {
      metadata: { executionStats },
    });
  }

  /** Infer a reasonable execution window for completed tasks that missed live tracking. */
  private inferCompletedStats(task: Task, metrics?: TaskMetrics): CompletedTaskExecutionStats {
    const existingStats = isTaskExecutionStats(task.metadata?.executionStats)
      ? task.metadata.executionStats
      : undefined;
    if (metrics) {
      const startedAt = existingStats?.startedAt ?? metrics.startedAt;
      const completedAt = existingStats?.completedAt ?? task.updatedAt;
      const stats: CompletedTaskExecutionStats = {
        ...(metrics.usageAttribution ? { usageAttribution: metrics.usageAttribution } : {}),
        startedAt,
        completedAt,
        durationMs: Math.max(0, completedAt - startedAt),
        activeDurationMs: this.currentActiveDurationMs(metrics, completedAt),
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        cacheReadTokens: metrics.cacheReadTokens,
        cacheWriteTokens: metrics.cacheWriteTokens,
        totalTokens: metrics.totalTokens,
      };
      const costUsd = metrics.costUsd > 0 ? metrics.costUsd : existingStats?.costUsd;
      if (costUsd !== undefined) stats.costUsd = costUsd;
      return stats;
    }
    if (isCompletedTaskExecutionStats(existingStats)) return existingStats;

    const blockerCompletedAt = task.blockedBy
      .map((id) => this.store.get(id))
      .flatMap((blocker) => {
        if (!blocker || blocker.status !== "completed") return [];
        const blockerStats = isTaskExecutionStats(blocker.metadata?.executionStats)
          ? blocker.metadata.executionStats
          : undefined;
        return [blockerStats?.completedAt ?? blocker.updatedAt];
      });
    const startedAt = existingStats?.startedAt ?? Math.max(task.createdAt, ...blockerCompletedAt);
    const completedAt = existingStats?.completedAt ?? task.updatedAt;
    return {
      ...existingStats,
      ...(!hasLegacyTaskUsage(existingStats) ? { usageAttribution: "exclusive" as const } : {}),
      startedAt,
      completedAt,
      durationMs: Math.max(0, completedAt - startedAt),
      activeDurationMs: this.initialActiveDurationMs(existingStats, completedAt),
      inputTokens: existingStats?.inputTokens ?? 0,
      outputTokens: existingStats?.outputTokens ?? 0,
      cacheReadTokens: existingStats?.cacheReadTokens ?? 0,
      cacheWriteTokens: existingStats?.cacheWriteTokens ?? 0,
      totalTokens: existingStats ? (calculateTotalTokens(existingStats) ?? 0) : 0,
    };
  }

  /** Persist live metrics into task metadata when execution completes. */
  private persistMetrics(taskId: string, task?: Task) {
    const m = this.metrics.get(taskId);
    const existingStats = isTaskExecutionStats(task?.metadata?.executionStats)
      ? task.metadata.executionStats
      : undefined;

    if (task?.status === "completed" && (!isCompletedTaskExecutionStats(existingStats) || m)) {
      this.store.update(taskId, { metadata: { executionStats: this.inferCompletedStats(task, m) } });
    } else {
      this.persistUnfinishedMetrics(taskId, task);
    }

    if (m) {
      this.metrics.delete(taskId);
    }
  }

  /** Rebuild timing baselines for persisted in-progress tasks after startup/resume. */
  private syncTrackedTasks(tasks = this.store.list()) {
    for (const task of tasks) {
      if (task.status === "in_progress" && !this.metrics.has(task.id)) {
        const existingStats = isTaskExecutionStats(task.metadata?.executionStats)
          ? task.metadata.executionStats
          : undefined;
        const startedAt = existingStats?.startedAt ?? task.updatedAt;
        this.metrics.set(task.id, this.createMetrics(task, startedAt, existingStats));
        if (!existingStats) {
          this.persistStartMetrics(task.id, startedAt);
        }
      }
    }

    for (const [id] of this.metrics) {
      const task = tasks.find(t => t.id === id) ?? this.store.get(id);
      if (!task) {
        this.activeTaskIds.delete(id);
        this.metrics.delete(id);
        continue;
      }
      if (task.status !== "in_progress") {
        const metrics = this.metrics.get(id);
        if (metrics) this.pauseMetricsActivity(metrics, task.updatedAt);
        this.activeTaskIds.delete(id);
        this.persistMetrics(id, task);
      }
    }

    for (const task of tasks) {
      if (task.status === "completed" && !isCompletedTaskExecutionStats(task.metadata?.executionStats)) {
        this.store.update(task.id, { metadata: { executionStats: this.inferCompletedStats(task) } });
      }
    }
    this.syncMetricsActivity(tasks);
  }

  /** Add or remove a task from the active spinner set. */
  setActiveTask(taskId: string | undefined, active = true) {
    if (taskId && active) {
      this.activeTaskIds.add(taskId);
      const task = this.store.get(taskId);
      if (!task) {
        this.activeTaskIds.delete(taskId);
        return;
      }
      const existingStats = isTaskExecutionStats(task.metadata?.executionStats)
        ? task.metadata.executionStats
        : undefined;
      let metrics = this.metrics.get(taskId);
      if (!metrics) {
        const startedAt = existingStats?.startedAt ?? Date.now();
        metrics = this.createMetrics(task, startedAt, existingStats);
        this.metrics.set(taskId, metrics);
        if (!existingStats) {
          this.persistStartMetrics(taskId, startedAt);
        }
      }
      this.ensureTimer();
    } else if (taskId) {
      const task = this.store.get(taskId);
      const metrics = this.metrics.get(taskId);
      if (metrics) {
        const stoppedAt = task?.status === "completed" ? task.updatedAt : Date.now();
        this.pauseMetricsActivity(metrics, stoppedAt);
      }
      this.activeTaskIds.delete(taskId);
      this.persistMetrics(taskId, task);
    }
    this.syncMetricsActivity();
    this.update();
  }

  /** Allocate one foreground turn across active leaves, counting every token once. */
  addTokenUsage(
    inputTokens: number,
    outputTokens: number,
    costUsd = 0,
    totalTokens = inputTokens + outputTokens,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
  ) {
    const ids = foregroundTaskIds(this.store.list(), this.activeTaskIds).filter(id => this.metrics.has(id));
    for (const [index, id] of ids.entries()) {
      // Keep integer token counts and distribute remainders deterministically.
      const share = (tokens: number) => {
        if (!Number.isFinite(tokens) || tokens <= 0) return 0;
        return Math.floor(tokens / ids.length) + (index < tokens % ids.length ? 1 : 0);
      };
      const m = this.metrics.get(id)!;
      m.inputTokens += share(inputTokens);
      m.outputTokens += share(outputTokens);
      m.cacheReadTokens += share(cacheReadTokens);
      m.cacheWriteTokens += share(cacheWriteTokens);
      m.totalTokens += share(totalTokens);
      if (Number.isFinite(costUsd) && costUsd > 0) m.costUsd += costUsd / ids.length;
    }
  }

  /** Ensure the widget update timer is running. */
  ensureTimer() {
    if (!this.widgetInterval) {
      this.widgetInterval = setInterval(() => this.update(), 150);
    }
  }

  /** Honor explicit metadata replacement instead of shadowing it with an older live snapshot. */
  refreshExecutionStats(taskId: string) {
    this.metrics.delete(taskId);
    const task = this.store.get(taskId);
    if (task?.status === "in_progress") {
      const stats = isTaskExecutionStats(task.metadata.executionStats) ? task.metadata.executionStats : undefined;
      this.metrics.set(taskId, this.createMetrics(task, stats?.startedAt ?? Date.now(), stats));
    }
    this.syncMetricsActivity();
  }

  /** Shared live/persisted report for the widget, task tools, and task picker. */
  getExecutionStats(tasks = this.store.list(), now = Date.now()): Map<string, TaskExecutionStats> {
    return aggregateTaskExecutionStats(tasks, task => {
      const metrics = task.status === "in_progress" ? this.metrics.get(task.id) : undefined;
      if (metrics) {
        const stats = this.snapshotMetrics(metrics, now);
        if (metrics.costUsd === 0 && task.metadata.executionStats?.costUsd === undefined) delete stats.costUsd;
        return stats;
      }
      return isTaskExecutionStats(task.metadata.executionStats) ? task.metadata.executionStats : undefined;
    }, now);
  }

  /** Build widget lines from current live state. Called from the render callback. */
  private renderWidget(tui: any, theme: Theme): string[] {
    const sortOrder = this.config.sortOrder ?? "id";
    const tasks = this.store.list(sortOrder);
    const w = tui.terminal.columns;
    const truncate = (line: string) => truncateToWidth(line, w);

    if (tasks.length === 0) return [];

    // Totals always use the full store, before display selection or parent grouping.
    const statusText = formatTaskSummary(tasks);
    const now = Date.now();
    const executionStats = this.getExecutionStats(tasks, now);

    const spinnerChar = SPINNER[this.widgetFrame % SPINNER.length];
    const lines: string[] = [truncate(theme.fg("accent", "●") + " " + theme.fg("accent", statusText))];

    const showAll = this.config.showAll ?? false;
    const limit = this.config.maxVisible ?? DEFAULT_MAX_VISIBLE_TASKS;
    const hiddenAt = this.config.hiddenAt ?? "bottom";
    const selected = showAll ? tasks : selectVisibleTasks(tasks, limit, sortOrder, hiddenAt);
    const visible = groupVisibleTasks(tasks, selected);

    const hiddenCount = tasks.length - visible.length;
    const overflowLine = hiddenCount > 0
      ? truncate(theme.fg("dim", `    … and ${hiddenCount} more`))
      : undefined;

    if (overflowLine && hiddenAt === "top") {
      lines.push(overflowLine);
    }
    for (const { task, depth } of visible) {
      const isActive = this.activeTaskIds.has(task.id) && task.status === "in_progress";
      const indent = "  ".repeat(depth + 1);

      let icon: string;
      if (isActive) {
        icon = theme.fg("accent", spinnerChar);
      } else if (task.status === "completed") {
        icon = theme.fg("success", "✔");
      } else if (task.status === "in_progress") {
        icon = theme.fg("accent", "◼");
      } else {
        icon = "◻";
      }

      let suffix = "";
      if (task.status === "pending" && task.blockedBy.length > 0) {
        const openBlockers = task.blockedBy.filter(bid => {
          const blocker = this.store.get(bid);
          return blocker && blocker.status !== "completed";
        });
        if (openBlockers.length > 0) {
          suffix = theme.fg("dim", ` › blocked by ${openBlockers.map(id => "#" + id).join(", ")}`);
        }
      }

      let text: string;
      if (isActive) {
        const form = task.activeForm || task.subject;
        const agentId = task.metadata?.agentId;
        const agentLabel = agentId ? ` (agent ${agentId.slice(0, 5)})` : "";
        const stats = formatWidgetStats(theme, executionStats.get(task.id), now);
        text = `${indent}${icon} ${theme.fg("dim", "#" + task.id)} ${theme.fg("accent", form + agentLabel + "…")}${stats}`;
      } else if (task.status === "completed") {
        const statSuffix = formatWidgetStats(theme, executionStats.get(task.id), now);
        text = `${indent}${icon} ${theme.fg("dim", theme.strikethrough("#" + task.id + " " + task.subject))}${statSuffix}`;
      } else {
        const agentSuffix = task.status === "in_progress" && task.metadata?.agentId
          ? theme.fg("dim", ` (agent ${task.metadata.agentId.slice(0, 5)})`)
          : "";
        const stats = formatWidgetStats(theme, executionStats.get(task.id), now);
        text = `${indent}${icon} ${theme.fg("dim", "#" + task.id)} ${task.subject}${agentSuffix}${stats}`;
      }

      lines.push(truncate(text + suffix));
    }

    if (overflowLine && hiddenAt !== "top") {
      lines.push(overflowLine);
    }

    return lines;
  }

  /** Force an immediate widget update. */
  update() {
    if (!this.uiCtx) return;
    const tasks = this.store.list();
    this.syncTrackedTasks(tasks);

    // Transition: visible → hidden
    if (tasks.length === 0) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget("tasks", undefined);
        this.widgetRegistered = false;
      }
      if (this.widgetInterval) {
        clearInterval(this.widgetInterval);
        this.widgetInterval = undefined;
      }
      return;
    }

    // Check if any task needs animation
    const hasActiveSpinner = tasks.some(t => this.activeTaskIds.has(t.id) && t.status === "in_progress");
    if (hasActiveSpinner) {
      this.ensureTimer();
    } else if (!hasActiveSpinner && this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }

    this.widgetFrame++;

    // Transition: hidden → visible — register widget callback once
    if (!this.widgetRegistered) {
      this.uiCtx.setWidget("tasks", (tui, theme) => {
        this.tui = tui;
        return { render: () => this.renderWidget(tui, theme), invalidate: () => {} };
      }, { placement: "aboveEditor" });
      this.widgetRegistered = true;
    } else if (this.tui) {
      // Widget already registered — just request a re-render
      this.tui.requestRender();
    }
  }

  dispose() {
    if (this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }
    if (this.uiCtx) {
      this.uiCtx.setWidget("tasks", undefined);
    }
    this.widgetRegistered = false;
    this.tui = undefined;
  }
}
