import { describe, expect, it } from "vite-plus/test";

import { EventId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";

import { makeOmpRuntimeEventNormalizer } from "./OmpRuntimeEvents.ts";
import { runtimeEventToActivities } from "../../orchestration/Layers/ProviderRuntimeIngestion.ts";

const threadId = ThreadId.make("thread-omp-events");
const turnId = TurnId.make("turn-omp-events");
let eventSequence = 0;

function makeUnstartedNormalizer() {
  eventSequence = 0;
  return makeOmpRuntimeEventNormalizer({
    threadId,
    providerInstanceId: ProviderInstanceId.make("omp_work"),
    now: () => "2026-08-07T12:00:00.000Z",
    nextEventId: () => EventId.make(`event-omp-${++eventSequence}`),
    planArtifactUrl: (artifactId) => `local://omp-plans/${artifactId}`,
  });
}

function makeNormalizer() {
  const normalizer = makeUnstartedNormalizer();
  normalizer.expectTurn(turnId);
  normalizer.map({ type: "agent_start", clientTurnId: turnId });
  eventSequence = 0;
  return normalizer;
}

describe("OmpRuntimeEvents", () => {
  it("keeps one runtime item across id-less OMP assistant message frames", () => {
    const normalizer = makeNormalizer();
    const [started] = normalizer.map({
      type: "message_start",
      message: { role: "assistant" },
    });
    const [updated] = normalizer.map({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "OMP RPC WEB SMOKE",
      },
    });
    const [completed] = normalizer.map({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "OMP RPC WEB SMOKE" }],
      },
    });

    expect(started).toMatchObject({
      type: "item.started",
      payload: { itemType: "assistant_message", status: "inProgress" },
    });
    expect(started?.providerRefs).toBeUndefined();
    expect(updated).toMatchObject({
      itemId: started?.itemId,
      type: "content.delta",
      payload: {
        streamKind: "assistant_text",
        delta: "OMP RPC WEB SMOKE",
      },
    });
    expect(completed).toMatchObject({
      itemId: started?.itemId,
      type: "item.completed",
    });
    expect(completed?.payload).toEqual({
      itemType: "assistant_message",
      status: "completed",
    });
    const otherThreadId = ThreadId.make("thread-omp-events-other");
    const otherNormalizer = makeOmpRuntimeEventNormalizer({
      threadId: otherThreadId,
      providerInstanceId: ProviderInstanceId.make("omp_work"),
      now: () => "2026-08-07T12:00:00.000Z",
      nextEventId: () => EventId.make(`event-other-${++eventSequence}`),
      planArtifactUrl: (artifactId) => `local://omp-plans/${artifactId}`,
    });
    const otherTurnId = TurnId.make("turn-omp-events-other");
    otherNormalizer.expectTurn(otherTurnId);
    otherNormalizer.map({ type: "agent_start", clientTurnId: otherTurnId });
    const [otherStarted] = otherNormalizer.map({
      type: "message_start",
      message: { role: "assistant" },
    });
    expect(otherStarted?.itemId).not.toBe(started?.itemId);
  });

  it("preserves thinking deltas as canonical reasoning content without changing assistant text", () => {
    const normalizer = makeNormalizer();
    const [started] = normalizer.map({
      type: "message_start",
      message: { role: "assistant" },
    });
    const [reasoning] = normalizer.map({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "thinking_delta",
        delta: "Inspecting the projection path",
      },
    });
    const [assistant] = normalizer.map({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "The projection is intact.",
      },
    });

    expect(reasoning).toMatchObject({
      itemId: started?.itemId,
      type: "content.delta",
      payload: {
        streamKind: "reasoning_text",
        delta: "Inspecting the projection path",
      },
    });
    expect(assistant).toMatchObject({
      itemId: started?.itemId,
      type: "content.delta",
      payload: {
        streamKind: "assistant_text",
        delta: "The projection is intact.",
      },
    });
  });

  it("normalizes structured approvals with exact public decisions and redacted raw payload", () => {
    const [event] = makeNormalizer().map({
      type: "approval_request",
      id: "approval-1",
      sessionId: "native-session",
      toolCallId: "tool-1",
      toolName: "bash",
      approvalMode: "always-ask",
      tier: "exec",
      arguments: {
        command: "cat /private/tmp/secret.txt",
        path: "/private/tmp/secret.txt",
        apiKey: "sk-secret",
      },
      reason: "Command needs confirmation",
      details: ["Reads a protected path"],
      providerSafetyChecks: [],
      allowedDecisions: ["approve_once", "approve_session", "deny", "cancel"],
      sessionFile: "/private/tmp/omp/sessions/private.jsonl",
    });
    if (!event) throw new Error("expected event");
    expect(event).toMatchObject({
      providerInstanceId: "omp_work",
      threadId,
      turnId,
      type: "request.opened",
      requestId: `${threadId}:approval-1`,
      providerRefs: { providerRequestId: "approval-1", providerItemId: "tool-1" },
      payload: {
        requestType: "tool_approval",
        toolName: "bash",
        approvalMode: "always-ask",
        tier: "exec",
        args: {
          command: "cat /private/tmp/secret.txt",
          path: "[redacted-path]",
          apiKey: "[redacted-secret]",
        },
        reason: "Command needs confirmation",
        details: ["Reads a protected path"],
        providerSafetyChecks: [],
        allowedDecisions: ["accept", "acceptForSession", "decline", "cancel"],
      },
      raw: {
        source: "omp.rpc",
        method: "approval_request",
      },
    });
    expect(JSON.stringify(event.payload)).not.toContain("sk-secret");
    const payloadArgs =
      event.payload && typeof event.payload === "object" && "args" in event.payload
        ? event.payload.args
        : undefined;
    expect(payloadArgs).toMatchObject({
      path: "[redacted-path]",
      apiKey: "[redacted-secret]",
    });
    expect(JSON.stringify(event.raw?.payload)).not.toContain("sk-secret");
    expect(JSON.stringify(event.raw?.payload)).not.toContain("/private/tmp/omp");
  });

  it("settles approvals only from the authoritative native resolution", () => {
    const [event] = makeNormalizer().map({
      type: "approval_resolved",
      id: "approval-1",
      outcome: "accepted",
      decision: "approve_session",
    });
    expect(event).toMatchObject({
      type: "request.resolved",
      requestId: `${threadId}:approval-1`,
      providerRefs: { providerRequestId: "approval-1" },
      payload: {
        requestType: "tool_approval",
        outcome: "accepted",
        decision: "acceptForSession",
      },
    });
  });

  it("preserves rich multi-question asks, previews, recommendations, chat and notes", () => {
    const normalizer = makeNormalizer();
    const [requested] = normalizer.map({
      type: "extension_ui_request",
      id: "ask-1",
      method: "ask",
      timeout: 30_000,
      questions: [
        {
          id: "targets",
          header: "Targets",
          question: "Which targets?",
          options: [
            { label: "Web", description: "Browser", preview: "apps/web" },
            { label: "Mobile", description: "Native", preview: "apps/mobile" },
          ],
          multi: true,
          recommended: 0,
          allowCustom: true,
        },
      ],
    });
    expect(requested).toMatchObject({
      type: "user-input.requested",
      requestId: "ask-1",
      payload: {
        allowedActions: ["submit", "chat", "cancel"],
        timeout: 30_000,
        questions: [
          {
            id: "targets",
            header: "Targets",
            multiSelect: true,
            recommended: 0,
            allowCustom: true,
            options: [
              { label: "Web", description: "Browser", preview: "apps/web" },
              { label: "Mobile", description: "Native", preview: "apps/mobile" },
            ],
          },
        ],
      },
    });

    const [resolved] = normalizer.map({
      type: "extension_ui_resolved",
      id: "ask-1",
      method: "ask",
      outcome: "submitted",
      result: {
        kind: "submit",
        results: [
          {
            id: "targets",
            question: "Which targets?",
            options: ["Web", "Mobile"],
            multi: true,
            selectedOptions: ["Web", "Mobile"],
            customInput: "Desktop",
            note: "Keep parity",
          },
        ],
      },
    });
    expect(resolved).toMatchObject({
      type: "user-input.resolved",
      payload: {
        outcome: "submitted",
        answers: {
          targets: {
            selectedOptions: ["Web", "Mobile"],
            customInput: "Desktop",
            note: "Keep parity",
          },
        },
      },
    });
  });

  it("maps plan review metadata without exposing absolute artifact paths", () => {
    const [event] = makeNormalizer().map({
      type: "plan_review_request",
      id: "review-1",
      title: "Implement native OMP",
      path: "/private/tmp/omp/plans/native.md",
      planArtifactId: "native-plan-1",
      markdown: "# Native OMP",
      allowedContextStrategies: ["fresh", "preserve", "compact"],
      contextUsage: { tokens: 1000, contextWindow: 200000 },
      executionModels: [
        { provider: "anthropic", modelId: "claude-sonnet-4-5", thinkingLevel: "high" },
      ],
      defaultExecutionModel: {
        provider: "anthropic",
        modelId: "claude-sonnet-4-5",
        thinkingLevel: "high",
      },
    });
    expect(event).toMatchObject({
      type: "plan.review.requested",
      requestId: "review-1",
      payload: {
        title: "Implement native OMP",
        planArtifactId: "native-plan-1",
        planArtifactUrl: "local://omp-plans/native-plan-1",
        planMarkdown: "# Native OMP",
        allowedContextStrategies: ["fresh", "preserve", "compact"],
      },
    });
    expect(JSON.stringify(event)).not.toContain("/private/tmp/omp/plans");
    if (!event) throw new Error("expected plan review request");
    const [activity] = runtimeEventToActivities(event);
    expect(activity).toMatchObject({
      kind: "plan.review.requested",
      payload: {
        requestId: "review-1",
        title: "Implement native OMP",
        planArtifactId: "native-plan-1",
      },
    });
    const [resolvedEvent] = makeNormalizer().map({
      type: "plan_review_resolved",
      id: "review-1",
      outcome: "cancelled",
    });
    if (!resolvedEvent) throw new Error("expected plan review resolution");
    expect(runtimeEventToActivities(resolvedEvent)[0]).toMatchObject({
      kind: "plan.review.resolved",
      payload: { requestId: "review-1", outcome: "cancelled" },
    });
  });

  it("keeps oversized planMarkdown as a bounded string (not a truncated object)", () => {
    const hugeMarkdown = `# Plan\n\n${"step\n".repeat(20_000)}`;
    const [event] = makeNormalizer().map({
      type: "plan_review_request",
      id: "review-huge",
      title: "Huge plan",
      markdown: hugeMarkdown,
      allowedContextStrategies: ["fresh"],
    });
    expect(event?.type).toBe("plan.review.requested");
    const planMarkdown =
      event?.payload && typeof event.payload === "object" && "planMarkdown" in event.payload
        ? event.payload.planMarkdown
        : undefined;
    expect(typeof planMarkdown).toBe("string");
    expect(String(planMarkdown).length).toBeLessThan(hugeMarkdown.length);
    expect(String(planMarkdown)).toContain("truncated");
  });

  it("re-acks turn.started for t3_steer_applied even when the turn is already active", () => {
    const normalizer = makeNormalizer();
    // makeNormalizer already started `turnId`.
    expect(normalizer.map({ type: "agent_start", clientTurnId: turnId })).toEqual([]);
    const [steered] = normalizer.map({
      type: "t3_steer_applied",
      clientTurnId: turnId,
    });
    expect(steered).toMatchObject({
      type: "turn.started",
      turnId,
    });
  });

  it("maps queued follow-ups separately from native promotion", () => {
    const normalizer = makeNormalizer();
    const queuedTurnId = TurnId.make("turn-follow-up");
    const [queued] = normalizer.map({
      type: "follow_up_queued",
      clientTurnId: queuedTurnId,
      deliveryMode: "follow-up",
      optionFingerprint: "sha256:fixture",
      queuePosition: 1,
    });
    expect(queued).toMatchObject({
      type: "turn.queued",
      turnId: queuedTurnId,
      payload: {
        deliveryMode: "follow-up",
        optionFingerprint: "sha256:fixture",
        queuePosition: 1,
      },
    });
    if (!queued) throw new Error("expected queued turn");
    expect(runtimeEventToActivities(queued)[0]).toMatchObject({
      kind: "turn.queued",
      turnId: queuedTurnId,
      payload: {
        deliveryMode: "follow-up",
        optionFingerprint: "sha256:fixture",
        queuePosition: 1,
      },
    });

    const [started] = normalizer.map({
      type: "host_turn_promoted",
      clientTurnId: queuedTurnId,
      model: "fixture-model",
      thinkingLevel: "high",
    });
    expect(started).toMatchObject({
      type: "turn.started",
      turnId: queuedTurnId,
      payload: { model: "fixture-model", effort: "high" },
    });
    expect(normalizer.map({ type: "agent_start", clientTurnId: queuedTurnId })).toEqual([]);
  });

  it("projects model_changed and thinking_level_changed into session.configured modelSelection", () => {
    const normalizer = makeNormalizer();
    const [modelChanged] = normalizer.map({
      type: "model_changed",
      model: "anthropic/claude-sonnet-4-5",
      thinkingLevel: "high",
    });
    expect(modelChanged).toMatchObject({
      type: "session.configured",
      payload: {
        modelSelection: {
          instanceId: ProviderInstanceId.make("omp_work"),
          model: "anthropic/claude-sonnet-4-5",
          // Bare frames use OMP's advertised reasoning option id.
          options: [{ id: "reasoning", value: "high" }],
        },
      },
    });

    const [thinkingChanged] = normalizer.map({
      type: "thinking_level_changed",
      model: "anthropic/claude-sonnet-4-5",
      thinkingLevel: "medium",
    });
    expect(thinkingChanged).toMatchObject({
      type: "session.configured",
      payload: {
        modelSelection: {
          instanceId: ProviderInstanceId.make("omp_work"),
          model: "anthropic/claude-sonnet-4-5",
          options: [{ id: "reasoning", value: "medium" }],
        },
      },
    });
  });

  it("preserves embedded modelSelection options from adapter enrichment (fastMode + reasoning)", () => {
    const normalizer = makeNormalizer();
    const [event] = normalizer.map({
      type: "thinking_level_changed",
      model: "anthropic/claude-sonnet-4-5",
      thinkingLevel: "low",
      modelSelection: {
        instanceId: ProviderInstanceId.make("omp_work"),
        model: "anthropic/claude-sonnet-4-5",
        options: [
          { id: "reasoning", value: "low" },
          { id: "fastMode", value: true },
        ],
      },
    });
    expect(event).toMatchObject({
      type: "session.configured",
      payload: {
        modelSelection: {
          model: "anthropic/claude-sonnet-4-5",
          options: [
            { id: "reasoning", value: "low" },
            { id: "fastMode", value: true },
          ],
        },
      },
    });
  });

  it("bounds large approval arguments before activity persistence", () => {
    const normalizer = makeNormalizer();
    const hugeCommand = `cat <<'EOF'\n${"a".repeat(80_000)}\nEOF`;
    const [event] = normalizer.map({
      type: "approval_request",
      id: "approval-huge-args",
      toolName: "bash",
      tier: "exec",
      arguments: { command: hugeCommand },
      allowedDecisions: ["approve_once", "deny"],
    });
    if (!event) throw new Error("expected approval request");
    const [activity] = runtimeEventToActivities(event);
    const serialized = JSON.stringify(activity?.payload);
    expect(serialized.length).toBeLessThan(40_000);
    expect(activity?.payload).toMatchObject({
      args: {
        truncated: true,
        originalLength: expect.any(Number),
        summary: expect.stringContaining("truncated"),
        tail: expect.any(String),
      },
    });
    expect(serialized).not.toContain(hugeCommand);
  });

  it("removes explicit agent starts from expected turns without disturbing queued order", () => {
    const normalizer = makeNormalizer();
    const secondTurnId = TurnId.make("turn-expected-second");
    const thirdTurnId = TurnId.make("turn-expected-third");
    normalizer.expectTurn(secondTurnId);
    normalizer.expectTurn(thirdTurnId);

    expect(normalizer.map({ type: "agent_end", clientTurnId: turnId })[0]).toMatchObject({
      type: "turn.completed",
      turnId,
    });

    expect(normalizer.map({ type: "agent_start" })[0]).toMatchObject({
      type: "turn.started",
      turnId: secondTurnId,
    });
    expect(normalizer.map({ type: "agent_end", clientTurnId: secondTurnId })[0]).toMatchObject({
      type: "turn.completed",
      turnId: secondTurnId,
    });

    expect(normalizer.map({ type: "agent_start" })[0]).toMatchObject({
      type: "turn.started",
      turnId: thirdTurnId,
    });
    expect(normalizer.map({ type: "agent_end", clientTurnId: thirdTurnId })[0]).toMatchObject({
      type: "turn.completed",
      turnId: thirdTurnId,
    });

    const exited = normalizer.map({
      type: "t3_runtime_process_exited",
      outcome: "process_exited",
      exitCode: 1,
      stderrTail: "unexpected exit",
    });
    expect(exited).toHaveLength(1);
    expect(exited[0]).toMatchObject({ type: "session.exited" });
    expect(exited.some((event) => event.type === "turn.aborted")).toBe(false);
  });

  it("removes failed turn expectations before later id-less starts", () => {
    const normalizer = makeUnstartedNormalizer();
    const failedTurnId = TurnId.make("turn-expected-failed");
    const acceptedTurnId = TurnId.make("turn-expected-accepted");
    normalizer.expectTurn(failedTurnId);
    normalizer.expectTurn(acceptedTurnId);

    normalizer.cancelExpectedTurn(failedTurnId);

    expect(normalizer.map({ type: "agent_start" })[0]).toMatchObject({
      type: "turn.started",
      turnId: acceptedTurnId,
    });
    expect(normalizer.map({ type: "agent_end", clientTurnId: acceptedTurnId })[0]).toMatchObject({
      type: "turn.completed",
      turnId: acceptedTurnId,
    });
    const exited = normalizer.map({
      type: "t3_runtime_process_exited",
      outcome: "process_exited",
      exitCode: 1,
      stderrTail: "unexpected exit",
    });
    expect(exited).toHaveLength(1);
    expect(exited[0]).toMatchObject({ type: "session.exited" });
  });

  it("allocates unique event IDs for every exit-derived abort and session exit", () => {
    const normalizer = makeUnstartedNormalizer();
    const activeTurnId = TurnId.make("turn-exit-active");
    const firstQueuedTurnId = TurnId.make("turn-exit-queued-1");
    const secondQueuedTurnId = TurnId.make("turn-exit-queued-2");
    normalizer.expectTurn(activeTurnId);
    normalizer.map({ type: "agent_start", clientTurnId: activeTurnId });
    normalizer.expectTurn(firstQueuedTurnId);
    normalizer.expectTurn(secondQueuedTurnId);

    const exited = normalizer.map({
      type: "t3_runtime_process_exited",
      outcome: "process_exited",
      exitCode: 1,
      stderrTail: "unexpected exit",
    });

    expect(exited).toHaveLength(4);
    expect(exited.map((event) => event.type)).toEqual([
      "turn.aborted",
      "turn.aborted",
      "turn.aborted",
      "session.exited",
    ]);
    expect(
      exited.filter((event) => event.type === "turn.aborted").map((event) => event.turnId),
    ).toEqual([activeTurnId, firstQueuedTurnId, secondQueuedTurnId]);
    expect(new Set(exited.map((event) => event.eventId)).size).toBe(4);
  });
  it("settles a queued follow-up cancelled before promotion", () => {
    const normalizer = makeNormalizer();
    const queuedTurnId = TurnId.make("turn-follow-up-cancelled");
    normalizer.map({
      type: "follow_up_queued",
      clientTurnId: queuedTurnId,
      optionFingerprint: "sha256:cancelled",
      queuePosition: 1,
    });
    const [cancelled] = normalizer.map({
      type: "host_turn_cancelled",
      clientTurnId: queuedTurnId,
      outcome: "cancelled",
      reason: "Queue cleared",
    });
    expect(cancelled).toMatchObject({
      type: "turn.aborted",
      turnId: queuedTurnId,
      payload: { reason: "Queue cleared" },
    });
  });

  it("maps durable todo snapshots to the canonical turn plan", () => {
    const [event] = makeNormalizer().map({
      type: "todo_reminder",
      attempt: 1,
      maxAttempts: 3,
      todos: [
        { content: "Inspect transport", status: "completed" },
        { content: "Implement adapter", status: "in_progress" },
        { content: "Verify rollback", status: "blocked" },
      ],
    });
    expect(event).toMatchObject({
      type: "turn.plan.updated",
      payload: {
        plan: [
          { step: "Inspect transport", status: "completed" },
          { step: "Implement adapter", status: "inProgress" },
          { step: "Verify rollback", status: "pending" },
        ],
      },
    });
  });

  it("preserves native subagent progress and parent-tool linkage", () => {
    const [event] = makeNormalizer().map({
      type: "subagent_progress",
      payload: {
        index: 0,
        agent: "task",
        parentToolCallId: "tool-parent",
        progress: {
          id: "SubagentA",
          status: "running",
          description: "Implement transport",
          lastToolName: "read",
        },
      },
    });
    expect(event).toMatchObject({
      type: "task.progress",
      payload: {
        taskId: "omp-SubagentA",
        agentId: "SubagentA",
        toolUseId: "tool-parent",
        description: "Implement transport",
        lastToolName: "read",
      },
    });
  });

  it("coalesces repeated OMP tool updates by stable item identity", () => {
    const normalizer = makeNormalizer();
    const [firstEvent] = normalizer.map({
      type: "tool_execution_update",
      toolCallId: "tool-streaming-command",
      toolName: "bash",
      args: { command: "bun run test" },
      partialResult: { content: "first chunk" },
    });
    const [secondEvent] = normalizer.map({
      type: "tool_execution_update",
      toolCallId: "tool-streaming-command",
      toolName: "bash",
      args: { command: "bun run test" },
      partialResult: { content: "latest chunk" },
    });
    if (!firstEvent || !secondEvent) throw new Error("expected tool updates");

    const [firstActivity] = runtimeEventToActivities(firstEvent);
    const [secondActivity] = runtimeEventToActivities(secondEvent);

    expect(firstActivity?.id).toBe(secondActivity?.id);
    expect(secondActivity).toMatchObject({
      kind: "tool.updated",
      payload: {
        itemId: "omp-tool-streaming-command",
        data: { item: { result: { content: "latest chunk" } } },
      },
    });
  });

  it("preserves failed terminal tool status and error presentation in canonical activities", () => {
    const normalizer = makeNormalizer();
    normalizer.map({
      type: "tool_execution_start",
      toolCallId: "tool-failed-command",
      toolName: "bash",
      args: { command: "bun run test" },
    });
    const [event] = normalizer.map({
      type: "tool_execution_end",
      toolCallId: "tool-failed-command",
      toolName: "bash",
      result: { content: "tests failed" },
      isError: true,
    });
    if (!event) throw new Error("expected failed tool completion");

    const [activity] = runtimeEventToActivities(event);

    expect(activity).toMatchObject({
      tone: "error",
      kind: "tool.completed",
      summary: "bash failed",
      payload: {
        itemId: "omp-tool-failed-command",
        itemType: "command_execution",
        status: "failed",
      },
    });
  });

  it("bounds large tool partialResult/result before activity persistence", () => {
    const normalizer = makeNormalizer();
    const huge = "x".repeat(80_000);
    const [event] = normalizer.map({
      type: "tool_execution_end",
      toolCallId: "tool-huge-result",
      toolName: "bash",
      args: { command: "cat huge.log" },
      result: { content: huge },
    });
    if (!event) throw new Error("expected tool completion");
    const [activity] = runtimeEventToActivities(event);
    const serialized = JSON.stringify(activity?.payload);
    expect(serialized.length).toBeLessThan(40_000);
    expect(activity?.payload).toMatchObject({
      data: {
        item: {
          result: {
            truncated: true,
            originalLength: expect.any(Number),
            summary: expect.stringContaining("truncated"),
            tail: expect.any(String),
          },
        },
      },
    });
    expect(serialized).not.toContain(huge);
  });

  it("bounds large tool intent before activity persistence", () => {
    const normalizer = makeNormalizer();
    const huge = "i".repeat(80_000);
    const [event] = normalizer.map({
      type: "tool_execution_update",
      toolCallId: "tool-huge-intent",
      toolName: "bash",
      intent: { explanation: huge },
    });
    if (!event) throw new Error("expected tool update");
    const [activity] = runtimeEventToActivities(event);
    const serialized = JSON.stringify(activity?.payload);
    expect(serialized.length).toBeLessThan(40_000);
    expect(activity?.payload).toMatchObject({
      data: {
        intent: {
          truncated: true,
          originalLength: expect.any(Number),
          summary: expect.stringContaining("truncated"),
          tail: expect.any(String),
        },
      },
    });
    expect(serialized).not.toContain(huge);
  });

  it("bounds large tool arguments before activity persistence", () => {
    const normalizer = makeNormalizer();
    const hugePatch = "p".repeat(80_000);
    const [event] = normalizer.map({
      type: "tool_execution_start",
      toolCallId: "tool-huge-args",
      toolName: "edit",
      args: {
        path: "apps/server/src/big.ts",
        newText: hugePatch,
      },
    });
    if (!event) throw new Error("expected tool start");
    const [activity] = runtimeEventToActivities(event);
    const serialized = JSON.stringify(activity?.payload);
    expect(serialized.length).toBeLessThan(40_000);
    expect(activity?.payload).toMatchObject({
      data: {
        item: {
          input: {
            truncated: true,
            originalLength: expect.any(Number),
            summary: expect.stringContaining("truncated"),
            tail: expect.any(String),
          },
        },
      },
    });
    expect(serialized).not.toContain(hugePatch);
  });

  it("bounds large command_execution command summaries duplicated onto data.command", () => {
    const normalizer = makeNormalizer();
    const hugeCommand = `cat <<'EOF'\n${"c".repeat(80_000)}\nEOF`;
    const [event] = normalizer.map({
      type: "tool_execution_start",
      toolCallId: "tool-huge-command",
      toolName: "bash",
      args: { command: hugeCommand },
    });
    if (!event) throw new Error("expected tool start");
    const [activity] = runtimeEventToActivities(event);
    const serialized = JSON.stringify(activity?.payload);
    expect(serialized.length).toBeLessThan(40_000);
    expect(activity?.payload).toMatchObject({
      data: {
        command: {
          truncated: true,
          originalLength: hugeCommand.length,
          summary: expect.stringContaining("truncated"),
          tail: expect.any(String),
        },
        item: {
          command: {
            truncated: true,
            originalLength: hugeCommand.length,
          },
          input: {
            truncated: true,
            originalLength: expect.any(Number),
          },
        },
      },
    });
    expect(serialized).not.toContain(hugeCommand);
  });

  it("redacts secrets before serializing bounded result tails", () => {
    const normalizer = makeNormalizer();
    const padding = "x".repeat(40_000);
    const [event] = normalizer.map({
      type: "tool_execution_end",
      toolCallId: "tool-secret-tail",
      toolName: "bash",
      args: { command: "printenv" },
      result: {
        padding,
        apiKey: "sk-live-secret-value",
        authorization: "Bearer secret-token",
      },
    });
    if (!event) throw new Error("expected tool completion");
    const [activity] = runtimeEventToActivities(event);
    const serialized = JSON.stringify(activity?.payload);
    expect(serialized.length).toBeLessThan(40_000);
    expect(serialized).not.toContain("sk-live-secret-value");
    expect(serialized).not.toContain("Bearer secret-token");
    expect(serialized).toContain("[redacted-secret]");
    expect(activity?.payload).toMatchObject({
      data: {
        item: {
          result: {
            truncated: true,
            tail: expect.any(String),
          },
        },
      },
    });
  });

  it("normalizes OMP command and file arguments into canonical item fields", () => {
    const normalizer = makeNormalizer();
    normalizer.map({
      type: "tool_execution_start",
      toolCallId: "tool-command",
      toolName: "bash",
      args: { command: ["bun", "run", "lint"] },
    });
    const [commandEvent] = normalizer.map({
      type: "tool_execution_end",
      toolCallId: "tool-command",
      toolName: "bash",
      result: { content: "ok" },
    });
    normalizer.map({
      type: "tool_execution_start",
      toolCallId: "tool-file",
      toolName: "edit",
      args: { path: "apps/web/src/App.tsx", oldText: "before", newText: "after" },
    });
    const [fileEvent] = normalizer.map({
      type: "tool_execution_end",
      toolCallId: "tool-file",
      toolName: "edit",
      result: { content: "updated" },
    });
    if (!commandEvent || !fileEvent) throw new Error("expected tool completions");

    const [commandActivity] = runtimeEventToActivities(commandEvent);
    const [fileActivity] = runtimeEventToActivities(fileEvent);

    expect(commandActivity?.payload).toMatchObject({
      data: {
        command: ["bun", "run", "lint"],
        item: {
          command: ["bun", "run", "lint"],
          input: { command: ["bun", "run", "lint"] },
        },
      },
    });
    expect(fileActivity?.payload).toMatchObject({
      data: {
        item: {
          input: { path: "apps/web/src/App.tsx", oldText: "before", newText: "after" },
        },
      },
    });
  });
  it("bounds raw frames independently of canonical payloads", () => {
    const [event] = makeNormalizer().map({
      type: "tool_execution_end",
      toolCallId: "tool-large-raw",
      toolName: "bash",
      result: "x".repeat(100_000),
    });
    if (!event) throw new Error("expected tool completion");

    const serializedRaw = JSON.stringify(event.raw?.payload);
    expect(serializedRaw.length).toBeLessThan(40_000);
    expect(event.raw?.payload).toMatchObject({ truncated: true });
  });

  it("drops unfinished tool arguments when a turn ends", () => {
    const normalizer = makeNormalizer();
    normalizer.map({
      type: "tool_execution_start",
      toolCallId: "tool-reused-after-abort",
      toolName: "bash",
      args: { command: "secret old command" },
    });
    normalizer.map({ type: "agent_end", clientTurnId: turnId, aborted: true });

    const nextTurnId = TurnId.make("turn-after-abort");
    normalizer.expectTurn(nextTurnId);
    normalizer.map({ type: "agent_start", clientTurnId: nextTurnId });
    const [completed] = normalizer.map({
      type: "tool_execution_end",
      toolCallId: "tool-reused-after-abort",
      toolName: "bash",
      result: "done",
    });
    expect(JSON.stringify(completed?.payload)).not.toContain("secret old command");
  });
});
