import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoClearManager, type AutoClearMode } from "../src/auto-clear.js";
import { TaskStore } from "../src/task-store.js";
import type { TasksConfig } from "../src/tasks-config.js";
import { TaskWidget, type Theme, type UICtx } from "../src/ui/task-widget.js";

/** Create a mock theme that returns raw text (no ANSI escapes). */
function mockTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    strikethrough: (text: string) => `~~${text}~~`,
  };
}

/** Create a mock UICtx that captures setWidget calls. */
function mockUICtx() {
  const state: {
    widgets: Map<string, any>;
    statuses: Map<string, string | undefined>;
  } = {
    widgets: new Map(),
    statuses: new Map(),
  };

  const ctx: UICtx = {
    setWidget(key, content, options) {
      state.widgets.set(key, { content, options });
    },
    setStatus(key, text) {
      state.statuses.set(key, text);
    },
  };

  return { ctx, state };
}

/** Render the widget and return its lines. */
function renderWidget(state: ReturnType<typeof mockUICtx>["state"]): string[] {
  const entry = state.widgets.get("tasks");
  if (!entry?.content) return [];
  const theme = mockTheme();
  const tui = { terminal: { columns: 200 }, requestRender() {} };
  const result = entry.content(tui, theme);
  return result.render();
}

/** Extract task rows without confusing dependency references with displayed tasks. */
function renderedTaskRows(lines: string[]): { id: string; indent: number }[] {
  return lines.flatMap(line => {
    const match = line.match(/^(\s+)\S+ (?:~~)?#([\d.]+) /);
    return match ? [{ id: match[2], indent: match[1].length }] : [];
  });
}

describe("TaskWidget", () => {
  let store: TaskStore;
  let widget: TaskWidget;
  let ui: ReturnType<typeof mockUICtx>;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new TaskStore();
    widget = new TaskWidget(store);
    ui = mockUICtx();
    widget.setUICtx(ui.ctx);
    widget.setAgentActive(true);
  });

  afterEach(() => {
    widget.dispose();
    vi.useRealTimers();
  });

  it("shows nothing when no tasks exist", () => {
    widget.update();
    const entry = ui.state.widgets.get("tasks");
    expect(entry?.content).toBeUndefined();
  });

  it("renders pending tasks with ◻ icon", () => {
    store.create("Do something", "Desc");
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines).toHaveLength(2); // header + 1 task
    expect(lines[0]).toBe("● 1 ready task");
    expect(lines[1]).toContain("◻");
    expect(lines[1]).toContain("Do something");
  });

  it("renders in-progress tasks with ◼ icon, start time, and duration", () => {
    vi.setSystemTime(new Date("2026-04-13T15:04:00Z"));
    store.create("Working on it", "Desc");
    store.update("1", { status: "in_progress" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("◼");
    expect(lines[1]).toContain("Working on it");
    expect(lines[1]).toMatch(/\(\d{2}:\d{2}:\d{2} Δ0:00\)$/);
  });

  it("persists start time metadata for non-active in-progress tasks on update", () => {
    vi.setSystemTime(new Date("2026-04-13T15:04:00Z"));
    store.create("Plain in-progress", "Desc");

    vi.advanceTimersByTime(60_000);
    store.update("1", { status: "in_progress" });
    widget.update();

    expect(store.get("1")!.metadata.executionStats).toEqual({
      usageAttribution: "exclusive",
      startedAt: 1776092700000,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    });
  });

  it("uses in-progress transition time when backfilling later completion stats", () => {
    vi.setSystemTime(new Date("2026-04-13T15:04:00Z"));
    store.create("Transition baseline", "Desc");

    vi.advanceTimersByTime(60_000);
    store.update("1", { status: "in_progress" });
    widget.update();

    vi.advanceTimersByTime(30_000);
    store.update("1", { status: "completed" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("~~#1 Transition baseline~~");
    expect(lines[1]).toContain("Δ0:30");
    expect(lines[1]).not.toContain("Δ1:30");
  });

  it("renders completed tasks with ✔ icon and strikethrough", () => {
    store.create("Done task", "Desc");
    store.update("1", { status: "completed" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("✔");
    expect(lines[1]).toContain("~~#1 Done task~~");
  });

  it("persists start time metadata as soon as a task starts", () => {
    vi.setSystemTime(new Date("2026-04-13T15:04:00Z"));
    store.create("Started task", "Desc", "Working");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    expect(store.get("1")!.metadata.executionStats).toEqual({
      usageAttribution: "exclusive",
      startedAt: 1776092640000,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    });
  });

  it("persists completed task stats after execution finishes", () => {
    vi.setSystemTime(new Date("2026-04-13T15:04:00Z"));
    store.create("Finished task", "Desc", "Working");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    widget.addTokenUsage(1500, 800);
    vi.advanceTimersByTime(65_000);

    store.update("1", { status: "completed" });
    widget.setActiveTask("1", false);

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("~~#1 Finished task~~");
    expect(lines[1]).toMatch(/\(\d{2}:\d{2}:\d{2} → \d{2}:\d{2}:\d{2} Δ1:05/);
    expect(lines[1]).toContain("↑1.5k");
    expect(lines[1]).toContain("↓800");
    expect(lines[1]).toContain("Σ2.3k");
    expect(lines[1]).toContain("12.3 t/s");
  });

  it("excludes time waiting for the next user prompt from token speed", () => {
    vi.setSystemTime(new Date("2026-04-13T15:04:00Z"));
    store.create("Multi-prompt task", "Desc", "Working");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    vi.advanceTimersByTime(10_000);
    widget.addTokenUsage(0, 100);
    widget.setAgentActive(false);

    vi.advanceTimersByTime(50_000);
    let lines = renderWidget(ui.state);
    expect(lines[1]).toContain("Δ1:00");
    expect(lines[1]).toContain("10.0 t/s");

    widget.setAgentActive(true);
    vi.advanceTimersByTime(10_000);
    widget.addTokenUsage(0, 100);
    store.update("1", { status: "completed" });
    widget.setActiveTask("1", false);

    expect(store.get("1")!.metadata.executionStats).toMatchObject({
      durationMs: 70_000,
      activeDurationMs: 20_000,
      outputTokens: 200,
    });
    lines = renderWidget(ui.state);
    expect(lines[1]).toContain("Δ1:10");
    expect(lines[1]).toContain("10.0 t/s");
  });

  it("keeps background-agent time continuous without copying foreground usage", () => {
    widget.setAgentActive(false);
    store.create("Background task", "Desc", "Running", { agentId: "agent-1" });
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    vi.advanceTimersByTime(10_000);
    widget.addTokenUsage(0, 100);
    store.update("1", { status: "completed" });
    widget.setActiveTask("1", false);

    expect(store.get("1")!.metadata.executionStats).toMatchObject({
      activeDurationMs: 10_000,
      outputTokens: 0,
    });
    expect(renderWidget(ui.state)[1]).not.toContain("t/s");
  });

  it("renders completed stats in the compact 24-hour format", () => {
    const startedAt = new Date(2026, 3, 13, 13, 48, 35).getTime();
    const completedAt = new Date(2026, 3, 13, 13, 50, 27).getTime();
    store.create("Compact stats", "Desc", undefined, {
      executionStats: {
        startedAt,
        completedAt,
        durationMs: 112_000,
        inputTokens: 23_400,
        outputTokens: 3516,
        cacheReadTokens: 3_320_884,
        cacheWriteTokens: 0,
        totalTokens: 3_347_800,
        costUsd: 1.88,
      },
    });
    store.update("1", { status: "completed" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain(
      "(13:48:35 → 13:50:27 Δ1:52 · ↑23.4k ↓3.5k Σ3.3M ⨀99.3% · 31.4 t/s · $1.88)",
    );
  });

  it("uses one decimal place across compact token counts", () => {
    const startedAt = new Date(2026, 3, 13, 13, 48, 35).getTime();
    const completedAt = new Date(2026, 3, 13, 13, 50, 27).getTime();
    store.create("Precise stats", "Desc", undefined, {
      executionStats: {
        startedAt,
        completedAt,
        durationMs: 112_000,
        inputTokens: 392_240,
        outputTokens: 120_000,
        totalTokens: 143_984_000,
      },
    });
    store.update("1", { status: "completed" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("↑392.2k ↓120k Σ144.0M");
  });

  it("renders live stats in the corresponding compact format", () => {
    const startedAt = new Date(2026, 3, 13, 13, 48, 35).getTime();
    vi.setSystemTime(new Date(2026, 3, 13, 13, 50, 27));
    store.create("Compact live stats", "Desc", undefined, {
      executionStats: {
        startedAt,
        inputTokens: 23_400,
        outputTokens: 3516,
        cacheReadTokens: 3_320_884,
        cacheWriteTokens: 0,
        totalTokens: 3_347_800,
        costUsd: 1.88,
      },
    });
    store.update("1", { status: "in_progress" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain(
      "(13:48:35 Δ1:52 · ↑23.4k ↓3.5k Σ3.3M ⨀99.3% · 31.4 t/s · $1.88)",
    );
  });

  it("renders persisted completed stats after widget recreation", () => {
    store.create("Remember stats", "Desc", "Working");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);
    widget.addTokenUsage(500, 200);

    vi.advanceTimersByTime(5000);
    store.update("1", { status: "completed" });
    widget.setActiveTask("1", false);
    widget.dispose();

    const restoredUi = mockUICtx();
    const restoredWidget = new TaskWidget(store);
    restoredWidget.setUICtx(restoredUi.ctx);
    restoredWidget.update();

    const lines = renderWidget(restoredUi.state);
    expect(lines[1]).toContain("~~#1 Remember stats~~");
    expect(lines[1]).toMatch(/\(\d{2}:\d{2}:\d{2} → \d{2}:\d{2}:\d{2} Δ0:05/);
    expect(lines[1]).toContain("↑500");
    expect(lines[1]).toContain("↓200");
    expect(lines[1]).toContain("Σ700");
    expect(lines[1]).toContain("40.0 t/s");

    restoredWidget.dispose();
  });

  it("uses the actual completion transition time when persisting stats later", () => {
    vi.setSystemTime(new Date("2026-04-13T15:04:00Z"));
    store.create("Delayed persist", "Desc", "Working");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    vi.advanceTimersByTime(65_000);
    store.update("1", { status: "completed" });

    vi.advanceTimersByTime(120_000);
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("~~#1 Delayed persist~~");
    expect(lines[1]).toMatch(/→ \d{2}:05:05 Δ1:05/);
    expect(lines[1]).not.toContain("Δ3:05");
  });

  it("rehydrates persisted in-progress tasks so completion stats survive resume", () => {
    vi.setSystemTime(new Date("2026-04-13T15:04:00Z"));
    store.create("Resume me", "Desc", "Working");
    store.update("1", { status: "in_progress" });

    const restoredUi = mockUICtx();
    const restoredWidget = new TaskWidget(store);
    restoredWidget.setUICtx(restoredUi.ctx);
    restoredWidget.update();

    vi.advanceTimersByTime(65_000);
    store.update("1", { status: "completed" });
    restoredWidget.update();

    const lines = renderWidget(restoredUi.state);
    expect(lines[1]).toContain("~~#1 Resume me~~");
    expect(lines[1]).toMatch(/→ \d{2}:05:05 Δ1:05/);

    restoredWidget.dispose();
  });

  it("renders persisted in-progress stats after widget recreation", () => {
    vi.setSystemTime(new Date("2026-04-13T15:05:30Z"));
    store.create("Resume display", "Desc", undefined, {
      executionStats: {
        startedAt: Date.parse("2026-04-13T15:04:00Z"),
        inputTokens: 1200,
        outputTokens: 3400,
      },
    });
    store.update("1", { status: "in_progress" });

    const restoredUi = mockUICtx();
    const restoredWidget = new TaskWidget(store);
    restoredWidget.setUICtx(restoredUi.ctx);
    restoredWidget.update();

    const lines = renderWidget(restoredUi.state);
    expect(lines[1]).toContain("◼");
    expect(lines[1]).toContain("Resume display");
    expect(lines[1]).toContain("Δ1:30");
    expect(lines[1]).toContain("↑1.2k");
    expect(lines[1]).toContain("↓3.4k");
    expect(lines[1]).toContain("Σ4.6k");
    expect(lines[1]).not.toContain("⨀");
    expect(lines[1]).toContain("37.8 t/s");

    restoredWidget.dispose();
  });

  it("ignores malformed execution stats metadata when rendering completed tasks", () => {
    store.create("Broken stats", "Desc");
    store.update("1", {
      status: "completed",
      metadata: {
        executionStats: { startedAt: "nope", completedAt: null },
      } as any,
    });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("~~#1 Broken stats~~");
    expect(lines[1]).toMatch(/\(\d{2}:\d{2}:\d{2} → \d{2}:\d{2}:\d{2} Δ0:00\)$/);
  });

  it("backfills stats for direct pending-to-completed transitions", () => {
    vi.setSystemTime(new Date("2026-04-13T15:04:00Z"));
    store.create("Fast finish", "Desc");

    vi.advanceTimersByTime(65_000);
    store.update("1", { status: "completed" });
    widget.setActiveTask("1", false);

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("~~#1 Fast finish~~");
    expect(lines[1]).toContain("Δ1:05");
    expect(lines[1]).not.toContain("↑");
    expect(lines[1]).not.toContain("↓");
  });

  it("uses blocker completion time when backfilling direct completion stats", () => {
    vi.setSystemTime(new Date("2026-04-13T15:04:00Z"));
    store.create("Blocker", "Desc");
    store.create("Blocked", "Desc");
    store.update("2", { addBlockedBy: ["1"] });

    vi.advanceTimersByTime(60_000);
    store.update("1", { status: "completed" });
    widget.setActiveTask("1", false);

    vi.advanceTimersByTime(120_000);
    store.update("2", { status: "completed" });
    widget.setActiveTask("2", false);

    const lines = renderWidget(ui.state);
    const blockedLine = lines.find(l => l.includes("Blocked"));
    expect(blockedLine).toContain("Δ2:00");
    expect(blockedLine).not.toContain("Δ3:00");
  });

  it("renders active tasks with spinner icon, start time, and duration", () => {
    vi.setSystemTime(new Date("2026-04-13T15:04:00Z"));
    store.create("Running thing", "Desc", "Processing data");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    const lines = renderWidget(ui.state);
    // Should show activeForm text with "…" suffix
    expect(lines[1]).toContain("Processing data…");
    expect(lines[1]).toMatch(/\(\d{2}:\d{2}:\d{2} Δ0:00\)$/);
    // Should NOT show ◼ for active task
    expect(lines[1]).not.toContain("◼");
  });

  it("shows blocked-by info for pending tasks", () => {
    store.create("Blocker", "Desc");
    store.create("Blocked", "Desc");
    store.update("2", { addBlockedBy: ["1"] });
    widget.update();

    const lines = renderWidget(ui.state);
    const blockedLine = lines.find(l => l.includes("Blocked"));
    expect(blockedLine).toContain("blocked by #1");
  });

  it("hides completed blockers in blocked-by suffix", () => {
    store.create("Blocker", "Desc");
    store.create("Blocked", "Desc");
    store.update("2", { addBlockedBy: ["1"] });
    store.update("1", { status: "completed" });
    widget.update();

    const lines = renderWidget(ui.state);
    const blockedLine = lines.find(l => l.includes("Blocked"));
    expect(blockedLine).not.toContain("blocked by");
  });

  it("distinguishes ready and blocked tasks in the status summary", () => {
    store.create("Done task", "Desc");
    store.create("Active task", "Desc");
    store.create("Ready task", "Desc");
    store.create("Blocked task", "Desc");
    store.update("1", { status: "completed" });
    store.update("2", { status: "in_progress" });
    store.update("4", { addBlockedBy: ["2"] });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[0]).toBe("● 4 tasks (1 done, 1 active, 1 ready, 1 blocked)");
  });

  it("separates parent roll-ups from subtask execution in the status summary", () => {
    const parent = store.create("Recover rollout", "Desc");
    store.update(parent.id, { status: "in_progress" });
    const running = store.createSubtask(parent.id, "Record root cause", "Desc");
    const worker = store.createSubtask(parent.id, "Fix probes", "Desc");
    const config = store.createSubtask(parent.id, "Fix ConfigMap", "Desc");
    const validation = store.createSubtask(parent.id, "Validate recovery", "Desc");
    store.update(running.id, { status: "in_progress" });
    store.update(worker.id, { addBlockedBy: [running.id] });
    store.update(config.id, { addBlockedBy: [running.id] });
    store.update(validation.id, { addBlockedBy: [worker.id, config.id] });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[0]).toBe("● 1 active task · 4 subtasks (1 running, 3 blocked)");
  });

  it.each<AutoClearMode>(["oldest", "on_task_complete"])(
    "counts all six subtasks when only four are displayed with %s cleanup",
    mode => {
      widget = new TaskWidget(store, { sortOrder: "status", hiddenAt: "top", maxVisible: 5 });
      widget.setUICtx(ui.ctx);
      const manager = new AutoClearManager(() => store, () => mode, 4, () => 5);
      const parent = store.create("Audit cleanup", "Desc");
      store.update(parent.id, { status: "in_progress" });
      const subtasks = Array.from({ length: 6 }, (_, i) =>
        store.createSubtask(parent.id, `Step ${i + 1}`, "Desc")
      );
      for (const task of subtasks.slice(0, 3)) {
        store.update(task.id, { status: "completed" });
        manager.trackCompletion(task.id, 1);
      }
      store.update(subtasks[3].id, { status: "in_progress" });
      store.update(subtasks[4].id, { addBlockedBy: [subtasks[3].id] });
      store.update(subtasks[5].id, { addBlockedBy: [subtasks[4].id] });
      manager.onTaskListChanged();
      manager.onTurnStart(5);
      widget.update();

      const lines = renderWidget(ui.state);
      expect(lines[0]).toBe("● 1 active task · 6 subtasks (3 done, 1 running, 2 blocked)");
      expect(lines[1]).toContain("2 more");
      expect(lines.filter(line => line.includes("Step"))).toHaveLength(4);
      expect(lines.some(line => line.includes("Step 1"))).toBe(false);
      expect(lines.some(line => line.includes("Step 2"))).toBe(false);
    },
  );

  it.each<AutoClearMode>(["never", "oldest", "on_task_complete", "on_list_complete"])(
    "counts hidden completed and nested subtasks across multiple parents with %s cleanup",
    mode => {
      widget.dispose();
      const config: TasksConfig = { sortOrder: "status", hiddenAt: "top", maxVisible: 9 };
      widget = new TaskWidget(store, config);
      widget.setUICtx(ui.ctx);
      const manager = new AutoClearManager(() => store, () => mode, 4, () => 9);
      const first = store.create("First workflow", "Desc");
      const second = store.create("Second workflow", "Desc");
      store.update(first.id, { status: "in_progress" });
      store.update(second.id, { status: "in_progress" });
      const steps = Array.from({ length: 8 }, (_, i) =>
        store.createSubtask(first.id, `Step ${i + 1}`, "Desc")
      );
      for (const task of steps.slice(0, 5)) {
        store.update(task.id, { status: "completed" });
        manager.trackCompletion(task.id, 1);
      }
      store.update(steps[5].id, { addBlockedBy: [steps[6].id, steps[7].id] });
      const running = store.createSubtask(second.id, "Wire workflow", "Desc");
      store.update(running.id, { status: "in_progress" });
      const done = store.createSubtask(second.id, "Verify entrypoints", "Desc");
      store.update(done.id, { status: "completed" });
      manager.trackCompletion(done.id, 1);
      store.createSubtask(running.id, "Map admission", "Desc");
      store.createSubtask(running.id, "Map readiness", "Desc");
      manager.onTaskListChanged();
      manager.onTurnStart(5);
      widget.update();

      const lines = renderWidget(ui.state);
      const summary = "● 2 active tasks · 12 subtasks (6 done, 1 running, 4 ready, 1 blocked)";
      expect(lines[0]).toBe(summary);
      expect(lines[1]).toContain("5 more");
      expect(renderedTaskRows(lines).map(row => row.id)).toEqual([
        "1", "1.6", "1.7", "1.8", "2", "2.2", "2.1", "2.1.1", "2.1.2",
      ]);
      expect(lines.filter(line => line.includes("✔"))).toHaveLength(1);

      // Visibility changes must never change the total or any status count.
      for (const sortOrder of ["id", "status", "recent", "oldest"] as const) {
        config.sortOrder = sortOrder;
        for (const hiddenAt of ["top", "bottom"] as const) {
          config.hiddenAt = hiddenAt;
          expect(renderWidget(ui.state)[0]).toBe(summary);
        }
      }
      config.showAll = true;
      const allLines = renderWidget(ui.state);
      expect(allLines[0]).toBe(summary);
      expect(renderedTaskRows(allLines)).toHaveLength(14);
      expect(allLines.some(line => line.includes("more"))).toBe(false);
    },
  );

  it.each([
    { sortOrder: "id", ids: ["1", "1.1", "1.1.1", "1.2", "2", "2.1", "2.2"] },
    { sortOrder: "status", ids: ["1", "1.2", "1.1", "1.1.1", "2", "2.2", "2.1"] },
    { sortOrder: "recent", ids: ["2", "2.2", "2.1", "1", "1.2", "1.1", "1.1.1"] },
    { sortOrder: "oldest", ids: ["1", "1.1", "1.1.1", "1.2", "2", "2.1", "2.2"] },
  ] as const)("groups and indents descendants beneath parents in $sortOrder order", ({ sortOrder, ids }) => {
    widget.dispose();
    widget = new TaskWidget(store, { sortOrder, showAll: true, maxVisible: 2 });
    widget.setUICtx(ui.ctx);
    store.create("First parent", "Desc");
    store.create("Second parent", "Desc");
    store.createSubtask("1", "First pending", "Desc");
    store.createSubtask("1", "First done", "Desc");
    store.createSubtask("2", "Second running", "Desc");
    store.createSubtask("2", "Second done", "Desc");
    store.createSubtask("1.1", "Nested done", "Desc");
    store.update("1", { status: "in_progress" });
    store.update("2.1", { status: "in_progress" });
    for (const id of ["1.2", "2.2", "1.1.1"]) store.update(id, { status: "completed" });
    widget.setActiveTask("2.1");

    const lines = renderWidget(ui.state);
    expect(renderedTaskRows(lines)).toEqual(ids.map(id => ({ id, indent: id.split(".").length * 2 })));
    expect(lines.find(line => line.includes("#2.1 "))).toContain("Second running…");
    expect(lines.some(line => line.includes("more"))).toBe(false);
  });

  it.each([
    { sortOrder: "recent", ids: ["1", "1.2", "1.1", "2", "2.1"] },
    { sortOrder: "oldest", ids: ["2", "2.1", "1", "1.1", "1.2"] },
  ] as const)("sorts parents and siblings by their own update times in $sortOrder order", ({ sortOrder, ids }) => {
    widget.dispose();
    widget = new TaskWidget(store, { sortOrder, showAll: true });
    widget.setUICtx(ui.ctx);
    store.create("First parent", "Desc");
    vi.advanceTimersByTime(1000);
    store.createSubtask("1", "Older child", "Desc");
    vi.advanceTimersByTime(1000);
    store.create("Second parent", "Desc");
    vi.advanceTimersByTime(1000);
    store.createSubtask("2", "Other child", "Desc");
    vi.advanceTimersByTime(1000);
    store.createSubtask("1", "Newer child", "Desc");
    vi.advanceTimersByTime(1000);
    store.update("1", { subject: "Updated first parent" });
    widget.update();

    expect(renderedTaskRows(renderWidget(ui.state)).map(row => row.id)).toEqual(ids);
  });

  it.each<TasksConfig>([
    { sortOrder: "id", hiddenAt: "top" },
    { sortOrder: "recent", hiddenAt: "bottom" },
    { sortOrder: "oldest", hiddenAt: "top" },
    { sortOrder: "status", hiddenAt: "top" },
    { sortOrder: "status", hiddenAt: "bottom" },
  ])("keeps the full ancestor chain visible with $sortOrder order and $hiddenAt hiding", config => {
    widget.dispose();
    widget = new TaskWidget(store, { ...config, maxVisible: 1 });
    widget.setUICtx(ui.ctx);
    store.create("Unrelated task", "Desc");
    store.create("Parent", "Desc");
    store.createSubtask("2", "Child", "Desc");
    store.createSubtask("2.1", "Grandchild", "Desc");
    const completedIds = config.sortOrder === "status" && config.hiddenAt === "bottom"
      ? ["2.1.1"]
      : ["1", "2", "2.1"];
    for (const id of completedIds) store.update(id, { status: "completed" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(renderedTaskRows(lines)).toEqual([
      { id: "2", indent: 2 }, { id: "2.1", indent: 4 }, { id: "2.1.1", indent: 6 },
    ]);
    expect(lines[config.hiddenAt === "top" ? 1 : lines.length - 1]).toContain("1 more");
    expect(renderWidget(ui.state)).toEqual(lines);
  });

  it("keeps orphaned branches visible without placing them under an unrelated task", () => {
    store.create("Deleted parent", "Desc");
    store.createSubtask("1", "Orphan", "Desc");
    store.createSubtask("1.1", "Nested child", "Desc");
    store.create("Other parent", "Desc");
    store.delete("1");
    widget.update();

    expect(renderedTaskRows(renderWidget(ui.state))).toEqual([
      { id: "1.1", indent: 2 }, { id: "1.1.1", indent: 4 }, { id: "2", indent: 2 },
    ]);
  });

  it("renders each task once even with cyclic or self-referencing parent links", () => {
    const parent = store.create("Cyclic parent", "Desc");
    const child = store.createSubtask(parent.id, "Cyclic child", "Desc");
    store.create("Normal task", "Desc");
    const self = store.create("Self parent", "Desc");
    parent.parentTaskId = child.id;
    self.parentTaskId = self.id;
    widget.update();

    const rows = renderedTaskRows(renderWidget(ui.state));
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map(row => row.id))).toEqual(new Set(["1", "1.1", "2", "3"]));
  });

  it("clears widget when all tasks are deleted", () => {
    store.create("Task", "Desc");
    widget.update();
    expect(ui.state.widgets.get("tasks")?.content).toBeDefined();

    store.update("1", { status: "deleted" });
    widget.update();
    expect(ui.state.widgets.get("tasks")?.content).toBeUndefined();
  });

  it("limits visible tasks to MAX_VISIBLE_TASKS", () => {
    for (let i = 0; i < 15; i++) {
      store.create(`Task ${i + 1}`, "Desc");
    }
    widget.update();

    const lines = renderWidget(ui.state);
    // header + 10 tasks + "… and 5 more"
    expect(lines).toHaveLength(12);
    expect(lines[11]).toContain("5 more");
  });

  it("respects maxVisible config", () => {
    widget = new TaskWidget(store, { maxVisible: 5 });
    widget.setUICtx(ui.ctx);
    for (let i = 0; i < 15; i++) {
      store.create(`Task ${i + 1}`, "Desc");
    }
    widget.update();

    const lines = renderWidget(ui.state);
    // header + 5 tasks + "… and 10 more"
    expect(lines).toHaveLength(7);
    expect(lines[6]).toContain("10 more");
  });

  it("shows all tasks when limit exceeds task count", () => {
    widget = new TaskWidget(store, { maxVisible: 10 });
    widget.setUICtx(ui.ctx);
    for (let i = 0; i < 3; i++) {
      store.create(`Task ${i + 1}`, "Desc");
    }
    widget.update();

    const lines = renderWidget(ui.state);
    // header + 3 tasks, no overflow
    expect(lines).toHaveLength(4);
    expect(lines[lines.length - 1]).not.toContain("more");
  });

  it("shows all tasks when showAll is true even with maxVisible set", () => {
    widget = new TaskWidget(store, { showAll: true, maxVisible: 5 });
    widget.setUICtx(ui.ctx);
    for (let i = 0; i < 15; i++) {
      store.create(`Task ${i + 1}`, "Desc");
    }
    widget.update();

    const lines = renderWidget(ui.state);
    // header + 15 tasks, no overflow line
    expect(lines).toHaveLength(16);
    expect(lines[lines.length - 1]).not.toContain("more");
  });

  it("truncates from top when hiddenAt is 'top'", () => {
    widget = new TaskWidget(store, { sortOrder: "status", hiddenAt: "top", showAll: false, maxVisible: 5 });
    widget.setUICtx(ui.ctx);
    // 4 completed, 2 in_progress, 2 pending = 8 total, limit 5
    for (let i = 1; i <= 4; i++) store.create(`Done ${i}`, "Desc");
    for (let i = 1; i <= 2; i++) store.create(`Working ${i}`, "Desc");
    for (let i = 1; i <= 2; i++) store.create(`Todo ${i}`, "Desc");
    for (let i = 1; i <= 4; i++) store.update(String(i), { status: "completed" });
    for (let i = 5; i <= 6; i++) store.update(String(i), { status: "in_progress" });
    widget.update();

    const lines = renderWidget(ui.state);
    // header + overflow line + 5 visible = 7 lines
    expect(lines).toHaveLength(7);
    // overflow at top (after header)
    expect(lines[1]).toContain("3 more");
    // all in_progress and pending visible
    expect(lines.some(l => l.includes("Working 1"))).toBe(true);
    expect(lines.some(l => l.includes("Todo 2"))).toBe(true);
    // only newest completed (#4) visible
    expect(lines.some(l => l.includes("Done 4"))).toBe(true);
    // oldest completed hidden
    expect(lines.some(l => l.includes("Done 1"))).toBe(false);
    expect(lines.some(l => l.includes("Done 3"))).toBe(false);
  });

  it("keeps every unfinished task visible with status order and top truncation", () => {
    widget = new TaskWidget(store, { sortOrder: "status", hiddenAt: "top", showAll: false, maxVisible: 5 });
    widget.setUICtx(ui.ctx);
    // 2 completed + 6 unfinished exceeds the configured limit.
    for (let i = 1; i <= 2; i++) store.create(`Done ${i}`, "Desc");
    for (let i = 1; i <= 2; i++) store.create(`Working ${i}`, "Desc");
    for (let i = 1; i <= 4; i++) store.create(`Todo ${i}`, "Desc");
    for (let i = 1; i <= 2; i++) store.update(String(i), { status: "completed" });
    for (let i = 3; i <= 4; i++) store.update(String(i), { status: "in_progress" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("2 more");
    for (let i = 1; i <= 2; i++) {
      expect(lines.some(l => l.includes(`Working ${i}`))).toBe(true);
    }
    for (let i = 1; i <= 4; i++) {
      expect(lines.some(l => l.includes(`Todo ${i}`))).toBe(true);
    }
    expect(lines.some(l => l.includes("Done"))).toBe(false);
  });

  it("truncates from bottom by default", () => {
    widget = new TaskWidget(store, { maxVisible: 3 });
    widget.setUICtx(ui.ctx);
    for (let i = 1; i <= 5; i++) store.create(`Task ${i}`, "Desc");
    widget.update();

    const lines = renderWidget(ui.state);
    // header + 3 tasks + overflow at bottom = 5 lines
    expect(lines).toHaveLength(5);
    expect(lines[1]).toContain("Task 1");
    expect(lines[3]).toContain("Task 3");
    expect(lines[4]).toContain("2 more");
    expect(lines.some(l => l.includes("Task 4"))).toBe(false);
  });

  it("sorts tasks by status when sortOrder is 'status'", () => {
    widget = new TaskWidget(store, { sortOrder: "status" });
    widget.setUICtx(ui.ctx);
    store.create("Pending task", "Desc");           // #1
    store.create("Completed task", "Desc");         // #2
    store.create("In progress task", "Desc");       // #3
    store.update("2", { status: "completed" });
    store.update("3", { status: "in_progress" });
    widget.update();

    const lines = renderWidget(ui.state);
    // header + 3 tasks: completed, in_progress, pending
    expect(lines[1]).toContain("Completed task");
    expect(lines[2]).toContain("In progress task");
    expect(lines[3]).toContain("Pending task");
  });

  it("defaults to ID order when sortOrder is unset", () => {
    store.create("Pending task", "Desc");           // #1
    store.create("Completed task", "Desc");         // #2
    store.create("In progress task", "Desc");       // #3
    store.update("2", { status: "completed" });
    store.update("3", { status: "in_progress" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("Pending task");
    expect(lines[2]).toContain("Completed task");
    expect(lines[3]).toContain("In progress task");
  });

  it("keeps ID order when sortOrder is 'id'", () => {
    widget = new TaskWidget(store, { sortOrder: "id" });
    widget.setUICtx(ui.ctx);
    store.create("Pending task", "Desc");           // #1
    store.create("Completed task", "Desc");         // #2
    store.create("In progress task", "Desc");       // #3
    store.update("2", { status: "completed" });
    store.update("3", { status: "in_progress" });
    widget.update();

    const lines = renderWidget(ui.state);
    // ID order: #1 pending, #2 completed, #3 in_progress
    expect(lines[1]).toContain("Pending task");
    expect(lines[2]).toContain("Completed task");
    expect(lines[3]).toContain("In progress task");
  });

  it("tracks token usage for active tasks", () => {
    store.create("Active task", "Desc", "Running");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    widget.addTokenUsage(1000, 500);
    widget.addTokenUsage(500, 300);
    vi.advanceTimersByTime(10_000);

    const lines = renderWidget(ui.state);
    const activeLine = lines.find(l => l.includes("Running…"));
    expect(activeLine).toContain("↑1.5k");
    expect(activeLine).toContain("↓800");
    expect(activeLine).toContain("Σ2.3k");
    expect(activeLine).toContain("80.0 t/s");
  });

  it("aggregates and persists cache usage across turns", () => {
    store.create("Cached task", "Desc", "Using cache");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    widget.addTokenUsage(1000, 500, 0, 4500, 3000, 0);
    widget.addTokenUsage(500, 300, 0, 2300, 500, 1000);

    let lines = renderWidget(ui.state);
    let taskLine = lines.find(l => l.includes("Using cache…"));
    expect(taskLine).toContain("Σ6.8k ⨀58.3%");

    store.update("1", { status: "completed" });
    widget.setActiveTask("1", false);

    expect(store.get("1")!.metadata.executionStats).toMatchObject({
      inputTokens: 1500,
      outputTokens: 800,
      cacheReadTokens: 3500,
      cacheWriteTokens: 1000,
      totalTokens: 6800,
    });
    lines = renderWidget(ui.state);
    taskLine = lines.find(l => l.includes("Cached task"));
    expect(taskLine).toContain("Σ6.8k ⨀58.3%");
  });

  it("tracks and renders model cost for active and completed tasks", () => {
    store.create("Costed task", "Desc", "Running costed work");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    widget.addTokenUsage(1000, 500, 0.0123, 4500, 3000, 0);

    let lines = renderWidget(ui.state);
    let taskLine = lines.find(l => l.includes("Running costed work…"));
    expect(taskLine).toContain("Σ4.5k ⨀75.0%");
    expect(taskLine).toContain("$0.01");

    store.update("1", { status: "completed" });
    widget.setActiveTask("1", false);

    expect(store.get("1")!.metadata.executionStats).toMatchObject({
      cacheReadTokens: 3000,
      cacheWriteTokens: 0,
      totalTokens: 4500,
      costUsd: 0.0123,
    });
    lines = renderWidget(ui.state);
    taskLine = lines.find(l => l.includes("Costed task"));
    expect(taskLine).toContain("Σ4.5k ⨀75.0%");
    expect(taskLine).toContain("$0.01");
  });

  it("preserves persisted start time and tokens when a resumed task becomes active", () => {
    vi.setSystemTime(new Date("2026-04-13T15:06:00Z"));
    store.create("Resumed active", "Desc", "Continuing", {
      executionStats: {
        startedAt: Date.parse("2026-04-13T15:04:00Z"),
        inputTokens: 1000,
        outputTokens: 500,
        costUsd: 0.0042,
      },
    });
    store.update("1", { status: "in_progress" });

    widget.setActiveTask("1", true);
    widget.addTokenUsage(250, 125, 0.0021);

    const lines = renderWidget(ui.state);
    const activeLine = lines.find(l => l.includes("Continuing…"));
    expect(activeLine).toContain("Δ2:00");
    expect(activeLine).toContain("↑1.3k");
    expect(activeLine).toContain("↓625");
    expect(activeLine).toContain("Σ1.9k");
    expect(activeLine).toContain("5.2 t/s");
    expect(activeLine).toContain("$0.01");

    store.update("1", { status: "completed" });
    widget.setActiveTask("1", false);

    expect(store.get("1")!.metadata.executionStats).toMatchObject({
      startedAt: Date.parse("2026-04-13T15:04:00Z"),
      inputTokens: 1250,
      outputTokens: 625,
      totalTokens: 1875,
      costUsd: 0.0063,
    });
  });

  it("deactivates a task with setActiveTask(id, false)", () => {
    store.create("Task", "Desc", "Doing work");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    // Should be active (spinner)
    let lines = renderWidget(ui.state);
    expect(lines[1]).toContain("Doing work…");

    widget.setActiveTask("1", false);
    lines = renderWidget(ui.state);
    // Should now show as regular in_progress (◼)
    expect(lines[1]).toContain("◼");
    expect(lines[1]).not.toContain("Doing work…");
  });

  it("prunes stale active IDs on update", () => {
    store.create("Task", "Desc");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    // Complete the task externally
    store.update("1", { status: "completed" });
    widget.update();

    // Should render as completed, not active
    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("✔");
    expect(lines[1]).toContain("~~#1 Task~~");
  });

  it("supports multiple active tasks simultaneously", () => {
    store.create("Task A", "Desc", "Processing A");
    store.create("Task B", "Desc", "Processing B");
    store.update("1", { status: "in_progress" });
    store.update("2", { status: "in_progress" });
    widget.setActiveTask("1", true);
    widget.setActiveTask("2", true);

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("Processing A…");
    expect(lines[2]).toContain("Processing B…");
  });

  it("rolls up hidden completed descendants without replacing the parent's own counters", () => {
    widget.dispose();
    widget = new TaskWidget(store, { maxVisible: 1 });
    widget.setUICtx(ui.ctx);
    const startedAt = new Date(2026, 3, 13, 13, 0, 0).getTime();
    vi.setSystemTime(startedAt + 60_000);
    store.create("Parent", "Desc", undefined, {
      executionStats: {
        startedAt, activeDurationMs: 10_000,
        inputTokens: 100, outputTokens: 100, totalTokens: 200, costUsd: 1,
      },
    });
    store.update("1", { status: "in_progress" });
    store.createSubtask("1", "Child", "Desc", undefined, {
      executionStats: {
        startedAt, completedAt: startedAt + 20_000, durationMs: 20_000,
        activeDurationMs: 10_000, inputTokens: 100, outputTokens: 200,
        cacheReadTokens: 600, cacheWriteTokens: 200, totalTokens: 1100, costUsd: 2,
      },
    });
    store.update("1.1", { status: "completed" });
    store.createSubtask("1.1", "Grandchild", "Desc", undefined, {
      executionStats: {
        startedAt, completedAt: startedAt + 30_000, durationMs: 30_000,
        activeDurationMs: 10_000, inputTokens: 100, outputTokens: 300,
        cacheReadTokens: 300, totalTokens: 700, costUsd: 3,
      },
    });
    store.update("1.1.1", { status: "completed" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("Δ1:00 · ↑300 ↓600 Σ2k ⨀64.3% · 20.0 t/s · $6.00");
    expect(lines[1]).toContain("legacy overlap possible");
    expect(lines[2]).toContain("and 2 more");
    expect(store.get("1")!.metadata.executionStats?.totalTokens).toBe(200);
    expect(renderWidget(ui.state)).toEqual(lines);
  });

  it("counts shared foreground work once across active parents and siblings", () => {
    store.create("Parent", "Desc", "Parent");
    store.createSubtask("1", "Child A", "Desc", "Child A");
    store.createSubtask("1", "Child B", "Desc", "Child B");
    for (const id of ["1", "1.1", "1.2"]) {
      store.update(id, { status: "in_progress" });
      widget.setActiveTask(id);
    }
    vi.advanceTimersByTime(10_000);
    widget.addTokenUsage(100, 50, 1, 400, 200, 50);
    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("↑100 ↓50 Σ400 ⨀57.1% · 5.0 t/s · $1.00");
    expect(lines[2]).toContain("↑50 ↓25 Σ200 ⨀57.1% · 5.0 t/s · $0.50");
    expect(lines[3]).toContain("↑50 ↓25 Σ200 ⨀57.1% · 5.0 t/s · $0.50");
    expect(lines.join("\n")).not.toContain("legacy overlap possible");
  });

  it("preserves inclusive totals through completion, idle time, and widget recreation", () => {
    store.create("Parent", "Desc");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1");
    vi.advanceTimersByTime(10_000);
    widget.addTokenUsage(10, 100, 1);

    store.createSubtask("1", "Child", "Desc");
    store.update("1.1", { status: "in_progress" });
    widget.setActiveTask("1.1");
    vi.advanceTimersByTime(20_000);
    widget.addTokenUsage(20, 200, 2);
    store.update("1.1", { status: "completed" });
    widget.setActiveTask("1.1", false);

    widget.setAgentActive(false);
    vi.advanceTimersByTime(60_000);
    expect(renderWidget(ui.state)[1]).toContain("↑30 ↓300 Σ330 · 10.0 t/s · $3.00");
    widget.setAgentActive(true);
    vi.advanceTimersByTime(10_000);
    widget.addTokenUsage(10, 100, 1);
    store.update("1", { status: "completed" });
    widget.setActiveTask("1", false);

    expect(store.get("1")!.metadata.executionStats).toMatchObject({
      inputTokens: 20, outputTokens: 200, totalTokens: 220, costUsd: 2, activeDurationMs: 20_000,
    });
    const before = renderWidget(ui.state);
    expect(before[1]).toContain("Δ1:40 · ↑40 ↓400 Σ440 · 10.0 t/s · $4.00");
    expect(before[2]).toContain("Δ0:20 · ↑20 ↓200 Σ220 · 10.0 t/s · $2.00");
    widget.dispose();
    widget = new TaskWidget(store);
    widget.setUICtx(ui.ctx);
    widget.update();
    expect(renderWidget(ui.state)).toEqual(before);
  });

  it("does not reuse another session's live counters when task IDs match", () => {
    store.create("Old session", "Desc");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1");
    widget.addTokenUsage(10, 100, 1);
    const otherStore = new TaskStore();
    otherStore.create("New session", "Desc", undefined, {
      executionStats: { startedAt: Date.now(), totalTokens: 500, costUsd: 2 },
    });
    otherStore.update("1", { status: "in_progress" });
    widget.setStore(otherStore);
    widget.update();
    expect(widget.getExecutionStats().get("1")).toMatchObject({ totalTokens: 500, costUsd: 2 });
    expect(store.get("1")!.metadata.executionStats).toMatchObject({ totalTokens: 110, costUsd: 1 });
  });

  it("adds independently recorded background usage without charging it foreground work", () => {
    store.create("Parent", "Desc");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1");
    store.createSubtask("1", "Background", "Desc", undefined, {
      agentId: "background-agent",
      executionStats: {
        usageAttribution: "exclusive", startedAt: Date.now() - 20_000, activeDurationMs: 20_000,
        inputTokens: 20, outputTokens: 200, totalTokens: 220, costUsd: 2,
      },
    });
    store.update("1.1", { status: "in_progress" });
    widget.setActiveTask("1.1");
    vi.advanceTimersByTime(10_000);
    widget.addTokenUsage(10, 100, 1);
    expect(widget.getExecutionStats().get("1.1")).toMatchObject({
      inputTokens: 20, outputTokens: 200, totalTokens: 220, costUsd: 2, activeDurationMs: 30_000,
    });
    expect(renderWidget(ui.state)[1]).toContain("↑30 ↓300 Σ330 · 7.5 t/s · $3.00");
  });

  it("does not invent active time for a parent completed without direct work", () => {
    store.create("Parent", "Desc");
    vi.advanceTimersByTime(10_000);
    store.createSubtask("1", "Child", "Desc");
    store.update("1.1", { status: "in_progress" });
    widget.setActiveTask("1.1");
    vi.advanceTimersByTime(20_000);
    widget.addTokenUsage(20, 200);
    store.update("1.1", { status: "completed" });
    widget.setActiveTask("1.1", false);
    store.update("1", { status: "completed" });
    widget.setActiveTask("1", false);
    expect(widget.getExecutionStats().get("1")).toMatchObject({
      totalTokens: 220, activeDurationMs: 20_000, durationMs: 30_000,
    });
    expect(renderWidget(ui.state)[1]).toContain("10.0 t/s");
  });

  it("preserves reported partial counters when completing a task without live metrics", () => {
    store.create("Reported task", "Desc", undefined, {
      executionStats: { startedAt: Date.now(), inputTokens: 30, outputTokens: 200, costUsd: 1 },
    });
    vi.advanceTimersByTime(20_000);
    store.update("1", { status: "completed" });
    widget.setActiveTask("1", false);
    expect(store.get("1")!.metadata.executionStats).toMatchObject({
      totalTokens: 230, activeDurationMs: 20_000, durationMs: 20_000, costUsd: 1,
    });
    expect(store.get("1")!.metadata.executionStats?.usageAttribution).toBeUndefined();
    expect(renderWidget(ui.state)[1]).toContain("↑30 ↓200 Σ230 · 10.0 t/s · $1.00");
  });

  it("allocates odd token counts without losing remainders", () => {
    store.create("Parent", "Desc");
    for (let i = 0; i < 3; i++) {
      const child = store.createSubtask("1", `Child ${i}`, "Desc");
      store.update(child.id, { status: "in_progress" });
      widget.setActiveTask(child.id);
    }
    vi.advanceTimersByTime(9000);
    widget.addTokenUsage(101, 51, 1, 407, 202, 53);
    const stats = widget.getExecutionStats().get("1")!;
    expect(stats).toMatchObject({
      inputTokens: 101, outputTokens: 51, totalTokens: 407, cacheReadTokens: 202,
      cacheWriteTokens: 53, activeDurationMs: 9000,
    });
    expect(stats.costUsd).toBeCloseTo(1);
  });

  it("splits foreground token usage across active tasks", () => {
    store.create("Task A", "Desc", "A");
    store.create("Task B", "Desc", "B");
    store.update("1", { status: "in_progress" });
    store.update("2", { status: "in_progress" });
    widget.setActiveTask("1", true);
    widget.setActiveTask("2", true);

    widget.addTokenUsage(100, 50);

    const lines = renderWidget(ui.state);
    // A single foreground turn is allocated, not copied to every task.
    expect(lines[1]).toContain("↑50");
    expect(lines[1]).toContain("Σ75");
    expect(lines[2]).toContain("↑50");
    expect(lines[2]).toContain("Σ75");
  });

  it("dispose clears widget and timer", () => {
    store.create("Task", "Desc");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    widget.dispose();
    expect(ui.state.widgets.get("tasks")?.content).toBeUndefined();
  });

  it("uses subject as fallback when no activeForm", () => {
    store.create("My Subject", "Desc");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("My Subject…");
  });

  it("shows start time and elapsed time but no token arrows when tokens are zero", () => {
    vi.setSystemTime(new Date("2026-04-13T15:04:00Z"));
    store.create("No tokens", "Desc", "Working");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    // No addTokenUsage calls — tokens stay at 0
    vi.advanceTimersByTime(5000);
    widget.update();

    const lines = renderWidget(ui.state);
    const activeLine = lines.find(l => l.includes("Working…"));
    expect(activeLine).toMatch(/\(\d{2}:\d{2}:\d{2} Δ0:05\)$/);
    expect(activeLine).not.toContain("↑");
    expect(activeLine).not.toContain("↓");
  });

  it("cleans up metrics when stale active IDs are pruned", () => {
    store.create("Task", "Desc", "Running");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);
    widget.addTokenUsage(100, 50);

    // Delete task externally
    store.update("1", { status: "deleted" });
    widget.update();

    // Reactivate with same ID (new task) — should get fresh metrics
    store.create("Task 2", "Desc", "Running");  // ID 2
    store.update("2", { status: "in_progress" });
    widget.setActiveTask("2", true);

    const lines = renderWidget(ui.state);
    // Should not carry over old tokens
    expect(lines[1]).not.toContain("↑100");
  });

  it("indents task lines under header", () => {
    store.create("Indented task", "Desc");
    widget.update();

    const lines = renderWidget(ui.state);
    // Task line should start with 2 spaces
    expect(lines[1]).toMatch(/^\s{2}/);
  });

  it("widget is placed aboveEditor", () => {
    store.create("Task", "Desc");
    widget.update();

    const entry = ui.state.widgets.get("tasks");
    expect(entry?.options?.placement).toBe("aboveEditor");
  });
});

describe("compact duration (via widget rendering)", () => {
  let store: TaskStore;
  let widget: TaskWidget;
  let ui: ReturnType<typeof mockUICtx>;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new TaskStore();
    widget = new TaskWidget(store);
    ui = mockUICtx();
    widget.setUICtx(ui.ctx);
  });

  afterEach(() => {
    widget.dispose();
    vi.useRealTimers();
  });

  it("shows seconds for short durations", () => {
    store.create("Quick", "Desc", "Working");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    vi.advanceTimersByTime(30_000); // 30s
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("Δ0:30");
  });

  it("shows hours for long durations", () => {
    store.create("Long", "Desc", "Working");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    vi.advanceTimersByTime(3_723_000); // 1h 2m 3s → "1:02:03"
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("Δ1:02:03");
  });

  it("shows exact hours without minutes", () => {
    store.create("Exact", "Desc", "Working");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    vi.advanceTimersByTime(7_200_000); // 2h exactly
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("Δ2:00:00)");
  });

  it("shows minutes and seconds", () => {
    store.create("Medium", "Desc", "Working");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    vi.advanceTimersByTime(169_000); // 2m 49s
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("Δ2:49");
  });

  it("formats small token counts without k suffix", () => {
    store.create("Small", "Desc", "Working");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    widget.addTokenUsage(500, 200);
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("↑500");
    expect(lines[1]).toContain("↓200");
    expect(lines[1]).toContain("Σ700");
  });

  it("formats token counts with k suffix and removes .0", () => {
    store.create("Large", "Desc", "Working");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    widget.addTokenUsage(2000, 4100);
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("↑2k");    // 2000 → "2k" (not "2.0k")
    expect(lines[1]).toContain("↓4.1k");  // 4100 → "4.1k"
    expect(lines[1]).toContain("Σ6.1k");
  });
});
