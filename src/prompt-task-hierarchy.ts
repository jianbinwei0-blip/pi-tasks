import type { TaskStatus } from "./types.js";

/**
 * Tracks the prompt-level task while taskCreationMode=always is active.
 *
 * The first task created for a prompt becomes its parent. If the model reuses
 * an existing task instead, moving that task to in_progress establishes it as
 * the parent. Later TaskCreate calls in the same prompt become its subtasks.
 */
export class PromptTaskHierarchy {
  private enabled = false;
  private promptTaskId: string | undefined;

  /** Start a new prompt and discard any parent selected for the prior prompt. */
  startPrompt(enabled: boolean): void {
    this.enabled = enabled;
    this.promptTaskId = undefined;
  }

  /** Clear all prompt-scoped state, for example during a session switch. */
  reset(): void {
    this.startPrompt(false);
  }

  /** Return the parent for the next TaskCreate, dropping stale parent IDs. */
  parentForNextTask(taskExists: (taskId: string) => boolean): string | undefined {
    if (!this.enabled || !this.promptTaskId) return undefined;
    if (!taskExists(this.promptTaskId)) {
      this.promptTaskId = undefined;
      return undefined;
    }
    return this.promptTaskId;
  }

  /** Capture the first task created for the active prompt as its parent. */
  captureCreatedTask(taskId: string): void {
    if (this.enabled && !this.promptTaskId) this.promptTaskId = taskId;
  }

  /** Capture an existing task reused as the active prompt task. */
  captureUpdatedTask(taskId: string, status: TaskStatus): void {
    if (this.enabled && !this.promptTaskId && status === "in_progress") {
      this.promptTaskId = taskId;
    }
  }
}
