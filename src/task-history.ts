/** Recover confirmed task mutations from an existing session's active branch. */
import type { CompletedTaskRecord, TaskStatus } from "./types.js";

interface HistoryEntry {
  type: string;
  message?: {
    role: string;
    content?: unknown;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function recoverCompletedTaskHistory(entries: readonly HistoryEntry[]): CompletedTaskRecord[] {
  const completed = new Set<string>();
  const updates = new Map<string, { taskId: string; status: TaskStatus | "deleted" }>();
  const observe = (id: string, status: string) => {
    if (status === "completed") completed.add(id);
    else completed.delete(id);
  };

  for (const entry of entries) {
    const message = entry.type === "message" ? entry.message : undefined;
    if (!message || !Array.isArray(message.content)) continue;
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (!isObject(block) || block.type !== "toolCall" || block.name !== "TaskUpdate") continue;
        const args = block.arguments;
        if (typeof block.id !== "string" || !isObject(args) || typeof args.taskId !== "string") continue;
        const status = args.status;
        if (status === "pending" || status === "in_progress" || status === "completed" || status === "deleted") {
          updates.set(block.id, { taskId: args.taskId, status });
        }
      }
      continue;
    }
    if (message.role !== "toolResult") continue;
    const update = updates.get(message.toolCallId ?? "");
    updates.delete(message.toolCallId ?? "");
    if (message.isError) continue;
    // Read-only tool output embeds unescaped user-authored subjects/descriptions.
    // A line resembling "#999 [completed] ..." there is not proof of a real task.
    if (message.toolName !== "TaskCreate" && message.toolName !== "TaskUpdate") continue;
    const text = message.content.flatMap(block =>
      isObject(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []
    ).join("\n");

    if (message.toolName === "TaskUpdate" && update) {
      const result = text.match(/^Updated task #(\d+(?:\.\d+)*) (.+)/);
      if (!result || result[1] !== update.taskId) continue;
      const fields = result[2].split(" (warning:")[0].split(", ");
      if (fields.includes(update.status === "deleted" ? "deleted" : "status")) {
        observe(update.taskId, update.status);
      }
    } else if (message.toolName === "TaskCreate") {
      const result = text.match(/^(?:Task #(\d+(?:\.\d+)*) created successfully:|Subtask #(\d+(?:\.\d+)*) created under #\d+(?:\.\d+)*:)/);
      if (result) observe(result[1] ?? result[2], "pending");
    }
  }

  return Array.from(completed, id => {
    const separator = id.lastIndexOf(".");
    return separator < 0 ? { id } : { id, parentTaskId: id.slice(0, separator) };
  });
}
