/**
 * settings-menu.ts — Polished settings panel for /tasks → Settings.
 *
 * Uses ui.custom() + SettingsList for native TUI rendering with keyboard
 * navigation, live toggle, and per-row descriptions — matching pi-coding-agent's
 * own settings panel style.
 */

import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import { saveTasksConfig, type TasksConfig } from "../tasks-config.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type SettingsUI = {
  custom<T>(
    factory: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => any,
    options?: { overlay?: boolean; overlayOptions?: any },
  ): Promise<T>;
};

// ── Settings panel ──────────────────────────────────────────────────────────

export async function openSettingsMenu(
  ui: SettingsUI,
  cfg: TasksConfig,
  onBack: () => Promise<void>,
  clearDelayTurns: number,
  onConfigChange?: () => void,
): Promise<void> {
  const persistConfig = () => {
    saveTasksConfig(cfg);
    onConfigChange?.();
  };

  await ui.custom((_tui, theme, _kb, done) => {
    const items: SettingItem[] = [
      {
        id: "taskScope",
        label: "Task storage",
        description:
          "memory: tasks live only in memory, lost when session ends. " +
          "session: persisted per session (tasks-<sessionId>.json), survives resume. " +
          "project: shared across all sessions (tasks.json). " +
          "Takes effect on next session start.",
        currentValue: cfg.taskScope ?? "session",
        values: ["memory", "session", "project"],
      },
      {
        id: "taskCreationMode",
        label: "Prompt task creation",
        description:
          "model: let the agent decide when task tracking helps. " +
          "manual: never inject task reminders or create prompt tasks automatically. " +
          "always: create one prompt-level in-progress task for every user prompt and complete it when the agent turn ends.",
        currentValue: cfg.taskCreationMode ?? "model",
        values: ["model", "manual", "always"],
      },
      {
        id: "autoCascade",
        label: "Auto-execute with agents",
        description:
          "When ON: pending agent tasks start automatically once their dependencies complete. " +
          "When OFF: use TaskExecute to launch them manually.",
        currentValue: (cfg.autoCascade ?? false) ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "showAll",
        label: "Show all tasks in widget",
        description:
          "When ON, every task is shown regardless of the visible limit. " +
          "When OFF, the list is capped by 'Max visible tasks'.",
        currentValue: (cfg.showAll ?? false) ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "maxVisible",
        label: "Max visible tasks in widget",
        description:
          "For widget display, only applies when 'Show all tasks' is OFF. " +
          "The 'oldest' auto-clear mode also uses it as its cleanup limit. " +
          "Targets this many task lines; status order with top hiding may exceed it to keep unfinished tasks visible.",
        currentValue: String(cfg.maxVisible ?? 10),
        values: ["5", "10", "15", "20", "30", "50", "100"],
      },
      {
        id: "sortOrder",
        label: "Widget sort order",
        description:
          '"status" groups by completed → in-progress → pending. ' +
          '"id" sorts by creation order.',
        currentValue: cfg.sortOrder ?? "id",
        values: ["id", "status", "recent", "oldest"],
      },
      {
        id: "hiddenAt",
        label: "Hidden tasks position",
        description:
          '"bottom" hides tasks from the end of the list. ' +
          'With status order, "top" collapses only completed tasks so every unfinished task stays visible.',
        currentValue: cfg.hiddenAt ?? "bottom",
        values: ["bottom", "top"],
      },
      {
        id: "autoClearCompleted",
        label: "Auto-clear completed tasks",
        description:
          "never: completed tasks stay visible until manually cleared. " +
          "on_list_complete: cleared automatically after all tasks are done. " +
          "on_task_complete: each task cleared shortly after it completes. " +
          "oldest: when the task count exceeds 'Max visible tasks', clear the oldest completed tasks first. " +
          `Timed clearing modes lag ~${clearDelayTurns} turns.`,
        currentValue: cfg.autoClearCompleted ?? "on_list_complete",
        values: ["never", "on_list_complete", "on_task_complete", "oldest"],
      },
    ];

    const list = new SettingsList(
      items,
      /* maxVisible */ 10,
      getSettingsListTheme(),
      /* onChange */ (id, newValue) => {
        if (id === "taskCreationMode") {
          cfg.taskCreationMode = newValue as TasksConfig["taskCreationMode"];
          persistConfig();
        }
        if (id === "autoCascade") {
          cfg.autoCascade = newValue === "on";
          persistConfig();
        }
        if (id === "taskScope") {
          cfg.taskScope = newValue as "memory" | "session" | "project";
          persistConfig();
        }
        if (id === "autoClearCompleted") {
          cfg.autoClearCompleted = newValue as TasksConfig["autoClearCompleted"];
          persistConfig();
        }
        if (id === "showAll") {
          cfg.showAll = newValue === "on";
          persistConfig();
        }
        if (id === "maxVisible") {
          cfg.maxVisible = Number(newValue);
          persistConfig();
        }
        if (id === "sortOrder") {
          cfg.sortOrder = newValue as TasksConfig["sortOrder"];
          persistConfig();
        }
        if (id === "hiddenAt") {
          cfg.hiddenAt = newValue as "top" | "bottom";
          persistConfig();
        }
      },
      /* onCancel */ () => done(undefined),
    );

    // Container doesn't forward handleInput to children — subclass to fix.
    class SettingsPanel extends Container {
      handleInput(data: string) { list.handleInput(data); }
    }

    const root = new SettingsPanel();
    root.addChild(new Text(theme.bold(theme.fg("accent", "⚙  Task Settings")), 0, 0));
    root.addChild(new Spacer(1));
    root.addChild(list);

    return root;
  });

  return onBack();
}
