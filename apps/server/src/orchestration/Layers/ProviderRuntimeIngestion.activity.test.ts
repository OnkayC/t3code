import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  RuntimeTaskId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runtimeEventToActivities } from "./ProviderRuntimeIngestion.ts";

const base = {
  provider: ProviderDriverKind.make("codex"),
  createdAt: "2026-08-06T00:00:00.000Z",
  threadId: ThreadId.make("thread-1"),
};

describe("runtimeEventToActivities task progress", () => {
  it("persists usage independently from replaceable activity", () => {
    const taskId = RuntimeTaskId.make("agent-1");
    const usageOnly = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-usage"),
      payload: {
        taskId,
        description: "Agent one",
        typedUsage: { totalTokens: 73_700_000 },
      },
    } satisfies ProviderRuntimeEvent;
    const command = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-command"),
      payload: {
        taskId,
        description: "Agent one",
        summary: "Running tests",
        lastToolName: "exec_command",
      },
    } satisfies ProviderRuntimeEvent;

    const usageActivities = runtimeEventToActivities(usageOnly);
    const commandActivities = runtimeEventToActivities(command);

    expect(usageActivities.map((activity) => activity.id)).toEqual(["task-usage:thread-1:agent-1"]);
    expect(commandActivities.map((activity) => activity.id)).toEqual([
      "task-progress:thread-1:agent-1",
    ]);
    const usagePayload = usageActivities[0]?.payload as Record<string, unknown> | undefined;
    expect(usagePayload?.typedUsage).toEqual({ totalTokens: 73_700_000 });
    expect(usagePayload?.usageSnapshot).toBe(true);
  });

  it("splits combined progress and usage into their independent snapshots", () => {
    const event = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-combined"),
      payload: {
        taskId: RuntimeTaskId.make("agent-2"),
        description: "Agent two",
        summary: "Inspecting the panel",
        typedUsage: { totalTokens: 4_200, toolUses: 7 },
        status: "running",
      },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);
    const progressPayload = activities[0]?.payload as Record<string, unknown>;
    const usagePayload = activities[1]?.payload as Record<string, unknown>;

    expect(activities.map((activity) => activity.id)).toEqual([
      "task-progress:thread-1:agent-2",
      "task-usage:thread-1:agent-2",
    ]);
    expect(progressPayload.summary).toBe("Inspecting the panel");
    expect(progressPayload.status).toBe("running");
    expect(progressPayload).not.toHaveProperty("typedUsage");
    expect(usagePayload.typedUsage).toEqual({ totalTokens: 4_200, toolUses: 7 });
    expect(usagePayload.usageSnapshot).toBe(true);
    expect(usagePayload).not.toHaveProperty("status");
  });
});
describe("runtimeEventToActivities tool streaming persistence", () => {
  const accumulatedStdout = [
    "first line of output",
    ...Array.from({ length: 500 }, (_, index) => `Capturing frame ${index}/9028`),
  ].join("\n");
  const streamingData = {
    toolCallId: "tool-call-1",
    kind: "execute",
    command: "blender --render",
    rawOutput: { stdout: accumulatedStdout },
    content: [{ type: "content", content: { type: "text", text: accumulatedStdout } }],
  };

  it("persists tool.updated with the wire projection of data, not the accumulated stream", () => {
    const event = {
      ...base,
      type: "item.updated",
      eventId: EventId.make("evt-tool-streaming-updated"),
      payload: {
        itemType: "command_execution",
        status: "inProgress",
        title: "Render",
        detail: accumulatedStdout,
        data: streamingData,
      },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);

    expect(activities).toHaveLength(1);
    const payload = activities[0]?.payload as Record<string, unknown>;
    const data = payload.data as Record<string, unknown>;
    expect(payload.status).toBe("inProgress");
    expect(data.toolCallId).toBe("tool-call-1");
    expect(data.command).toBe("blender --render");
    expect(data.rawOutput).toEqual({ content: "first line of output" });
    expect(data.content).toBeUndefined();
    expect(JSON.stringify(data).length).toBeLessThan(1_000);
  });

  it("persists the full terminal payload on tool.completed", () => {
    const event = {
      ...base,
      type: "item.completed",
      eventId: EventId.make("evt-tool-streaming-completed"),
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: "Render",
        data: streamingData,
      },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);

    expect(activities).toHaveLength(1);
    const payload = activities[0]?.payload as Record<string, unknown>;
    expect(payload.data).toEqual(streamingData);
  });
});

