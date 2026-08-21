/**
 * Tests for task-subagent integration: TaskExecute tool, completion listener,
 * auto-cascade, and widget agent ID display.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";
import { TaskStore } from "../src/task-store.js";
import { TaskWidget, type Theme, type UICtx } from "../src/ui/task-widget.js";

let testAgentDir: string | undefined;

// Force in-memory task store for all integration tests — prevents file-backed
// store from loading stale tasks across test instances. Also isolate the pi
// agent dir so user-level extension config cannot leak into tests.
beforeEach(() => {
  process.env.PI_TASKS = "off";
  testAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tasks-agent-"));
  process.env.PI_CODING_AGENT_DIR = testAgentDir;
});
afterEach(() => {
  delete process.env.PI_TASKS;
  delete process.env.PI_CODING_AGENT_DIR;
  if (testAgentDir) fs.rmSync(testAgentDir, { recursive: true, force: true });
  testAgentDir = undefined;
});

// ---- Mock pi ----

type MockEventBus = {
  on: (channel: string, handler: (data: unknown) => void) => () => void;
  emit: (channel: string, data: unknown) => void;
};

/** Minimal mock of ExtensionAPI with events, tool capture, and event hooks. */
function mockPi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const eventHandlers = new Map<string, ((data: unknown) => void)[]>();
  const lifecycleHandlers = new Map<string, ((...args: any[]) => any)[]>();

  const pi = {
    registerTool(def: any) { tools.set(def.name, def); },
    registerCommand(name: string, def: any) { commands.set(name, def); },
    on(event: string, handler: any) {
      if (!lifecycleHandlers.has(event)) lifecycleHandlers.set(event, []);
      lifecycleHandlers.get(event)!.push(handler);
    },
    events: {
      emit(channel: string, data: unknown) {
        for (const h of eventHandlers.get(channel) ?? []) h(data);
      },
      on(channel: string, handler: (data: unknown) => void) {
        if (!eventHandlers.has(channel)) eventHandlers.set(channel, []);
        eventHandlers.get(channel)!.push(handler);
        return () => {
          const arr = eventHandlers.get(channel);
          if (arr) eventHandlers.set(channel, arr.filter(h => h !== handler));
        };
      },
    },
    sendUserMessage: vi.fn(),
  };

  return {
    pi,
    tools,
    commands,
    /** Execute a registered tool by name. */
    async executeTool(name: string, params: any, ctx?: any) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} not registered`);
      return tool.execute("call-1", params, undefined, undefined, ctx ?? mockCtx());
    },
    /** Fire lifecycle event handlers (turn_start, tool_result, etc.) */
    async fireLifecycle(event: string, ...args: any[]) {
      const results: any[] = [];
      for (const h of lifecycleHandlers.get(event) ?? []) {
        results.push(await h(...args));
      }
      return results;
    },
    /** Emit an event on pi.events (simulates subagent extension). */
    emitEvent(channel: string, data: unknown) {
      pi.events.emit(channel, data);
    },
  };
}

/** Minimal mock ExtensionContext. */
function mockCtx() {
  return {
    model: { id: "test-model", name: "Test" },
    modelRegistry: {},
    ui: {
      setWidget: vi.fn(),
      setStatus: vi.fn(),
      notify: vi.fn(),
    },
  };
}

// ---- Mock subagents extension (RPC responders) ----

/** Simulates the @tintinweb/pi-subagents extension: responds to ping + spawn RPCs and emits ready. */
function installSubagentsMock(pi: { events: MockEventBus }, opts?: { spawnError?: string }) {
  let idCounter = 0;
  const spawned: Array<{ id: string; type: string; prompt: string; options: any }> = [];
  const stopped: string[] = [];

  // Respond to ping — reply on scoped channel
  const unsubPing = pi.events.on("subagents:rpc:ping", (data: unknown) => {
    const { requestId } = data as { requestId: string };
    pi.events.emit(`subagents:rpc:ping:reply:${requestId}`, { success: true, data: { version: 2 } });
  });

  // Respond to spawn — reply on scoped channel
  const unsubSpawn = pi.events.on("subagents:rpc:spawn", (data: unknown) => {
    const { requestId, type, prompt, options } = data as {
      requestId: string; type: string; prompt: string; options?: any;
    };
    if (opts?.spawnError) {
      pi.events.emit(`subagents:rpc:spawn:reply:${requestId}`, { success: false, error: opts.spawnError });
      return;
    }
    const id = `agent-${++idCounter}`;
    spawned.push({ id, type, prompt, options });
    pi.events.emit(`subagents:rpc:spawn:reply:${requestId}`, { success: true, data: { id } });
  });

  // Respond to stop — reply on scoped channel
  const unsubStop = pi.events.on("subagents:rpc:stop", (data: unknown) => {
    const { requestId, agentId } = data as { requestId: string; agentId: string };
    const known = spawned.some(s => s.id === agentId);
    if (known) {
      stopped.push(agentId);
      pi.events.emit(`subagents:rpc:stop:reply:${requestId}`, { success: true });
    } else {
      pi.events.emit(`subagents:rpc:stop:reply:${requestId}`, { success: false, error: "Agent not found" });
    }
  });

  // Broadcast readiness
  pi.events.emit("subagents:ready", {});

  return {
    spawned,
    stopped,
    unsub() { unsubPing(); unsubSpawn(); unsubStop(); },
  };
}

// ---- Tests ----

describe("TaskExecute", () => {
  let mock: ReturnType<typeof mockPi>;
  let rpc: ReturnType<typeof installSubagentsMock>;

  beforeEach(() => {
    mock = mockPi();
    // Install mock BEFORE init so ping reply is received during extension init
    rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
  });

  afterEach(() => {
    rpc.unsub();
  });

  it("is registered as a tool", () => {
    expect(mock.tools.has("TaskExecute")).toBe(true);
  });

  it("returns error when subagent extension is not loaded", async () => {
    // Re-init without mock to simulate missing extension
    const freshMock = mockPi();
    initExtension(freshMock.pi as any);

    await freshMock.executeTool("TaskCreate", {
      subject: "Test task",
      description: "Do something",
      agentType: "general-purpose",
    });

    const result = await freshMock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("Subagent execution is currently unavailable");
  });

  it("rejects non-existent tasks", async () => {
    const result = await mock.executeTool("TaskExecute", { task_ids: ["999"] });
    expect(result.content[0].text).toContain("#999: not found");
  });

  it("rejects tasks without agentType", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "No agent type",
      description: "Plain task",
    });

    const result = await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("#1: no agentType set");
  });

  it("rejects non-pending tasks", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Already started",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "in_progress" });

    const result = await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("#1: not pending");
  });

  it("rejects tasks with unresolved blockers", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Blocker",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskCreate", {
      subject: "Blocked",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    const result = await mock.executeTool("TaskExecute", { task_ids: ["2"] });
    expect(result.content[0].text).toContain("#2: blocked by #1");
  });

  it("spawns agent for valid task and updates metadata", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Run tests",
      description: "Run the test suite",
      agentType: "general-purpose",
    });

    const result = await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("Launched 1 agent");
    expect(result.content[0].text).toContain("#1 → agent agent-1");

    // Verify the RPC responder was called
    expect(rpc.spawned).toHaveLength(1);
    expect(rpc.spawned[0].type).toBe("general-purpose");
    expect(rpc.spawned[0].prompt).toContain("Run the test suite");
    expect(rpc.spawned[0].options.isBackground).toBe(true);
  });

  it("passes additional_context and max_turns to spawned agents", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Explore codebase",
      description: "Find all API endpoints",
      agentType: "Explore",
    });

    await mock.executeTool("TaskExecute", {
      task_ids: ["1"],
      additional_context: "Focus on REST endpoints only",
      max_turns: 10,
    });

    expect(rpc.spawned[0].prompt).toContain("Focus on REST endpoints only");
    expect(rpc.spawned[0].options.maxTurns).toBe(10);
  });

  it("allows executing tasks whose blockers are all completed", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Blocker",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskCreate", {
      subject: "Dependent",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "completed" });

    const result = await mock.executeTool("TaskExecute", { task_ids: ["2"] });
    expect(result.content[0].text).toContain("Launched 1 agent");
  });

  it("handles mixed valid and invalid tasks in one call", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Valid",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskCreate", {
      subject: "No agent type",
      description: "Desc",
    });

    const result = await mock.executeTool("TaskExecute", { task_ids: ["1", "2", "999"] });
    const text = result.content[0].text;
    expect(text).toContain("Launched 1 agent");
    expect(text).toContain("#2: no agentType set");
    expect(text).toContain("#999: not found");
  });
});

describe("TaskExecute via ready broadcast", () => {
  it("detects subagents when ready fires after tasks init", async () => {
    // Init tasks WITHOUT the mock — subagents not available yet
    const mock = mockPi();
    initExtension(mock.pi as any);

    // Now install the mock (simulates subagents loading later) and broadcast ready
    const rpc = installSubagentsMock(mock.pi);

    // Create a task and execute — should work because ready was received
    await mock.executeTool("TaskCreate", {
      subject: "Late-loaded test",
      description: "Desc",
      agentType: "general-purpose",
    });

    const result = await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("Launched 1 agent");
    expect(rpc.spawned).toHaveLength(1);

    rpc.unsub();
  });
});

describe("Completion listener", () => {
  let mock: ReturnType<typeof mockPi>;
  let rpc: ReturnType<typeof installSubagentsMock>;

  beforeEach(() => {
    mock = mockPi();
    rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
  });

  afterEach(() => {
    rpc.unsub();
  });

  it("marks task completed on subagents:completed event", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Agent task",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });

    // Simulate agent completion
    mock.emitEvent("subagents:completed", { id: "agent-1" });

    const result = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(result.content[0].text).toContain("Status: completed");
  });

  it("reverts task to pending on subagents:failed event", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Failing task",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });

    // Simulate agent failure
    mock.emitEvent("subagents:failed", { id: "agent-1", error: "Out of turns", status: "error" });

    const result = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(result.content[0].text).toContain("Status: pending");
  });

  it("ignores events for unknown agent IDs", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Unrelated",
      description: "Desc",
    });

    // Should not throw or modify anything
    mock.emitEvent("subagents:completed", { id: "unknown-agent" });
    mock.emitEvent("subagents:failed", { id: "unknown-agent", error: "boom", status: "error" });

    const result = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(result.content[0].text).toContain("Status: pending");
  });
});

describe("Auto-cascade", () => {
  let mock: ReturnType<typeof mockPi>;
  let rpc: ReturnType<typeof installSubagentsMock>;

  beforeEach(() => {
    mock = mockPi();
    rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
  });

  afterEach(() => {
    rpc.unsub();
  });

  it("does NOT cascade when auto-cascade is off (default)", async () => {
    // Create A → B chain
    await mock.executeTool("TaskCreate", {
      subject: "Task A",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskCreate", {
      subject: "Task B",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    // Execute A
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(rpc.spawned).toHaveLength(1);

    // Complete A
    mock.emitEvent("subagents:completed", { id: "agent-1" });

    // B should NOT have been auto-started
    expect(rpc.spawned).toHaveLength(1);

    // B should still be pending
    const result = await mock.executeTool("TaskGet", { taskId: "2" });
    expect(result.content[0].text).toContain("Status: pending");
  });

  it("does NOT cascade on failure (branch stops)", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Task A",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskCreate", {
      subject: "Task B",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    mock.emitEvent("subagents:failed", { id: "agent-1", error: "crashed", status: "error" });

    // B should not start
    expect(rpc.spawned).toHaveLength(1);
    const result = await mock.executeTool("TaskGet", { taskId: "2" });
    expect(result.content[0].text).toContain("Status: pending");
  });

  it("tasks without agentType are not cascaded even if unblocked", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Agent task",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskCreate", {
      subject: "Manual task",
      description: "Desc",
      // No agentType — manual
    });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    mock.emitEvent("subagents:completed", { id: "agent-1" });

    // Manual task should stay pending
    expect(rpc.spawned).toHaveLength(1);
  });
});


describe("Standalone operation (no subagents extension)", () => {
  let mock: ReturnType<typeof mockPi>;

  beforeEach(() => {
    // Init WITHOUT installSubagentsMock — no subagents extension present
    mock = mockPi();
    initExtension(mock.pi as any);
  });

  it("all core task tools and the tasks command are registered", () => {
    for (const name of ["TaskCreate", "TaskList", "TaskGet", "TaskUpdate", "TaskExecute"]) {
      expect(mock.tools.has(name)).toBe(true);
    }
    expect(mock.commands.has("tasks")).toBe(true);
    expect(mock.commands.has("extensions")).toBe(false);
  });

  it("TaskCreate works without subagents", async () => {
    const result = await mock.executeTool("TaskCreate", {
      subject: "Write tests",
      description: "Add unit tests for the parser",
    });
    expect(result.content[0].text).toContain("Write tests");
  });

  it("TaskList works without subagents", async () => {
    await mock.executeTool("TaskCreate", { subject: "A", description: "desc" });
    await mock.executeTool("TaskCreate", { subject: "B", description: "desc" });
    const result = await mock.executeTool("TaskList", {});
    expect(result.content[0].text).toContain("#1");
    expect(result.content[0].text).toContain("#2");
  });

  it("TaskList shows task cost, total tokens, and output rate", async () => {
    await mock.executeTool("TaskCreate", { subject: "Costed", description: "desc" });
    await mock.executeTool("TaskUpdate", {
      taskId: "1",
      metadata: {
        executionStats: {
          startedAt: 1_700_000_000_000,
          completedAt: 1_700_000_065_000,
          durationMs: 65_000,
          inputTokens: 1200,
          outputTokens: 400,
          costUsd: 0.0123,
        },
      },
    });

    const result = await mock.executeTool("TaskList", {});
    expect(result.content[0].text).toContain("#1 [pending] Costed [$0.012] [1.6k tok] [6.2 tok/s]");
  });

  it("TaskGet works without subagents", async () => {
    await mock.executeTool("TaskCreate", { subject: "Read me", description: "details here" });
    const result = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(result.content[0].text).toContain("Read me");
    expect(result.content[0].text).toContain("details here");
  });

  it("TaskUpdate works without subagents", async () => {
    await mock.executeTool("TaskCreate", { subject: "Update me", description: "desc" });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "in_progress" });
    const result = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(result.content[0].text).toContain("in_progress");
  });

  it("TaskGet shows persisted start time for in-progress tasks", async () => {
    await mock.executeTool("TaskCreate", { subject: "Started", description: "desc" });
    await mock.executeTool("TaskUpdate", {
      taskId: "1",
      metadata: {
        executionStats: {
          startedAt: 1_700_000_000_000,
          inputTokens: 0,
          outputTokens: 0,
        },
      },
    });

    const result = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(result.content[0].text).toContain("Execution stats: started");
    expect(result.content[0].text).not.toContain("ended ");
  });

  it("TaskGet renders valid execution stats separately from metadata", async () => {
    await mock.executeTool("TaskCreate", { subject: "Measured", description: "desc" });
    await mock.executeTool("TaskUpdate", {
      taskId: "1",
      metadata: {
        executionStats: {
          startedAt: 1_700_000_000_000,
          completedAt: 1_700_000_065_000,
          durationMs: 65_000,
          inputTokens: 1200,
          outputTokens: 400,
          costUsd: 0.0123,
        },
        note: "kept",
      },
    });

    const result = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(result.content[0].text).toContain("Execution stats: started");
    expect(result.content[0].text).toContain("1m 5s");
    expect(result.content[0].text).toContain("↑ 1.2k");
    expect(result.content[0].text).toContain("↓ 400");
    expect(result.content[0].text).toContain("1.6k tok");
    expect(result.content[0].text).toContain("6.2 tok/s");
    expect(result.content[0].text).toContain("$0.012");
    expect(result.content[0].text).toContain('Metadata: {"note":"kept"}');
    expect(result.content[0].text).not.toContain('"executionStats"');
  });

  it("turn_end usage cost is persisted into completed task stats", async () => {
    await mock.executeTool("TaskCreate", { subject: "Live cost", description: "desc" });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "in_progress" });

    await mock.fireLifecycle("turn_end", {
      message: {
        role: "assistant",
        usage: {
          input: 1000,
          output: 500,
          cacheRead: 3000,
          cacheWrite: 0,
          totalTokens: 4500,
          cost: { total: 0.0123 },
        },
      },
    });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "completed" });

    const result = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(result.content[0].text).toContain("↑ 1k");
    expect(result.content[0].text).toContain("↓ 500");
    expect(result.content[0].text).toContain("4.5k tok");
    expect(result.content[0].text).toContain("$0.012");
  });

  it("TaskGet leaves malformed execution stats in raw metadata", async () => {
    await mock.executeTool("TaskCreate", { subject: "Broken", description: "desc" });
    await mock.executeTool("TaskUpdate", {
      taskId: "1",
      metadata: {
        executionStats: {
          startedAt: "bad",
          completedAt: null,
        },
      },
    });

    const result = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(result.content[0].text).not.toContain("Execution stats:");
    expect(result.content[0].text).toContain('Metadata: {"executionStats":{"startedAt":"bad","completedAt":null}}');
  });

  it("TaskExecute gracefully refuses without subagents", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Agent task",
      description: "desc",
      agentType: "general-purpose",
    });
    const result = await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    const text = result.content[0].text;
    expect(text).toContain("Subagent execution is currently unavailable");
    // Offers the plain Agent tool as a fallback, with the tracking caveat.
    expect(text).toContain("Agent-tool spawns");
    expect(text).toContain("won't track them");
  });

  it("subagents lifecycle events are silently ignored without mapped agents", () => {
    // These should not throw even though no subagents extension is loaded
    mock.emitEvent("subagents:completed", { id: "ghost-agent", result: "done" });
    mock.emitEvent("subagents:failed", { id: "ghost-agent", error: "boom", status: "error" });
    // No crash = pass
  });

  it("task dependencies work without subagents", async () => {
    await mock.executeTool("TaskCreate", { subject: "First", description: "desc" });
    await mock.executeTool("TaskCreate", { subject: "Second", description: "desc" });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    const result = await mock.executeTool("TaskGet", { taskId: "2" });
    expect(result.content[0].text).toContain("Blocked by");
    expect(result.content[0].text).toContain("#1");
  });
});

describe("RPC protocol correctness", () => {
  it("ping uses scoped reply channel (not shared channel)", () => {
    const mock = mockPi();
    const emitted: Array<{ channel: string; data: unknown }> = [];
    const origEmit = mock.pi.events.emit.bind(mock.pi.events);
    mock.pi.events.emit = (channel: string, data: unknown) => {
      emitted.push({ channel, data });
      origEmit(channel, data);
    };

    initExtension(mock.pi as any);

    // Find the ping emit
    const pingEmit = emitted.find(e => e.channel === "subagents:rpc:ping");
    expect(pingEmit).toBeDefined();
    const pingData = pingEmit!.data as { requestId: string };
    expect(pingData.requestId).toBeDefined();
    expect(typeof pingData.requestId).toBe("string");
  });

  it("spawn reply cleans up listener and timer on success", async () => {
    const mock = mockPi();
    const rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", {
      subject: "Test",
      description: "desc",
      agentType: "general-purpose",
    });

    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(rpc.spawned).toHaveLength(1);

    // Second spawn should get a fresh requestId (not conflict with first)
    await mock.executeTool("TaskCreate", {
      subject: "Test 2",
      description: "desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskExecute", { task_ids: ["2"] });
    expect(rpc.spawned).toHaveLength(2);
    expect(rpc.spawned[0].id).not.toBe(rpc.spawned[1].id);

    rpc.unsub();
  });

  it("spawn RPC rejects on timeout when no responder exists", async () => {
    const mock = mockPi();
    // Install ping handler (for version check) but no spawn handler
    installVersionedMock(mock.pi, 2);
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", {
      subject: "Timeout test",
      description: "desc",
      agentType: "general-purpose",
    });

    // spawnSubagent has a 30s timeout — we'll advance timers
    vi.useFakeTimers();
    const execPromise = mock.executeTool("TaskExecute", { task_ids: ["1"] });
    await vi.advanceTimersByTimeAsync(31000);

    const result = await execPromise;
    expect(result.content[0].text).toContain("timeout");

    vi.useRealTimers();
  });

  it("ready broadcast sets subagentsAvailable even after init", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    // Initially no subagents
    await mock.executeTool("TaskCreate", {
      subject: "Test",
      description: "desc",
      agentType: "general-purpose",
    });
    let result = await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("Subagent execution is currently unavailable");

    // Reset task status
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "pending" });

    // Late subagents extension broadcasts ready
    const rpc = installSubagentsMock(mock.pi);

    result = await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("Launched 1 agent");

    rpc.unsub();
  });

  it("spawn RPC rejects with error message from server", async () => {
    const mock = mockPi();
    installSubagentsMock(mock.pi, { spawnError: "No active session" });
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", {
      subject: "Err test",
      description: "desc",
      agentType: "general-purpose",
    });

    const result = await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("No active session");
  });

  it("stop RPC resolves on success", async () => {
    const mock = mockPi();
    const rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);

    // Spawn a task so we have an agent to stop
    await mock.executeTool("TaskCreate", {
      subject: "Stoppable",
      description: "desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(rpc.spawned).toHaveLength(1);

    const result = await mock.executeTool("TaskStop", { task_id: "1" });
    expect(result.content[0].text).toContain("stopped successfully");
    expect(rpc.stopped).toContain("agent-1");

    rpc.unsub();
  });

  it("stop RPC returns false on error (agent not found) without throwing", async () => {
    const mock = mockPi();
    const rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);

    // Create and execute a task, then simulate agent already gone
    await mock.executeTool("TaskCreate", {
      subject: "Ghost",
      description: "desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });

    // Clear spawned list so the mock's stop handler won't find the agent
    rpc.spawned.length = 0;

    // TaskStop should still succeed (stopSubagent catches the error)
    const result = await mock.executeTool("TaskStop", { task_id: "1" });
    expect(result.content[0].text).toContain("stopped successfully");

    rpc.unsub();
  });

  it("stop RPC returns false on timeout without throwing", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    // Mark subagents as available via ready broadcast, but no stop handler installed
    mock.pi.events.emit("subagents:ready", {});

    await mock.executeTool("TaskCreate", {
      subject: "Timeout stop",
      description: "desc",
      agentType: "general-purpose",
    });
    // Manually set task as in_progress with an agentId (no spawn handler)
    await mock.executeTool("TaskUpdate", {
      taskId: "1",
      status: "in_progress",
      metadata: { agentType: "general-purpose", agentId: "ghost-agent" },
    });

    vi.useFakeTimers();
    const stopPromise = mock.executeTool("TaskStop", { task_id: "1" });
    await vi.advanceTimersByTimeAsync(11000);

    // Should resolve (not throw) — stopSubagent catches timeout
    const result = await stopPromise;
    expect(result.content[0].text).toContain("stopped successfully");

    vi.useRealTimers();
  });
});

/** Install a ping-only mock with a specific protocol version (or no version for v1). */
function installVersionedMock(pi: { events: MockEventBus }, version?: number) {
  const unsubPing = pi.events.on("subagents:rpc:ping", (data: unknown) => {
    const { requestId } = data as { requestId: string };
    if (version !== undefined) {
      pi.events.emit(`subagents:rpc:ping:reply:${requestId}`, { success: true, data: { version } });
    } else {
      // v1 handler — no envelope, no version
      pi.events.emit(`subagents:rpc:ping:reply:${requestId}`, {});
    }
  });
  pi.events.emit("subagents:ready", {});
  return { unsub() { unsubPing(); } };
}

describe("Protocol version mismatch", () => {
  it("matching version — no warning", async () => {
    const mock = mockPi();
    installVersionedMock(mock.pi, 2);
    initExtension(mock.pi as any);

    // No warning on before_agent_start
    const ctx = mockCtx();
    await mock.fireLifecycle("before_agent_start", {}, ctx);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("old handler (no version) — warns about pi-subagents", async () => {
    const mock = mockPi();
    installVersionedMock(mock.pi);  // no version = v1
    initExtension(mock.pi as any);

    const ctx = mockCtx();
    await mock.fireLifecycle("before_agent_start", {}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("pi-subagents is outdated"),
      "warning",
    );
  });

  it("handler ahead (v3) — warns about pi-tasks", async () => {
    const mock = mockPi();
    installVersionedMock(mock.pi, 3);
    initExtension(mock.pi as any);

    const ctx = mockCtx();
    await mock.fireLifecycle("before_agent_start", {}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("pi-tasks is outdated"),
      "warning",
    );
  });

  it("handler behind (v1) — warns about pi-subagents", async () => {
    const mock = mockPi();
    installVersionedMock(mock.pi, 1);
    initExtension(mock.pi as any);

    const ctx = mockCtx();
    await mock.fireLifecycle("before_agent_start", {}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("pi-subagents is outdated"),
      "warning",
    );
  });

  it("warning shown only once", async () => {
    const mock = mockPi();
    installVersionedMock(mock.pi);  // v1 — triggers warning
    initExtension(mock.pi as any);

    const ctx1 = mockCtx();
    await mock.fireLifecycle("before_agent_start", {}, ctx1);
    expect(ctx1.ui.notify).toHaveBeenCalledOnce();

    const ctx2 = mockCtx();
    await mock.fireLifecycle("before_agent_start", {}, ctx2);
    expect(ctx2.ui.notify).not.toHaveBeenCalled();
  });
});

describe("Task creation mode", () => {
  async function configPath() {
    return path.join(process.cwd(), ".pi", "tasks-config.json");
  }

  async function globalConfigPath(fileName = "pi-tasks.json") {
    if (!testAgentDir) throw new Error("test agent dir not initialized");
    return path.join(testAgentDir, "extensions", fileName);
  }

  async function piSettingsPath(scope: "global" | "project" = "global") {
    if (scope === "global") {
      if (!testAgentDir) throw new Error("test agent dir not initialized");
      return path.join(testAgentDir, "settings.json");
    }
    return path.join(process.cwd(), ".pi", "settings.json");
  }

  async function writeConfig(config: Record<string, unknown>) {
    const file = await configPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(config));
  }

  async function writeGlobalConfig(config: Record<string, unknown>, fileName?: string) {
    const file = await globalConfigPath(fileName);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(config));
  }

  async function writePiSettings(settings: Record<string, unknown>, scope: "global" | "project" = "global") {
    const file = await piSettingsPath(scope);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings));
  }

  async function removeConfig() {
    try { fs.unlinkSync(await configPath()); } catch {}
    try { fs.unlinkSync(await piSettingsPath("project")); } catch {}
  }

  beforeEach(async () => {
    await removeConfig();
  });

  afterEach(async () => {
    await removeConfig();
  });

  it("keeps default model mode as model-discretionary with no host-created task", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.fireLifecycle("before_agent_start", { prompt: "Do several things" }, mockCtx());

    const result = await mock.executeTool("TaskList", {});
    expect(result.content[0].text).toBe("No tasks found");
  });

  it("loads task creation mode from user extension config", async () => {
    await writeGlobalConfig({ taskCreationMode: "always" });
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.fireLifecycle("before_agent_start", { prompt: "Configured globally" }, mockCtx());
    const results = await mock.fireLifecycle("context", { messages: [] });

    expect(results[0].messages.at(-1).content[0].text).toContain("taskCreationMode=always is active");
    const result = await mock.executeTool("TaskList", {});
    expect(result.content[0].text).toBe("No tasks found");
  });

  it("loads task creation mode from pi-extmgr package settings", async () => {
    await writePiSettings({
      packages: [
        {
          source: process.cwd(),
          settings: { taskCreationMode: "always" },
        },
      ],
    });
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.fireLifecycle("before_agent_start", { prompt: "Configured via extmgr" }, mockCtx());
    const results = await mock.fireLifecycle("context", { messages: [] });

    expect(results[0].messages.at(-1).content[0].text).toContain("taskCreationMode=always is active");
    const result = await mock.executeTool("TaskList", {});
    expect(result.content[0].text).toBe("No tasks found");
  });

  it("loads manual task creation mode from pi-extmgr package settings", async () => {
    await writePiSettings({
      packages: [
        {
          source: process.cwd(),
          settings: { taskCreationMode: "manual" },
        },
      ],
    });
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.fireLifecycle("before_agent_start", { prompt: "Configured manual via extmgr" }, mockCtx());

    const result = await mock.executeTool("TaskList", {});
    expect(result.content[0].text).toBe("No tasks found");
  });

  it("keeps legacy ambiguous pi-extmgr mode filters model-discretionary", async () => {
    await writePiSettings({
      packages: [
        {
          source: process.cwd(),
          extensions: ["-src/extmgr/task-creation-mode-always.ts"],
        },
      ],
    });
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.fireLifecycle("before_agent_start", { prompt: "Ambiguous extmgr config" }, mockCtx());

    const result = await mock.executeTool("TaskList", {});
    expect(result.content[0].text).toBe("No tasks found");
  });

  it("lets project config override user extension and pi-extmgr config", async () => {
    await writeGlobalConfig({ taskCreationMode: "always" });
    await writePiSettings({
      packages: [
        {
          source: process.cwd(),
          settings: { taskCreationMode: "always" },
        },
      ],
    });
    await writeConfig({ taskCreationMode: "manual" });
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.fireLifecycle("before_agent_start", { prompt: "Project override" }, mockCtx());

    const result = await mock.executeTool("TaskList", {});
    expect(result.content[0].text).toBe("No tasks found");
  });

  it("manual mode does not create prompt tasks automatically", async () => {
    await writeConfig({ taskCreationMode: "manual" });
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.fireLifecycle("before_agent_start", { prompt: "Do several things" }, mockCtx());

    const result = await mock.executeTool("TaskList", {});
    expect(result.content[0].text).toBe("No tasks found");
  });

  it("manual mode suppresses reminder injection", async () => {
    await writeConfig({ taskCreationMode: "manual" });
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "Existing task", description: "Desc" });
    for (let i = 0; i < 5; i++) await mock.fireLifecycle("turn_start", {}, mockCtx());
    await mock.fireLifecycle("tool_result", { toolName: "read" });
    const results = await mock.fireLifecycle("context", { messages: [] });

    expect(results).toEqual([{}]);
  });

  it("always mode asks the model to create the task title and does not host-create a generic task", async () => {
    await writeConfig({ taskCreationMode: "always" });
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.fireLifecycle("before_agent_start", { prompt: "Explain the code" }, mockCtx());

    const taskList = await mock.executeTool("TaskList", {});
    expect(taskList.content[0].text).toBe("No tasks found");

    const results = await mock.fireLifecycle("context", { messages: [] });
    const reminderText = results[0].messages.at(-1).content[0].text;
    expect(reminderText).toContain("taskCreationMode=always is active");
    expect(reminderText).toContain("Choose the task title from the user's request");
    expect(reminderText).toContain("TaskCreate");
    expect(reminderText).toContain("even if the request is simple, trivial, conversational, or can be completed in fewer than 3 steps");
    expect(reminderText).toContain("overrides the usual guidance to skip TaskCreate for trivial tasks");
    expect(reminderText).toContain("automatically number them as subtasks (#parent.1, #parent.2, etc.)");
  });

  it("always mode nests additional tasks under the prompt task and resets for the next prompt", async () => {
    await writeConfig({ taskCreationMode: "always" });
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.fireLifecycle("before_agent_start", { prompt: "Build a complicated feature" }, mockCtx());
    const parent = await mock.executeTool("TaskCreate", {
      subject: "Build complicated feature",
      description: "Deliver the complete feature",
    });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "in_progress" });
    const firstChild = await mock.executeTool("TaskCreate", {
      subject: "Implement feature core",
      description: "Build the core behavior",
    });
    const secondChild = await mock.executeTool("TaskCreate", {
      subject: "Test feature core",
      description: "Add regression coverage",
    });

    expect(parent.content[0].text).toContain("Task #1 created");
    expect(firstChild.content[0].text).toContain("Subtask #1.1 created under #1");
    expect(secondChild.content[0].text).toContain("Subtask #1.2 created under #1");

    const childDetails = await mock.executeTool("TaskGet", { taskId: "1.1" });
    expect(childDetails.content[0].text).toContain("Parent: #1");
    const taskList = await mock.executeTool("TaskList", {});
    expect(taskList.content[0].text).toContain("  #1.1 [pending] Implement feature core");
    expect(taskList.content[0].text).toContain("  #1.2 [pending] Test feature core");

    await mock.fireLifecycle("before_agent_start", { prompt: "Handle another request" }, mockCtx());
    const nextParent = await mock.executeTool("TaskCreate", {
      subject: "Handle another request",
      description: "Complete the next prompt",
    });
    const nextChild = await mock.executeTool("TaskCreate", {
      subject: "Check another request",
      description: "Verify the next prompt",
    });

    expect(nextParent.content[0].text).toContain("Task #2 created");
    expect(nextChild.content[0].text).toContain("Subtask #2.1 created under #2");
  });

  it("always mode uses a reused in-progress task as the prompt parent", async () => {
    await writeConfig({ taskCreationMode: "always" });
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.fireLifecycle("before_agent_start", { prompt: "Initial request" }, mockCtx());
    await mock.executeTool("TaskCreate", {
      subject: "Reusable request task",
      description: "Continue this task later",
    });

    await mock.fireLifecycle("before_agent_start", { prompt: "Continue the request" }, mockCtx());
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "in_progress" });
    const child = await mock.executeTool("TaskCreate", {
      subject: "Finish remaining step",
      description: "Complete the reused prompt task",
    });

    expect(child.content[0].text).toContain("Subtask #1.1 created under #1");
  });

  it("model mode keeps multiple prompt tasks at the top level", async () => {
    await writeConfig({ taskCreationMode: "model" });
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.fireLifecycle("before_agent_start", { prompt: "Plan two independent tasks" }, mockCtx());
    const first = await mock.executeTool("TaskCreate", { subject: "First", description: "First task" });
    const second = await mock.executeTool("TaskCreate", { subject: "Second", description: "Second task" });

    expect(first.content[0].text).toContain("Task #1 created");
    expect(second.content[0].text).toContain("Task #2 created");
  });

  it("always mode suppresses the generic optional reminder so trivial prompts still require tasks", async () => {
    await writeConfig({ taskCreationMode: "always" });
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "Existing task", description: "Desc" });
    for (let i = 0; i < 5; i++) await mock.fireLifecycle("turn_start", {}, mockCtx());
    await mock.fireLifecycle("tool_result", { toolName: "read" });
    await mock.fireLifecycle("before_agent_start", { prompt: "Say hi" }, mockCtx());

    const results = await mock.fireLifecycle("context", { messages: [] });
    const reminderText = results[0].messages.at(-1).content[0].text;
    expect(reminderText).toContain("taskCreationMode=always is active");
    expect(reminderText).not.toContain("Only use these if relevant");
  });

  it("always mode queues one model-owned task instruction for each user prompt", async () => {
    await writeConfig({ taskCreationMode: "always" });
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.fireLifecycle("before_agent_start", { prompt: "First" }, mockCtx());
    const first = await mock.fireLifecycle("context", { messages: [] });
    expect(first[0].messages.at(-1).content[0].text).toContain("taskCreationMode=always is active");
    const consumed = await mock.fireLifecycle("context", { messages: [] });
    expect(consumed).toEqual([{}]);

    await mock.fireLifecycle("before_agent_start", { prompt: "Second" }, mockCtx());
    const second = await mock.fireLifecycle("context", { messages: [] });
    expect(second[0].messages.at(-1).content[0].text).toContain("taskCreationMode=always is active");
  });
});

describe("Widget agent ID display", () => {
  let store: TaskStore;
  let widget: TaskWidget;
  let ui: ReturnType<typeof mockUICtx>;

  function mockUICtx() {
    const state = {
      widgets: new Map<string, any>(),
      statuses: new Map<string, string | undefined>(),
    };
    const ctx: UICtx = {
      setWidget(key, content, options) { state.widgets.set(key, { content, options }); },
      setStatus(key, text) { state.statuses.set(key, text); },
    };
    return { ctx, state };
  }

  function mockTheme(): Theme {
    return {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      strikethrough: (text: string) => `~~${text}~~`,
    };
  }

  function renderWidget(state: ReturnType<typeof mockUICtx>["state"]): string[] {
    const entry = state.widgets.get("tasks");
    if (!entry?.content) return [];
    const theme = mockTheme();
    const tui = { terminal: { columns: 200 } };
    return entry.content(tui, theme).render();
  }

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

  it("shows agent ID for active agent-backed tasks", () => {
    store.create("Agent task", "Desc", "Running tests", { agentType: "general-purpose", agentId: "abc1234567890" });
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("agent abc12");
    expect(lines[1]).toContain("Running tests");
  });

  it("shows agent ID for non-active in_progress agent-backed tasks", () => {
    store.create("Agent task", "Desc", undefined, { agentType: "general-purpose", agentId: "xyz9876543210" });
    store.update("1", { status: "in_progress" });
    // NOT calling setActiveTask — simulates external agent management
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("agent xyz98");
    expect(lines[1]).toContain("Agent task");
  });

  it("does not show agent ID for tasks without agentId", () => {
    store.create("Manual task", "Desc");
    store.update("1", { status: "in_progress" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).not.toContain("agent");
    expect(lines[1]).toContain("Manual task");
  });

  it("does not show agent ID for pending tasks", () => {
    store.create("Pending agent task", "Desc", undefined, { agentType: "general-purpose", agentId: "abc12345" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).not.toContain("agent abc");
  });

  it("does not show agent ID for completed tasks", () => {
    store.create("Done", "Desc", undefined, { agentType: "general-purpose", agentId: "abc12345" });
    store.update("1", { status: "completed" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).not.toContain("agent abc");
  });
});

describe("Cascade data injection (buildTaskPrompt)", () => {
  let mock: ReturnType<typeof mockPi>;
  let rpc: ReturnType<typeof installSubagentsMock>;

  beforeEach(async () => {
    // Enable autoCascade via config file in cwd
    const fs = await import("node:fs");
    const path = await import("node:path");
    const configPath = path.join(process.cwd(), ".pi", "tasks-config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ autoCascade: true }));

    mock = mockPi();
    rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);

    // Set latestCtx via turn_start lifecycle event
    await mock.fireLifecycle("turn_start", {}, mockCtx());
  });

  afterEach(async () => {
    rpc.unsub();
    const fs = await import("node:fs");
    const path = await import("node:path");
    try { fs.unlinkSync(path.join(process.cwd(), ".pi", "tasks-config.json")); } catch {}
  });

  it("injects prerequisite result into cascaded agent prompt", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Task A",
      description: "Produce a result",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskCreate", {
      subject: "Task B",
      description: "Use Task A result",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(rpc.spawned).toHaveLength(1);

    mock.emitEvent("subagents:completed", { id: "agent-1", result: "The answer is 42" });

    await vi.waitFor(() => expect(rpc.spawned).toHaveLength(2), { timeout: 1000 });

    const bPrompt = rpc.spawned[1].prompt;
    expect(bPrompt).toContain("Prerequisite task results");
    expect(bPrompt).toContain("Task #1");
    expect(bPrompt).toContain("The answer is 42");
  });

  it("truncates long prerequisite results at 4KB", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Task A",
      description: "Produce a long result",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskCreate", {
      subject: "Task B",
      description: "Use truncated result",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    await mock.executeTool("TaskExecute", { task_ids: ["1"] });

    const longResult = "x".repeat(5000);
    mock.emitEvent("subagents:completed", { id: "agent-1", result: longResult });

    await vi.waitFor(() => expect(rpc.spawned).toHaveLength(2), { timeout: 1000 });

    const bPrompt = rpc.spawned[1].prompt;
    expect(bPrompt).toContain("truncated");
    expect(bPrompt).toContain("TaskGet");
    expect(bPrompt.length).toBeLessThan(longResult.length);
  });

  it("handles dependencies with no stored result gracefully", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Task A",
      description: "No result stored",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskCreate", {
      subject: "Task B",
      description: "Works without A result",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    await mock.executeTool("TaskExecute", { task_ids: ["1"] });

    mock.emitEvent("subagents:completed", { id: "agent-1" });

    await vi.waitFor(() => expect(rpc.spawned).toHaveLength(2), { timeout: 1000 });

    const bPrompt = rpc.spawned[1].prompt;
    expect(bPrompt).not.toContain("Prerequisite task results");
  });
});
