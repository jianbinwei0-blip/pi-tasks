import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PromptTaskHierarchy } from "../src/prompt-task-hierarchy.js";
import { compareTaskIds, TaskStore } from "../src/task-store.js";
import type { Task, TaskStoreData } from "../src/types.js";

const tempPaths: string[] = [];

afterEach(() => {
  for (const path of tempPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("TaskStore hierarchy", () => {
  it("creates stable subtask IDs without consuming the next top-level ID", () => {
    const store = new TaskStore();
    const parent = store.create("Prompt task", "Handle the prompt");
    const first = store.createSubtask(parent.id, "First step", "Do the first step");
    const second = store.createSubtask(parent.id, "Second step", "Do the second step");
    const nextPrompt = store.create("Next prompt", "Handle the next prompt");

    expect(parent.id).toBe("1");
    expect(first).toMatchObject({ id: "1.1", parentTaskId: "1" });
    expect(second).toMatchObject({ id: "1.2", parentTaskId: "1" });
    expect(nextPrompt.id).toBe("2");
  });

  it("does not reuse a deleted subtask ID", () => {
    const store = new TaskStore();
    const parent = store.create("Prompt task", "Handle the prompt");
    store.createSubtask(parent.id, "Removed step", "Remove me");
    store.update("1.1", { status: "deleted" });

    expect(store.createSubtask(parent.id, "Replacement step", "Do not reuse the ID").id).toBe("1.2");
  });

  it("persists subtask counters across store instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-tasks-hierarchy-"));
    tempPaths.push(dir);
    const path = join(dir, "tasks.json");

    const firstStore = new TaskStore(path);
    const parent = firstStore.create("Prompt task", "Handle the prompt");
    firstStore.createSubtask(parent.id, "First step", "Do the first step");

    const secondStore = new TaskStore(path);
    expect(secondStore.createSubtask(parent.id, "Second step", "Do the second step").id).toBe("1.2");
  });

  it("derives the next subtask ID from legacy files without counters", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-tasks-hierarchy-legacy-"));
    tempPaths.push(dir);
    const path = join(dir, "tasks.json");
    const now = Date.now();
    writeFileSync(path, JSON.stringify({
      nextId: 2,
      tasks: [
        {
          id: "1",
          subject: "Prompt task",
          description: "Handle the prompt",
          status: "pending",
          metadata: {},
          blocks: [],
          blockedBy: [],
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "1.4",
          parentTaskId: "1",
          subject: "Existing step",
          description: "Already persisted",
          status: "pending",
          metadata: {},
          blocks: [],
          blockedBy: [],
          createdAt: now,
          updatedAt: now,
        },
      ],
    }));

    const store = new TaskStore(path);
    expect(store.createSubtask("1", "Next step", "Continue after the legacy ID").id).toBe("1.5");
  });

  it("rejects subtasks whose parent does not exist", () => {
    const store = new TaskStore();
    expect(() => store.createSubtask("99", "Orphan", "No parent")).toThrow("Parent task #99 not found");
  });

  it("keeps a parent open until its running and blocked descendants are finished", () => {
    const store = new TaskStore();
    const parent = store.create("Restore and verify data", "Desc");
    const fix = store.createSubtask(parent.id, "Fix failure", "Desc");
    const verify = store.createSubtask(parent.id, "Verify", "Desc");
    const nested = store.createSubtask(fix.id, "Apply fix", "Desc");
    const dependent = store.create("Dependent workflow", "Desc");
    store.update(parent.id, { status: "in_progress" });
    store.update(fix.id, { status: "in_progress" });
    store.update(verify.id, { addBlockedBy: [fix.id] });
    store.update(dependent.id, { addBlockedBy: [parent.id] });

    const before = store.get(parent.id)?.updatedAt;
    const rejected = store.update(parent.id, { status: "completed", subject: "Premature edit" });
    expect(rejected).toMatchObject({
      statusError: "Cannot complete task #1: unfinished subtasks #1.1, #1.1.1, #1.2.",
      changedFields: [],
    });
    expect(store.get(parent.id)).toMatchObject({ status: "in_progress", subject: "Restore and verify data", updatedAt: before });
    expect(store.archiveCompleted([parent.id])).toBe(0);
    expect(store.get(dependent.id)?.blockedBy).toEqual([parent.id]);
    expect(store.update(fix.id, { status: "completed" }).statusError).toContain(`#${nested.id}`);

    store.update(nested.id, { status: "completed" });
    store.update(fix.id, { status: "completed" });
    store.update(verify.id, { status: "completed" });
    expect(store.get(parent.id)?.status).toBe("in_progress");
    expect(store.update(parent.id, { status: "completed" }).task?.status).toBe("completed");
  });

  it("requires reopening completed ancestors before adding or reopening descendant work", () => {
    const store = new TaskStore();
    const parent = store.create("Parent", "Desc");
    const child = store.createSubtask(parent.id, "Child", "Desc");
    const nested = store.createSubtask(child.id, "Nested", "Desc");
    for (const task of [nested, child, parent]) store.update(task.id, { status: "completed" });

    expect(() => store.createSubtask(parent.id, "Late step", "Desc")).toThrow(/#1 is completed/);
    expect(store.update(child.id, { status: "in_progress" }).statusError).toMatch(/#1 is completed/);
    expect(store.get(child.id)?.status).toBe("completed");
    store.update(parent.id, { status: "in_progress" });
    expect(store.update(nested.id, { status: "pending" }).statusError).toMatch(/#1\.1 is completed/);
    store.update(child.id, { status: "in_progress" });
    expect(store.update(nested.id, { status: "pending" }).task?.status).toBe("pending");
    expect(store.createSubtask(parent.id, "Late step", "Desc").id).toBe("1.2");
  });

  it("rejects reopening a retained child beneath an archived parent", () => {
    const store = new TaskStore();
    const parent = store.create("Parent", "Desc");
    const child = store.createSubtask(parent.id, "Child", "Desc");
    store.update(child.id, { status: "completed" });
    store.update(parent.id, { status: "completed" });
    expect(store.archiveCompleted([parent.id])).toBe(1);

    expect(store.update(child.id, { status: "in_progress" }).statusError).toMatch(/#1 is archived/);
    expect(store.get(child.id)?.status).toBe("completed");
  });

  it("checks the latest hierarchy before completing a shared task", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-tasks-hierarchy-"));
    tempPaths.push(dir);
    const path = join(dir, "tasks.json");
    const first = new TaskStore(path);
    const parent = first.create("Parent", "Desc");
    const second = new TaskStore(path);
    second.createSubtask(parent.id, "Added by another process", "Desc");

    expect(first.update(parent.id, { status: "completed" }).statusError).toContain("#1.1");
    expect(second.get(parent.id)?.status).toBe("pending");
  });

  it("repairs premature completions on reload without losing descendants or usage", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-tasks-hierarchy-legacy-"));
    tempPaths.push(dir);
    const path = join(dir, "tasks.json");
    const fixture = (id: string, status: Task["status"], fields: Partial<Task> = {}): Task => ({
      id, subject: id, description: "Legacy task", status, metadata: {},
      blocks: [], blockedBy: [], createdAt: 1000, updatedAt: 3000, ...fields,
    });
    const data: TaskStoreData = {
      nextId: 4,
      historyInitialized: true,
      completedTaskHistory: [{ id: "3" }, { id: "4" }],
      tasks: [
        fixture("1", "completed", { metadata: { executionStats: {
          startedAt: 1000, completedAt: 3000, durationMs: 2000, inputTokens: 10, outputTokens: 20,
        } } }),
        fixture("1.1", "completed"),
        fixture("1.1.1", "in_progress"),
        fixture("1.2", "pending", { blockedBy: ["1.1.1"] }),
        fixture("2", "completed"),
        fixture("3.1", "pending", { parentTaskId: "3" }),
      ],
    };
    writeFileSync(path, JSON.stringify(data));

    const store = new TaskStore(path);
    expect(store.getProgress().map(({ id, status }) => [id, status])).toEqual([
      ["4", "completed"], ["1", "in_progress"], ["1.1", "in_progress"], ["1.1.1", "in_progress"],
      ["1.2", "pending"], ["2", "completed"], ["3.1", "pending"],
    ]);
    expect(store.get("1")?.metadata.executionStats).toEqual({
      startedAt: 1000, activeDurationMs: 2000, inputTokens: 10, outputTokens: 20,
    });
    expect(store.get("1.2")?.blockedBy).toEqual(["1.1.1"]);
    expect(store.archiveCompleted()).toBe(1);
    expect(new TaskStore(path).get("1")?.status).toBe("in_progress");
  });

  it("sorts hierarchical IDs segment-by-segment", () => {
    const ids = ["2", "1.10", "1.2", "1", "1.1", "1.2.1"];
    expect(ids.sort(compareTaskIds)).toEqual(["1", "1.1", "1.2", "1.2.1", "1.10", "2"]);
  });
});

describe("PromptTaskHierarchy", () => {
  it("uses the first created task as the prompt parent", () => {
    const hierarchy = new PromptTaskHierarchy();
    hierarchy.startPrompt(true);

    expect(hierarchy.parentForNextTask(() => true)).toBeUndefined();
    hierarchy.captureCreatedTask("13");
    expect(hierarchy.parentForNextTask((id) => id === "13")).toBe("13");
  });

  it("uses an existing task moved in progress as the prompt parent", () => {
    const hierarchy = new PromptTaskHierarchy();
    hierarchy.startPrompt(true);
    hierarchy.captureUpdatedTask("13", "in_progress");

    expect(hierarchy.parentForNextTask((id) => id === "13")).toBe("13");
  });

  it("resets the parent at each prompt and disables tracking outside always mode", () => {
    const hierarchy = new PromptTaskHierarchy();
    hierarchy.startPrompt(true);
    hierarchy.captureCreatedTask("13");

    hierarchy.startPrompt(true);
    expect(hierarchy.parentForNextTask(() => true)).toBeUndefined();

    hierarchy.captureCreatedTask("14");
    hierarchy.startPrompt(false);
    expect(hierarchy.parentForNextTask(() => true)).toBeUndefined();
  });

  it("drops a prompt parent that no longer exists", () => {
    const hierarchy = new PromptTaskHierarchy();
    hierarchy.startPrompt(true);
    hierarchy.captureCreatedTask("13");

    expect(hierarchy.parentForNextTask(() => false)).toBeUndefined();
    hierarchy.captureCreatedTask("14");
    expect(hierarchy.parentForNextTask((id) => id === "14")).toBe("14");
  });
});
