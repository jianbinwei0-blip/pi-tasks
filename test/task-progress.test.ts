import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStore } from "../src/task-store.js";

describe("Persistent task progress", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "task-progress-"));
    file = join(dir, "tasks.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps completed counts after cleanup and across multiple store instances", () => {
    const first = new TaskStore(file);
    first.initializeCompletedHistory(() => []);
    const second = new TaskStore(file);
    first.create("Finished", "Desc");
    first.createSubtask("1", "Finished step", "Desc");
    second.update("1", { status: "completed" });
    second.update("1.1", { status: "completed" });
    expect(first.archiveCompleted(["1", "1.1"])).toBe(2);
    expect(first.archiveCompleted(["1", "1.1"])).toBe(0);
    second.create("Next", "Desc");
    expect(first.list().map(task => task.id)).toEqual(["2"]);
    expect(first.getProgress().map(task => [task.id, task.status])).toEqual([
      ["1", "completed"], ["1.1", "completed"], ["2", "pending"],
    ]);
    expect(new TaskStore(file).getProgress()).toEqual(first.getProgress());
  });

  it("imports missing completions once and lets retained statuses override history", () => {
    const first = new TaskStore(file);
    first.create("Still pending", "Desc");
    first.initializeCompletedHistory(() => [{ id: "1" }, { id: "1.1", parentTaskId: "1" }, { id: "7" }]);
    const resumed = new TaskStore(file);
    const recover = vi.fn(() => [{ id: "99" }]);
    resumed.initializeCompletedHistory(recover);
    expect(recover).not.toHaveBeenCalled();
    expect(resumed.getProgress().map(task => [task.id, task.status])).toEqual([
      ["1.1", "completed"], ["7", "completed"], ["1", "pending"],
    ]);
    expect(resumed.createSubtask("1", "Next step", "Desc").id).toBe("1.2");
    expect(resumed.create("Next workflow", "Desc").id).toBe("8");
  });

  it("does not infer completions from legacy next-ID counters alone", () => {
    writeFileSync(file, JSON.stringify({ nextId: 37, nextSubtaskIds: { "21": 53 }, tasks: [] }));
    const store = new TaskStore(file);
    store.initializeCompletedHistory(() => []);
    expect(store.getProgress()).toEqual([]);
  });

  it.each(["clearAll", "clearCompleted"] as const)("keeps explicit %s resets cleared after reload", clear => {
    const store = new TaskStore(file);
    const history = [{ id: "1" }, { id: "1.1", parentTaskId: "1" }];
    store.initializeCompletedHistory(() => history);
    expect(store.deleteFileIfEmpty()).toBe(false);
    expect(store[clear]()).toBe(2);
    expect(store.deleteFileIfEmpty()).toBe(false);
    const resumed = new TaskStore(file);
    resumed.initializeCompletedHistory(() => history);
    expect(resumed.getProgress()).toEqual([]);
    expect(resumed.create("New work", "Desc").id).toBe("2");
  });

  it("explicitly deletes archived tasks without reviving them on reload", () => {
    const store = new TaskStore(file);
    const history = [{ id: "1" }, { id: "1.1", parentTaskId: "1" }, { id: "2" }];
    store.initializeCompletedHistory(() => history);
    expect(store.update("1", { status: "deleted" }).changedFields).toEqual(["deleted"]);
    expect(store.delete("2")).toBe(true);
    const resumed = new TaskStore(file);
    resumed.initializeCompletedHistory(() => history);
    expect(resumed.getProgress().map(task => task.id)).toEqual(["1.1"]);
    expect(resumed.delete("2")).toBe(false);
  });

  it("never archives unfinished work and removes dependency edges only for archived rows", () => {
    const store = new TaskStore();
    store.create("Done", "Desc");
    store.create("Running", "Desc");
    store.create("Blocked", "Desc");
    store.update("1", { status: "completed", addBlocks: ["3"] });
    store.update("2", { status: "in_progress", addBlocks: ["3"] });
    expect(store.archiveCompleted(["1", "2", "3"])).toBe(1);
    expect(store.get("3")?.blockedBy).toEqual(["2"]);
    expect(store.getProgress()).toHaveLength(3);
  });
});
