import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PromptTaskHierarchy } from "../src/prompt-task-hierarchy.js";
import { compareTaskIds, TaskStore } from "../src/task-store.js";

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
