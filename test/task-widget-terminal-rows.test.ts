import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStore } from "../src/task-store.js";
import { TaskWidget, type Theme, type UICtx } from "../src/ui/task-widget.js";

const plainTheme: Theme = {
  fg: (_color, text) => text,
  bold: text => text,
  strikethrough: text => text,
};

const styledTheme: Theme = {
  fg: (_color, text) => `\x1b[33m${text}\x1b[39m`,
  bold: text => `\x1b[1m${text}\x1b[22m`,
  strikethrough: text => `\x1b[9m${text}\x1b[29m`,
};

const controlRuns = ["\n", "\r\n", "\r", "\t", "\b", "\v\f", "\x00\x1b\x1f", "\x7f\x85\x9f"];
const states = ["pending", "in_progress", "completed", "active-subject", "active-form"] as const;

for (const state of states) {
  describe(`terminal rows for ${state} tasks`, () => {
    let store: TaskStore;
    let widget: TaskWidget;
    let factory: Parameters<UICtx["setWidget"]>[1];

    beforeEach(() => {
      vi.useFakeTimers();
      store = new TaskStore();
      widget = new TaskWidget(store);
      widget.setUICtx({
        setWidget(_key, content) { factory = content; },
        setStatus() {},
      });
    });

    afterEach(() => {
      widget.dispose();
      vi.useRealTimers();
    });

    function render(columns = 314, theme = plainTheme): string[] {
      if (!factory) throw new Error("Task widget was not registered");
      return factory({ terminal: { columns }, requestRender() {} }, theme).render();
    }

    function createTask(subject: string, activeForm?: string, agentId?: string) {
      const task = store.create(
        subject, "Unchanged description\nwith details",
        state === "active-subject" ? undefined : activeForm, { agentId },
      );
      if (state !== "pending") {
        store.update(task.id, { status: state === "completed" ? "completed" : "in_progress" });
      }
      if (state.startsWith("active-")) widget.setActiveTask(task.id, true);
      widget.update();
      return task;
    }

    it.each(controlRuns)("keeps a title containing %j on one physical row", controls => {
      const text = `First${controls}second`;
      const task = createTask(state === "active-form" ? "Subject" : text, text);
      const lines = render();

      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain("First second");
      expect(lines[1]).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      expect(store.get(task.id)?.subject).toBe(state === "active-form" ? "Subject" : text);
      expect(store.get(task.id)?.activeForm).toBe(state === "active-subject" ? undefined : text);
      expect(store.get(task.id)?.description).toBe("Unchanged description\nwith details");
    });

    it.each([20, 80, 314])("respects a %i-column width after flattening multiline Unicode text", columns => {
      const text = `检查\n修复 👩‍💻 ${"界".repeat(180)}`;
      createTask(text, text);
      const lines = render(columns);

      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(line).not.toMatch(/[\r\n\t]/);
        expect(visibleWidth(line)).toBeLessThanOrEqual(columns);
      }
    });

    it("preserves theme styling while normalizing the displayed text", () => {
      createTask("First\nsecond", "First\nsecond");
      const lines = render(314, styledTheme);

      expect(lines[1]).toContain("\x1b[33m");
      if (state === "completed") expect(lines[1]).toContain("\x1b[9m");
      expect(stripVTControlCharacters(lines[1])).toContain("First second");
      expect(lines[1]).not.toMatch(/[\r\n]/);
    });

    if (state === "in_progress" || state.startsWith("active-")) {
      it("keeps a short agent label on the task row", () => {
        createTask("Subject", "Working", "ab\ncd");
        const lines = render();

        expect(lines).toHaveLength(2);
        expect(lines[1]).toContain("(agent ab cd)");
        expect(lines[1]).not.toMatch(/[\r\n]/);
      });
    }
  });
}
