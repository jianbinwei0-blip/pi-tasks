import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  aggregateTaskExecutionStats,
  calculateCacheHitRatio,
  calculateOutputTokenRate,
} from "../src/task-stats.js";
import { TaskStore } from "../src/task-store.js";

describe("inclusive task execution statistics", () => {
  it("resolves totals per record and weights ratios across the entire subtree", () => {
    const store = new TaskStore();
    store.create("Parent", "", undefined, {
      executionStats: {
        startedAt: 1000, completedAt: 101_000, durationMs: 100_000, activeDurationMs: 10_000,
        inputTokens: 100, outputTokens: 100, totalTokens: 1200, costUsd: 1,
      },
    });
    store.createSubtask("1", "Child", "", undefined, {
      executionStats: {
        startedAt: 2000, durationMs: 20_000,
        inputTokens: 100, outputTokens: 200, cacheReadTokens: 600, cacheWriteTokens: 200, costUsd: 2,
      },
    });
    store.createSubtask("1.1", "Grandchild", "", undefined, {
      executionStats: { startedAt: 3000, completedAt: 33_000, inputTokens: 100, outputTokens: 600 },
    });
    store.create("Unrelated dependency", "", undefined, {
      executionStats: { startedAt: 1000, totalTokens: 1_000_000, costUsd: 1000 },
    });
    store.update("1", { addBlockedBy: ["2"] });

    const reports = aggregateTaskExecutionStats(store.list(), undefined, 200_000);
    expect(reports.get("1")).toEqual({
      startedAt: 1000, completedAt: 101_000, durationMs: 100_000, activeDurationMs: 60_000,
      inputTokens: 300, outputTokens: 900, cacheReadTokens: 600, cacheWriteTokens: 200,
      totalTokens: 3000, costUsd: 3, legacyUsageOverlap: true,
    });
    expect(reports.get("1.1")?.totalTokens).toBe(1800);
    expect(reports.get("1.1.1")?.totalTokens).toBe(700);
    expect(calculateCacheHitRatio(reports.get("1")!)).toBeCloseTo(600 / 1100);
    expect(calculateOutputTokenRate(reports.get("1")!)).toBe(15);
    expect(reports.get("2")?.totalTokens).toBe(1_000_000);
  });

  it("includes completed and running descendants even when the parent has no stats", () => {
    const store = new TaskStore();
    store.create("Untracked parent", "");
    store.createSubtask("1", "Done", "", undefined, {
      executionStats: { startedAt: 1000, completedAt: 2000, inputTokens: 10, outputTokens: 20 },
    });
    store.update("1.1", { status: "completed" });
    store.createSubtask("1", "Running", "", undefined, {
      executionStats: { startedAt: 3000, inputTokens: 20, outputTokens: 40 },
    });
    store.update("1.2", { status: "in_progress" });
    store.createSubtask("1", "Not started", "");
    const report = aggregateTaskExecutionStats(store.list(), undefined, 5000).get("1");
    expect(report).toEqual({
      startedAt: 1000, activeDurationMs: 3000, inputTokens: 30, outputTokens: 60, totalTokens: 90,
      legacyUsageOverlap: true,
    });
    expect(store.get("1")!.metadata).toEqual({});
  });

  it("skips malformed counters without dropping valid descendants", () => {
    const store = new TaskStore();
    store.create("Malformed parent", "", undefined, { executionStats: { startedAt: "bad" } });
    store.createSubtask("1", "Malformed child", "", undefined, {
      executionStats: { startedAt: 1000, totalTokens: Number.NaN },
    });
    store.createSubtask("1.1", "Valid grandchild", "", undefined, {
      executionStats: { startedAt: 1000, totalTokens: 123 },
    });
    store.createSubtask("1", "Missing stats", "");
    const reports = aggregateTaskExecutionStats(store.list(), undefined, 2000);
    expect(reports.get("1")?.totalTokens).toBe(123);
    expect(reports.get("1.1")?.totalTokens).toBe(123);
    expect(reports.has("1.2")).toBe(false);
  });

  it("only warns about overlapping legacy usage when multiple unversioned records contribute", () => {
    const store = new TaskStore();
    store.create("Legacy parent", "", undefined, { executionStats: { startedAt: 1000, totalTokens: 100 } });
    store.createSubtask("1", "Allocated child", "", undefined, {
      executionStats: { usageAttribution: "exclusive", startedAt: 1000, totalTokens: 200 },
    });
    store.createSubtask("1", "Empty legacy child", "", undefined, { executionStats: { startedAt: 1000 } });
    expect(aggregateTaskExecutionStats(store.list()).get("1")?.legacyUsageOverlap).toBeUndefined();
    store.update("1.1", { metadata: { executionStats: { startedAt: 1000, totalTokens: 200 } } });
    const reports = aggregateTaskExecutionStats(store.list());
    expect(reports.get("1")?.legacyUsageOverlap).toBe(true);
    expect(reports.get("1.1")?.legacyUsageOverlap).toBeUndefined();
  });

  it("handles cycles and missing parents without counting a record twice", () => {
    const store = new TaskStore();
    store.create("Parent", "", undefined, { executionStats: { startedAt: 1000, totalTokens: 100 } });
    store.createSubtask("1", "Child", "", undefined, { executionStats: { startedAt: 1000, totalTokens: 200 } });
    store.get("1")!.parentTaskId = "1.1";
    let reports = aggregateTaskExecutionStats(store.list());
    expect(reports.get("1")?.totalTokens).toBe(300);
    expect(reports.get("1.1")?.totalTokens).toBe(300);
    store.get("1")!.parentTaskId = "missing";
    reports = aggregateTaskExecutionStats(store.list());
    expect(reports.get("1")?.totalTokens).toBe(300);
    expect(reports.get("1.1")?.totalTokens).toBe(200);
    expect(reports.has("missing")).toBe(false);
  });

  it("rebuilds rollups from persisted own counters without mutating or accumulating reports", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-tasks-rollup-"));
    try {
      const path = join(dir, "tasks.json");
      const store = new TaskStore(path);
      store.create("Parent", "", undefined, { executionStats: { startedAt: 1000, totalTokens: 100 } });
      store.createSubtask("1", "Child", "", undefined, { executionStats: { startedAt: 2000, totalTokens: 200 } });
      const original = readFileSync(path, "utf8");
      const reports = aggregateTaskExecutionStats(store.list(), undefined, 3000);
      expect(reports.get("1")?.totalTokens).toBe(300);
      expect(aggregateTaskExecutionStats(store.list().reverse(), undefined, 3000)).toEqual(reports);
      expect(aggregateTaskExecutionStats(new TaskStore(path).list(), undefined, 3000)).toEqual(reports);
      expect(readFileSync(path, "utf8")).toBe(original);
      store.delete("1.1");
      expect(aggregateTaskExecutionStats(store.list()).get("1")?.totalTokens).toBe(100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