describe("runtimeEventToActivities turn lifecycle", () => {
  it("persists queued-turn cancellation as a terminal activity", () => {
    const event = {
      ...base,
      type: "turn.aborted",
      eventId: EventId.make("evt-turn-aborted"),
      turnId: TurnId.make("turn-queued"),
      payload: { reason: "Queued follow-up cancelled." },
    } satisfies ProviderRuntimeEvent;

    expect(runtimeEventToActivities(event, { queuedFollowUpAborted: true })).toEqual([
      {
        id: "evt-turn-aborted",
        createdAt: base.createdAt,
        tone: "info",
        kind: "turn.aborted",
        summary: "Queued follow-up cancelled",
        payload: { queuedFollowUp: true, reason: "Queued follow-up cancelled." },
        turnId: "turn-queued",
      },
    ]);
  });
});

describe("runtimeEventToActivities persisted data bounds", () => {
  it("compacts oversized tool result data before persistence", () => {
    const event = {
      ...base,
      type: "item.completed",
      eventId: EventId.make("evt-large-tool-result"),
      turnId: TurnId.make("turn-large-tool-result"),
      itemId: RuntimeItemId.make("item-large-tool-result"),
      payload: {
        itemType: "dynamic_tool_call",
        status: "completed",
        title: "Large tool",
        data: { rawOutput: "x".repeat(100_000) },
      },
    } satisfies ProviderRuntimeEvent;

    const [activity] = runtimeEventToActivities(event);
    const payload = activity?.payload as Record<string, unknown>;
    const data = payload.data as Record<string, unknown>;
    expect(JSON.stringify(payload).length).toBeLessThan(40_000);
    expect(data).toMatchObject({
      truncated: true,
      originalLength: expect.any(Number),
      summary: expect.stringContaining("truncated value"),
      tail: expect.any(String),
    });
  });
});

describe("runtimeEventToActivities reasoning projection", () => {
  it("persists canonical reasoning deltas without projecting assistant text as activity", () => {
    const reasoning = {
      ...base,
      type: "content.delta",
      eventId: EventId.make("evt-reasoning"),
      turnId: TurnId.make("turn-1"),
      itemId: RuntimeItemId.make("item-reasoning"),
      payload: {
        streamKind: "reasoning_text",
        delta: "Inspecting the projection path",
      },
    } satisfies ProviderRuntimeEvent;
    const assistant = {
      ...reasoning,
      eventId: EventId.make("evt-assistant"),
      payload: {
        streamKind: "assistant_text",
        delta: "The projection is intact.",
      },
    } satisfies ProviderRuntimeEvent;

    expect(
      runtimeEventToActivities(reasoning, {
        reasoningActivity: {
          createdAt: base.createdAt,
          sequence: 7,
        },
      }),
    ).toEqual([
      {
        id: EventId.make("reasoning:thread-1:item-reasoning"),
        createdAt: base.createdAt,
        tone: "info",
        kind: "reasoning.delta",
        summary: "Thinking",
        payload: {
          itemId: RuntimeItemId.make("item-reasoning"),
          streamKind: "reasoning_text",
          detail: "Inspecting the projection path",
        },
        turnId: TurnId.make("turn-1"),
        sequence: 7,
      },
    ]);
    expect(runtimeEventToActivities(assistant)).toEqual([]);
  });
});

describe("runtimeEventToActivities user-input terminal projection", () => {
  for (const [outcome, summary, tone] of [
    ["submitted", "User input submitted", "info"],
    ["chat", "Continued in chat", "info"],
    ["cancelled", "User input cancelled", "info"],
    ["timed_out", "User input timed out", "error"],
    ["stale", "User input request expired", "error"],
    ["aborted", "User input aborted", "error"],
    ["process_exited", "User input interrupted by provider exit", "error"],
  ] as const) {
    it(`labels ${outcome} user input truthfully`, () => {
      const event = {
        ...base,
        type: "user-input.resolved",
        eventId: EventId.make(`evt-user-input-${outcome}`),
        turnId: TurnId.make("turn-1"),
        requestId: RuntimeRequestId.make("request-1"),
        payload: { outcome },
      } satisfies ProviderRuntimeEvent;

      expect(runtimeEventToActivities(event)[0]).toMatchObject({
        summary,
        tone,
        payload: { outcome },
      });
    });
  }

  it("does not label an unspecified terminal outcome as submitted", () => {
    const event = {
      ...base,
      type: "user-input.resolved",
      eventId: EventId.make("evt-user-input-unspecified"),
      turnId: TurnId.make("turn-1"),
      requestId: RuntimeRequestId.make("request-1"),
      payload: {},
    } satisfies ProviderRuntimeEvent;

    expect(runtimeEventToActivities(event)[0]).toMatchObject({
      summary: "User input resolved",
      tone: "info",
    });
  });
});
