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
  calculateTotalTokens,
  formatCompactCacheHitRatio,
  formatCompactOutputTokenRate,
  formatCompactTotalTokens,
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
  startedAt: number;
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

/** Format token count with k suffix (e.g., "4.1k", "850"). */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
}

/** Format model cost in USD with useful precision for small per-task amounts. */
function formatCostUsd(costUsd: number): string {
  if (!Number.isFinite(costUsd) || costUsd === 0) return "$0";
  const abs = Math.abs(costUsd);
  if (abs < 0.01) return `$${costUsd.toFixed(4)}`;
  if (abs < 1) return `$${costUsd.toFixed(3)}`;
  return `$${costUsd.toFixed(2)}`;
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
  if ((stats.inputTokens ?? 0) > 0) tokenParts.push(`↑${formatTokens(stats.inputTokens ?? 0)}`);
  if ((stats.outputTokens ?? 0) > 0) tokenParts.push(`↓${formatTokens(stats.outputTokens ?? 0)}`);
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

  return ` ${theme.fg("dim", `(${statGroups.join(" · ")})`)}`;
}

// ---- Widget ----

export class TaskWidget {
  private uiCtx: UICtx | undefined;
  private widgetFrame = 0;
  private widgetInterval: ReturnType<typeof setInterval> | undefined;
  /** IDs of tasks currently being actively executed (show spinner). */
  private activeTaskIds = new Set<string>();
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
    this.store = store;
  }

  setUICtx(ctx: UICtx) {
    this.uiCtx = ctx;
  }

  /** Persist the fact that a task started even before it completes. */
  private persistStartMetrics(taskId: string, startedAt: number, existingStats?: TaskExecutionStats) {
    const executionStats: TaskExecutionStats = {
      ...existingStats,
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
        startedAt,
        completedAt,
        durationMs: Math.max(0, completedAt - startedAt),
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
    const startedAt = Math.max(task.createdAt, ...blockerCompletedAt);
    return {
      startedAt,
      completedAt: task.updatedAt,
      durationMs: Math.max(0, task.updatedAt - startedAt),
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
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
        this.metrics.set(task.id, {
          startedAt,
          inputTokens: existingStats?.inputTokens ?? 0,
          outputTokens: existingStats?.outputTokens ?? 0,
          cacheReadTokens: existingStats?.cacheReadTokens ?? 0,
          cacheWriteTokens: existingStats?.cacheWriteTokens ?? 0,
          totalTokens: existingStats ? (calculateTotalTokens(existingStats) ?? 0) : 0,
          costUsd: existingStats?.costUsd ?? 0,
        });
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
        this.activeTaskIds.delete(id);
        this.persistMetrics(id, task);
      }
    }

    for (const task of tasks) {
      if (task.status === "completed" && !isCompletedTaskExecutionStats(task.metadata?.executionStats)) {
        this.store.update(task.id, { metadata: { executionStats: this.inferCompletedStats(task) } });
      }
    }
  }

  /** Add or remove a task from the active spinner set. */
  setActiveTask(taskId: string | undefined, active = true) {
    if (taskId && active) {
      this.activeTaskIds.add(taskId);
      const task = this.store.get(taskId);
      const existingStats = isTaskExecutionStats(task?.metadata?.executionStats)
        ? task.metadata.executionStats
        : undefined;
      if (!this.metrics.has(taskId)) {
        const startedAt = existingStats?.startedAt ?? Date.now();
        this.metrics.set(taskId, {
          startedAt,
          inputTokens: existingStats?.inputTokens ?? 0,
          outputTokens: existingStats?.outputTokens ?? 0,
          cacheReadTokens: existingStats?.cacheReadTokens ?? 0,
          cacheWriteTokens: existingStats?.cacheWriteTokens ?? 0,
          totalTokens: existingStats ? (calculateTotalTokens(existingStats) ?? 0) : 0,
          costUsd: existingStats?.costUsd ?? 0,
        });
        if (!existingStats) {
          this.persistStartMetrics(taskId, startedAt);
        }
      }
      this.ensureTimer();
    } else if (taskId) {
      this.activeTaskIds.delete(taskId);
      const task = this.store.get(taskId);
      this.persistMetrics(taskId, task);
    }
    this.update();
  }

  /** Record token usage and model cost for the currently active task(s). */
  addTokenUsage(
    inputTokens: number,
    outputTokens: number,
    costUsd = 0,
    totalTokens = inputTokens + outputTokens,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
  ) {
    // Distribute to all currently active tasks
    for (const id of this.activeTaskIds) {
      const m = this.metrics.get(id);
      if (m) {
        m.inputTokens += inputTokens;
        m.outputTokens += outputTokens;
        if (Number.isFinite(cacheReadTokens) && cacheReadTokens > 0) {
          m.cacheReadTokens += cacheReadTokens;
        }
        if (Number.isFinite(cacheWriteTokens) && cacheWriteTokens > 0) {
          m.cacheWriteTokens += cacheWriteTokens;
        }
        if (Number.isFinite(totalTokens) && totalTokens > 0) {
          m.totalTokens += totalTokens;
        }
        if (Number.isFinite(costUsd) && costUsd > 0) {
          m.costUsd += costUsd;
        }
      }
    }
  }

  /** Ensure the widget update timer is running. */
  ensureTimer() {
    if (!this.widgetInterval) {
      this.widgetInterval = setInterval(() => this.update(), 150);
    }
  }

  /** Build widget lines from current live state. Called from the render callback. */
  private renderWidget(tui: any, theme: Theme): string[] {
    const sortOrder = this.config.sortOrder ?? "id";
    const tasks = this.store.list(sortOrder);
    const w = tui.terminal.columns;
    const truncate = (line: string) => truncateToWidth(line, w);

    if (tasks.length === 0) return [];

    const completed = tasks.filter(t => t.status === "completed");
    const inProgress = tasks.filter(t => t.status === "in_progress");
    const pending = tasks.filter(t => t.status === "pending");

    const parts: string[] = [];
    if (completed.length > 0) parts.push(`${completed.length} done`);
    if (inProgress.length > 0) parts.push(`${inProgress.length} in progress`);
    if (pending.length > 0) parts.push(`${pending.length} open`);
    const statusText = `${tasks.length} tasks (${parts.join(", ")})`;

    const spinnerChar = SPINNER[this.widgetFrame % SPINNER.length];
    const lines: string[] = [truncate(theme.fg("accent", "●") + " " + theme.fg("accent", statusText))];

    const showAll = this.config.showAll ?? false;
    const limit = this.config.maxVisible ?? DEFAULT_MAX_VISIBLE_TASKS;
    const hiddenAt = this.config.hiddenAt ?? "bottom";
    const visible = showAll ? tasks : selectVisibleTasks(tasks, limit, sortOrder, hiddenAt);

    const hiddenCount = tasks.length - visible.length;
    const overflowLine = hiddenCount > 0
      ? truncate(theme.fg("dim", `    … and ${hiddenCount} more`))
      : undefined;

    if (overflowLine && hiddenAt === "top") {
      lines.push(overflowLine);
    }
    for (let i = 0; i < visible.length; i++) {
      const task = visible[i];
      const isActive = this.activeTaskIds.has(task.id) && task.status === "in_progress";
      const indent = task.parentTaskId ? "    " : "  ";

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
        const stats = formatWidgetStats(theme, this.metrics.get(task.id));
        text = `${indent}${icon} ${theme.fg("dim", "#" + task.id)} ${theme.fg("accent", form + agentLabel + "…")}${stats}`;
      } else if (task.status === "completed") {
        const stats = isCompletedTaskExecutionStats(task.metadata.executionStats)
          ? task.metadata.executionStats
          : undefined;
        const statSuffix = formatWidgetStats(theme, stats);
        text = `${indent}${icon} ${theme.fg("dim", theme.strikethrough("#" + task.id + " " + task.subject))}${statSuffix}`;
      } else {
        const agentSuffix = task.status === "in_progress" && task.metadata?.agentId
          ? theme.fg("dim", ` (agent ${task.metadata.agentId.slice(0, 5)})`)
          : "";
        const stats = task.status === "in_progress"
          ? formatWidgetStats(theme, this.metrics.get(task.id))
          : "";
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
