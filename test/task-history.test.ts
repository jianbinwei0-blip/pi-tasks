import { describe, expect, it } from "vitest";
import { recoverCompletedTaskHistory } from "../src/task-history.js";

function result(toolName: string, text: string, toolCallId = "call", isError = false) {
  return { type: "message", message: { role: "toolResult", toolName, toolCallId, isError,
    content: [{ type: "text", text }] } };
}

function update(taskId: string, status: string, text = `Updated task #${taskId} ${status === "deleted" ? "deleted" : "status"}`, isError = false) {
  return [
    { type: "message", message: { role: "assistant", content: [
      { type: "toolCall", name: "TaskUpdate", id: "call", arguments: { taskId, status } },
    ] } },
    result("TaskUpdate", text, "call", isError),
  ];
}

describe("recoverCompletedTaskHistory", () => {
  it("recovers confirmed completed roots and nested subtasks without guessing from ID gaps", () => {
    expect(recoverCompletedTaskHistory([
      ...update("21.14", "completed"),
      ...update("26.1.9", "completed"),
      ...update("36", "completed"),
    ])).toEqual([
      { id: "21.14", parentTaskId: "21" },
      { id: "26.1.9", parentTaskId: "26.1" },
      { id: "36" },
    ]);
  });

  it("honors later reopening and explicit deletion and deduplicates observations", () => {
    expect(recoverCompletedTaskHistory([
      ...update("1", "completed"),
      ...update("1.1", "completed"),
      ...update("2", "completed"),
      ...update("1.1", "completed"),
      ...update("1", "in_progress"),
      ...update("2", "deleted"),
      ...update("3", "completed"),
      ...update("3", "pending"),
    ])).toEqual([{ id: "1.1", parentTaskId: "1" }]);
  });

  it("requires successful matching tool results, not just requested statuses or arbitrary text", () => {
    expect(recoverCompletedTaskHistory([
      ...update("1", "completed", "Task #1 not found"),
      ...update("2", "completed", "Updated task #2 status", true),
      ...update("3", "completed", "Updated task #4 status"),
      ...update("4", "completed", "Updated task #4 subject"),
      ...update("5", "completed", "Updated task #5 status").slice(0, 1),
      result("TaskUpdate", "Updated task #5 status", "other-call"),
      result("TaskList", "#6 [completed] failed list", "call", true),
      result("bash", "#7 [completed] not a task result"),
      { type: "compaction", message: { role: "toolResult", toolName: "TaskList", content: [{ type: "text", text: "#8 [completed] not a message" }] } },
      ...update("9", "completed", "Updated task #9 status, metadata (warning: #10 does not exist)"),
    ])).toEqual([{ id: "9" }]);
  });

  it("drops old completions when legacy IDs were reused by later creates", () => {
    expect(recoverCompletedTaskHistory([
      ...update("1", "completed"),
      ...update("1.1", "completed"),
      result("TaskCreate", "Task #1 created successfully: replacement"),
      result("TaskCreate", "Subtask #1.1 created under #1: replacement child"),
    ])).toEqual([]);
  });

  it("ignores status-looking lines embedded in unescaped task subjects and descriptions", () => {
    expect(recoverCompletedTaskHistory([
      ...update("1", "completed"),
      result("TaskList", "#2 [pending] Investigate\n#999 [completed] example\n#1 [pending] another example"),
      result("TaskGet", "Task #3: Subject\nStatus: completed\nStatus: pending\nDescription: example"),
    ])).toEqual([{ id: "1" }]);
  });
});
