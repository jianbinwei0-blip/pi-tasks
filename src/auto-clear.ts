/**
 * auto-clear.ts — Auto-clearing of completed rows while retaining progress history.
 *
 * Modes:
 * - "never": completed tasks remain until manually cleared
 * - "on_task_complete": each completed task gets its own REMINDER_INTERVAL countdown, archived individually
 * - "on_list_complete": countdown starts when ALL tasks are completed, cleared as a batch
 * - "oldest": when the list exceeds maxVisible, the oldest completed tasks are cleared first
 *
 * The two countdown modes use the same turn delay (REMINDER_INTERVAL) for consistency.
 */

import type { TaskStore } from "./task-store.js";
import type { Task } from "./types.js";

export type AutoClearMode = "never" | "on_list_complete" | "on_task_complete" | "oldest";

export class AutoClearManager {
  /** Per-task: turn when task was marked completed ("on_task_complete" mode). */
  private completedAtTurn = new Map<string, number>();
  /** Turn when ALL tasks became completed ("on_list_complete" mode). */
  private allCompletedAtTurn: number | null = null;

  constructor(
    private getStore: () => TaskStore,
    private getMode: () => AutoClearMode,
    /** How many turns completed tasks linger in the countdown modes. */
    private clearDelayTurns = 4,
    /** Current widget task limit used by the "oldest" mode. */
    private getMaxVisible: () => number = () => 10,
  ) {}

  /** Record a task completion. Call AFTER cascade logic. */
  trackCompletion(taskId: string, currentTurn: number): void {
    const mode = this.getMode();
    if (mode === "never") return;

    if (mode === "on_task_complete") {
      this.completedAtTurn.set(taskId, currentTurn);
    } else if (mode === "on_list_complete") {
      this.checkAllCompleted(currentTurn);
    } else if (mode === "oldest") {
      this.clearOldestCompletedOverflow();
    }
  }

  /** Apply size-based cleanup after a task-list or maxVisible change. */
  onTaskListChanged(): boolean {
    return this.getMode() === "oldest" && this.clearOldestCompletedOverflow();
  }

  /** Keep descendant counters while an ancestor's inclusive report is still retained. */
  private hasRetainedAncestor(task: Task, clearing: ReadonlySet<string>): boolean {
    const store = this.getStore();
    const visited = new Set<string>([task.id]);
    let parentId = task.parentTaskId;
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = store.get(parentId);
      if (!parent) return false;
      if (!clearing.has(parent.id)) return true;
      parentId = parent.parentTaskId;
    }
    return false;
  }

  /** Remove ancestors before descendants so a retained parent's totals never shrink. */
  private clearCandidates(candidates: Task[], limit = candidates.length): boolean {
    const clearing = new Set<string>();
    let previousSize = -1;
    while (clearing.size < limit && previousSize !== clearing.size) {
      previousSize = clearing.size;
      for (const task of candidates) {
        if (clearing.size >= limit) break;
        if (!clearing.has(task.id) && !this.hasRetainedAncestor(task, clearing)) clearing.add(task.id);
      }
    }
    const archived = this.getStore().archiveCompleted([...clearing]);
    for (const id of clearing) this.completedAtTurn.delete(id);
    return archived > 0;
  }

  /** Clear eligible oldest completed tasks toward the maxVisible target. */
  private clearOldestCompletedOverflow(): boolean {
    const store = this.getStore();
    const tasks = store.list("oldest");
    const configuredLimit = this.getMaxVisible();
    const maxVisible = Number.isFinite(configuredLimit)
      ? Math.max(0, Math.floor(configuredLimit))
      : 10;
    const overflowCount = tasks.length - maxVisible;
    if (overflowCount <= 0) return false;

    return this.clearCandidates(tasks.filter(task => task.status === "completed"), overflowCount);
  }

  /** Check if all tasks are completed and start/reset the batch countdown. */
  private checkAllCompleted(currentTurn: number): void {
    const tasks = this.getStore().list();
    if (tasks.length > 0 && tasks.every(t => t.status === "completed")) {
      if (this.allCompletedAtTurn === null) this.allCompletedAtTurn = currentTurn;
    } else {
      this.allCompletedAtTurn = null;
    }
  }

  /** Reset batch countdown (e.g., when a new task is created or task goes non-completed). */
  resetBatchCountdown(): void {
    this.allCompletedAtTurn = null;
  }

  /** Reset all tracking state (e.g., on new session). */
  reset(): void {
    this.completedAtTurn.clear();
    this.allCompletedAtTurn = null;
  }

  /**
   * Called on each turn start. Archives tasks whose linger period has expired.
   * Returns true if any tasks were cleared.
   */
  onTurnStart(currentTurn: number): boolean {
    const mode = this.getMode();
    let cleared = false;

    if (mode === "oldest") {
      return this.clearOldestCompletedOverflow();
    }

    if (mode === "on_task_complete") {
      const candidates: Task[] = [];
      for (const [taskId, turn] of this.completedAtTurn) {
        const task = this.getStore().get(taskId);
        if (!task || task.status !== "completed") {
          // Task was deleted or reverted — drop stale tracking entry
          this.completedAtTurn.delete(taskId);
        } else if (currentTurn - turn >= this.clearDelayTurns) {
          candidates.push(task);
        }
      }
      cleared = this.clearCandidates(candidates);
    } else if (mode === "on_list_complete" && this.allCompletedAtTurn !== null) {
      if (currentTurn - this.allCompletedAtTurn >= this.clearDelayTurns) {
        this.getStore().archiveCompleted();
        this.allCompletedAtTurn = null;
        cleared = true;
      }
    }

    return cleared;
  }
}
