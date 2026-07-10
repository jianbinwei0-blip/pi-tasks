/**
 * task-store.ts — File-backed task store with CRUD, dependency management, and file locking.
 *
 * Session-scoped (default): in-memory Map — no disk I/O.
 * Shared (PI_TASK_LIST_ID set): ~/.pi/tasks/<listId>.json with file locking.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { Task, TaskStatus, TaskStoreData } from "./types.js";

const HIERARCHICAL_TASK_ID = /^\d+(?:\.\d+)*$/;

/** Compare IDs by numeric path segment: #1, #1.1, #1.2, #1.10, #2. */
export function compareTaskIds(left: string, right: string): number {
  if (!HIERARCHICAL_TASK_ID.test(left) || !HIERARCHICAL_TASK_ID.test(right)) {
    return left.localeCompare(right, "en", { numeric: true });
  }

  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const sharedLength = Math.min(leftParts.length, rightParts.length);
  for (let index = 0; index < sharedLength; index++) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return difference;
  }
  return leftParts.length - rightParts.length;
}

function sortById(a: Task, b: Task): number {
  return compareTaskIds(a.id, b.id);
}

function sortByStatus(a: Task, b: Task): number {
  const rank = (s: string) => s === "completed" ? 0 : s === "in_progress" ? 1 : 2;
  return rank(a.status) - rank(b.status) || compareTaskIds(a.id, b.id);
}

function sortByRecent(a: Task, b: Task): number {
  return b.updatedAt - a.updatedAt || compareTaskIds(b.id, a.id);
}

function sortByOldest(a: Task, b: Task): number {
  return a.updatedAt - b.updatedAt || compareTaskIds(a.id, b.id);
}

const SORT_FNS = { id: sortById, status: sortByStatus, recent: sortByRecent, oldest: sortByOldest };

const TASKS_DIR = join(homedir(), ".pi", "tasks");
const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100; // 5s max

/** Simple file-based locking. */
function acquireLock(lockPath: string): void {
  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      // O_EXCL: fail if file exists
      writeFileSync(lockPath, `${process.pid}`, { flag: "wx" });
      return;
    } catch (e: any) {
      if (e.code === "EEXIST") {
        // Check for stale lock (process no longer running)
        try {
          const pid = parseInt(readFileSync(lockPath, "utf-8"), 10);
          if (pid && !isProcessRunning(pid)) {
            unlinkSync(lockPath);
            continue;
          }
        } catch { /* ignore read errors */ }
        // Wait and retry
        const start = Date.now();
        while (Date.now() - start < LOCK_RETRY_MS) { /* busy wait */ }
        continue;
      }
      throw e;
    }
  }
  throw new Error(`Failed to acquire lock: ${lockPath}`);
}

function releaseLock(lockPath: string): void {
  try { unlinkSync(lockPath); } catch { /* ignore */ }
}

function isProcessRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export class TaskStore {
  private filePath: string | undefined;
  private lockPath: string | undefined;

  // In-memory state (always kept in sync)
  private nextId = 1;
  private nextSubtaskIds = new Map<string, number>();
  private tasks = new Map<string, Task>();

  constructor(listIdOrPath?: string) {
    if (!listIdOrPath) return;
    const isAbsPath = isAbsolute(listIdOrPath);
    const filePath = isAbsPath ? listIdOrPath : join(TASKS_DIR, `${listIdOrPath}.json`);
    mkdirSync(dirname(filePath), { recursive: true });
    this.filePath = filePath;
    this.lockPath = filePath + ".lock";
    this.load();
  }

  /** Read store from disk (file-backed mode only). */
  private load(): void {
    if (!this.filePath) return;
    if (!existsSync(this.filePath)) return;
    try {
      const data: TaskStoreData = JSON.parse(readFileSync(this.filePath, "utf-8"));
      this.nextId = data.nextId;
      this.nextSubtaskIds.clear();
      for (const [parentTaskId, nextId] of Object.entries(data.nextSubtaskIds ?? {})) {
        if (Number.isSafeInteger(nextId) && nextId > 0) {
          this.nextSubtaskIds.set(parentTaskId, nextId);
        }
      }
      this.tasks.clear();
      for (const t of data.tasks) {
        this.tasks.set(t.id, t);
      }
      this.reconcileSubtaskState();
    } catch { /* corrupt file — start fresh */ }
  }

  /** Infer legacy parent links and ensure child counters advance past stored IDs. */
  private reconcileSubtaskState(): void {
    for (const task of this.tasks.values()) {
      const separator = task.id.lastIndexOf(".");
      const inferredParentId = separator > 0 ? task.id.slice(0, separator) : undefined;
      if (!task.parentTaskId && inferredParentId && this.tasks.has(inferredParentId)) {
        task.parentTaskId = inferredParentId;
      }

      const parentTaskId = task.parentTaskId;
      if (!parentTaskId || !task.id.startsWith(`${parentTaskId}.`)) continue;
      const ordinalText = task.id.slice(parentTaskId.length + 1);
      if (!/^\d+$/.test(ordinalText)) continue;
      const nextId = Number(ordinalText) + 1;
      if (nextId > (this.nextSubtaskIds.get(parentTaskId) ?? 1)) {
        this.nextSubtaskIds.set(parentTaskId, nextId);
      }
    }
  }

  /** Write store to disk atomically (file-backed mode only). */
  private save(): void {
    if (!this.filePath) return;
    const data: TaskStoreData = {
      nextId: this.nextId,
      nextSubtaskIds: Object.fromEntries(this.nextSubtaskIds),
      tasks: Array.from(this.tasks.values()),
    };
    const tmpPath = this.filePath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    renameSync(tmpPath, this.filePath);
  }

  /** Execute a mutation with file locking (if file-backed). */
  private withLock<T>(fn: () => T): T {
    if (!this.lockPath) return fn();
    acquireLock(this.lockPath);
    try {
      this.load(); // Re-read latest state
      const result = fn();
      this.save();
      return result;
    } finally {
      releaseLock(this.lockPath);
    }
  }

  create(subject: string, description: string, activeForm?: string, metadata?: Record<string, any>): Task {
    return this.createTask(undefined, subject, description, activeForm, metadata);
  }

  createSubtask(
    parentTaskId: string,
    subject: string,
    description: string,
    activeForm?: string,
    metadata?: Record<string, any>,
  ): Task {
    return this.createTask(parentTaskId, subject, description, activeForm, metadata);
  }

  private createTask(
    parentTaskId: string | undefined,
    subject: string,
    description: string,
    activeForm?: string,
    metadata?: Record<string, any>,
  ): Task {
    return this.withLock(() => {
      let id: string;
      if (parentTaskId) {
        if (!this.tasks.has(parentTaskId)) {
          throw new Error(`Parent task #${parentTaskId} not found`);
        }
        let nextSubtaskId = this.nextSubtaskIds.get(parentTaskId) ?? 1;
        id = `${parentTaskId}.${nextSubtaskId}`;
        while (this.tasks.has(id)) {
          id = `${parentTaskId}.${++nextSubtaskId}`;
        }
        this.nextSubtaskIds.set(parentTaskId, nextSubtaskId + 1);
      } else {
        id = String(this.nextId++);
      }

      const now = Date.now();
      const task: Task = {
        id,
        parentTaskId,
        subject,
        description,
        status: "pending",
        activeForm,
        owner: undefined,
        metadata: metadata ?? {},
        blocks: [],
        blockedBy: [],
        createdAt: now,
        updatedAt: now,
      };
      this.tasks.set(task.id, task);
      return task;
    });
  }

  get(id: string): Task | undefined {
    if (this.filePath) this.load();
    return this.tasks.get(id);
  }

  /** List all tasks, sorted by the given order (defaults to ID ascending). */
  list(sortOrder: "id" | "status" | "recent" | "oldest" = "id"): Task[] {
    if (this.filePath) this.load();
    return Array.from(this.tasks.values()).sort(SORT_FNS[sortOrder]);
  }

  update(id: string, fields: {
    status?: TaskStatus | "deleted";
    subject?: string;
    description?: string;
    activeForm?: string;
    owner?: string;
    metadata?: Record<string, any>;
    addBlocks?: string[];
    addBlockedBy?: string[];
  }): { task: Task | undefined; changedFields: string[]; warnings: string[] } {
    return this.withLock(() => {
      const task = this.tasks.get(id);
      if (!task) return { task: undefined, changedFields: [], warnings: [] };

      const changedFields: string[] = [];
      const warnings: string[] = [];

      // Handle deletion
      if (fields.status === "deleted") {
        this.tasks.delete(id);
        // Clean up dependency edges pointing to this task
        for (const t of this.tasks.values()) {
          t.blocks = t.blocks.filter(bid => bid !== id);
          t.blockedBy = t.blockedBy.filter(bid => bid !== id);
        }
        return { task: undefined, changedFields: ["deleted"], warnings: [] };
      }

      if (fields.status !== undefined) {
        task.status = fields.status;
        changedFields.push("status");
      }
      if (fields.subject !== undefined) {
        task.subject = fields.subject;
        changedFields.push("subject");
      }
      if (fields.description !== undefined) {
        task.description = fields.description;
        changedFields.push("description");
      }
      if (fields.activeForm !== undefined) {
        task.activeForm = fields.activeForm;
        changedFields.push("activeForm");
      }
      if (fields.owner !== undefined) {
        task.owner = fields.owner;
        changedFields.push("owner");
      }

      // Metadata: shallow merge, null deletes keys
      if (fields.metadata !== undefined) {
        for (const [key, value] of Object.entries(fields.metadata)) {
          if (value === null) {
            delete task.metadata[key];
          } else {
            task.metadata[key] = value;
          }
        }
        changedFields.push("metadata");
      }

      // Bidirectional dependency edges
      if (fields.addBlocks && fields.addBlocks.length > 0) {
        for (const targetId of fields.addBlocks) {
          if (!task.blocks.includes(targetId)) {
            task.blocks.push(targetId);
          }
          const target = this.tasks.get(targetId);
          if (target && !target.blockedBy.includes(id)) {
            target.blockedBy.push(id);
            target.updatedAt = Date.now();
          }
          // Warnings for problematic edges
          if (targetId === id) {
            warnings.push(`#${id} blocks itself`);
          } else if (!target) {
            warnings.push(`#${targetId} does not exist`);
          } else if (target.blocks.includes(id)) {
            warnings.push(`cycle: #${id} and #${targetId} block each other`);
          }
        }
        changedFields.push("blocks");
      }

      if (fields.addBlockedBy && fields.addBlockedBy.length > 0) {
        for (const targetId of fields.addBlockedBy) {
          if (!task.blockedBy.includes(targetId)) {
            task.blockedBy.push(targetId);
          }
          const target = this.tasks.get(targetId);
          if (target && !target.blocks.includes(id)) {
            target.blocks.push(id);
            target.updatedAt = Date.now();
          }
          // Warnings for problematic edges
          if (targetId === id) {
            warnings.push(`#${id} blocks itself`);
          } else if (!target) {
            warnings.push(`#${targetId} does not exist`);
          } else if (task.blocks.includes(targetId)) {
            warnings.push(`cycle: #${id} and #${targetId} block each other`);
          }
        }
        changedFields.push("blockedBy");
      }

      task.updatedAt = Date.now();
      return { task, changedFields, warnings };
    });
  }

  /** Delete a task by ID. Returns true if deleted. */
  delete(id: string): boolean {
    return this.withLock(() => {
      if (!this.tasks.has(id)) return false;
      this.tasks.delete(id);
      // Clean up dependency edges
      for (const t of this.tasks.values()) {
        t.blocks = t.blocks.filter(bid => bid !== id);
        t.blockedBy = t.blockedBy.filter(bid => bid !== id);
      }
      return true;
    });
  }

  /** Remove all tasks. */
  clearAll(): number {
    return this.withLock(() => {
      const count = this.tasks.size;
      this.tasks.clear();
      return count;
    });
  }

  /** Delete the backing file (if file-backed and empty). */
  deleteFileIfEmpty(): boolean {
    if (!this.filePath || this.tasks.size > 0) return false;
    try { unlinkSync(this.filePath); } catch { /* ignore */ }
    return true;
  }

  /** Remove all completed tasks. */
  clearCompleted(): number {
    return this.withLock(() => {
      let count = 0;
      for (const [id, task] of this.tasks) {
        if (task.status === "completed") {
          this.tasks.delete(id);
          count++;
        }
      }
      // Clean up dependency edges for deleted tasks
      if (count > 0) {
        const validIds = new Set(this.tasks.keys());
        for (const t of this.tasks.values()) {
          t.blocks = t.blocks.filter(bid => validIds.has(bid));
          t.blockedBy = t.blockedBy.filter(bid => validIds.has(bid));
        }
      }
      return count;
    });
  }
}
