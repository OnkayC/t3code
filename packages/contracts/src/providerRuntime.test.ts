import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { classifyTaskAgentKind, ProviderRuntimeEvent } from "./providerRuntime.ts";

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

describe("ProviderRuntimeEvent", () => {
  it("accepts fork-provided driver kinds as branded slugs", () => {
    const parsed = decodeRuntimeEvent({
      type: "session.started",
      eventId: "event-ollama-session",
      provider: "ollama",
      providerInstanceId: "ollama_local",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      payload: {
        message: "started",
      },
    });

    expect(parsed.provider).toBe("ollama");
    expect(parsed.providerInstanceId).toBe("ollama_local");
  });

  it("decodes turn.plan.updated for plan rendering", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.plan.updated",
      eventId: "event-1",
      provider: "claudeAgent",
      sessionId: "runtime-session-1",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        explanation: "Implement schema updates",
        plan: [
          { step: "Define event union", status: "completed" },
          { step: "Wire adapter mapping", status: "inProgress" },
        ],
      },
    });

    expect(parsed.type).toBe("turn.plan.updated");
    if (parsed.type !== "turn.plan.updated") {
      throw new Error("expected turn.plan.updated");
    }
    expect(parsed.payload.plan).toHaveLength(2);
    expect(parsed.payload.plan[1]?.status).toBe("inProgress");
  });

  it("decodes proposed-plan completion events", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.proposed.completed",
      eventId: "event-proposed-plan-1",
      provider: "codex",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        planMarkdown: "# Ship it",
      },
    });

    expect(parsed.type).toBe("turn.proposed.completed");
    if (parsed.type !== "turn.proposed.completed") {
      throw new Error("expected turn.proposed.completed");
    }
    expect(parsed.payload.planMarkdown).toBe("# Ship it");
  });

  it("decodes user-input.requested with structured questions", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.requested",
      eventId: "event-2",
      provider: "claudeAgent",
      sessionId: "runtime-session-2",
      createdAt: "2026-02-28T00:00:01.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow edits in workspace only",
              },
              {
                label: "danger-full-access",
                description: "Allow unrestricted access",
              },
            ],
          },
        ],
      },
    });

    expect(parsed.type).toBe("user-input.requested");
    if (parsed.type !== "user-input.requested") {
      throw new Error("expected user-input.requested");
    }
    expect(parsed.payload.questions[0]?.id).toBe("sandbox_mode");
    expect(parsed.payload.questions[0]?.options).toHaveLength(2);
  });

  it("decodes user-input.resolved with answer map", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.resolved",
      eventId: "event-3",
      provider: "claudeAgent",
      sessionId: "runtime-session-2",
      createdAt: "2026-02-28T00:00:02.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
    });

    expect(parsed.type).toBe("user-input.resolved");
    if (parsed.type !== "user-input.resolved") {
      throw new Error("expected user-input.resolved");
    }
    expect(parsed.payload.answers?.sandbox_mode).toBe("workspace-write");
  });

  it("rejects legacy message.delta type", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "message.delta",
        eventId: "event-4",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        payload: { delta: "legacy" },
      }),
    ).toThrow();
  });

  it("rejects empty branded canonical ids", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "runtime.error",
        eventId: "event-5",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        threadId: "   ",
        payload: { message: "boom" },
      }),
    ).toThrow();
  });

  it("decodes normalized thread token usage snapshots", () => {
    const parsed = decodeRuntimeEvent({
      type: "thread.token-usage.updated",
      eventId: "event-token-usage-1",
      provider: "claudeAgent",
      createdAt: "2026-02-28T00:00:04.000Z",
      threadId: "thread-1",
      payload: {
        usage: {
          usedTokens: 31251,
          maxTokens: 200000,
          toolUses: 25,
          durationMs: 43567,
        },
      },
    });

    expect(parsed.type).toBe("thread.token-usage.updated");
    if (parsed.type !== "thread.token-usage.updated") {
      throw new Error("expected thread.token-usage.updated");
    }
    expect(parsed.payload.usage.maxTokens).toBe(200000);
    expect(parsed.payload.usage.usedTokens).toBe(31251);
  });
  it("decodes structured approvals and authoritative terminal outcomes", () => {
    const opened = decodeRuntimeEvent({
      type: "request.opened",
      eventId: "event-approval-opened",
      provider: "omp",
      providerInstanceId: "omp",
      createdAt: "2026-02-28T00:00:05.000Z",
      threadId: "thread-1",
      requestId: "approval-1",
      raw: { source: "omp.rpc", method: "approval_request", payload: {} },
      payload: {
        requestType: "tool_approval",
        toolName: "bash",
        approvalMode: "always-ask",
        tier: "exec",
        args: { command: "git status" },
        reason: "Runs a workspace command",
        details: ["Command executes in the thread workspace"],
        providerSafetyChecks: ["network access"],
        allowedDecisions: ["accept", "decline", "cancel"],
      },
    });
    const resolved = decodeRuntimeEvent({
      type: "request.resolved",
      eventId: "event-approval-resolved",
      provider: "omp",
      createdAt: "2026-02-28T00:00:06.000Z",
      threadId: "thread-1",
      requestId: "approval-1",
      payload: {
        requestType: "tool_approval",
        outcome: "accepted",
        decision: "accept",
      },
    });

    expect(opened.type).toBe("request.opened");
    if (opened.type !== "request.opened") throw new Error("expected request.opened");
    expect(opened.payload.allowedDecisions).toEqual(["accept", "decline", "cancel"]);
    expect(opened.raw?.source).toBe("omp.rpc");
    expect(resolved.type).toBe("request.resolved");
    if (resolved.type !== "request.resolved") throw new Error("expected request.resolved");
    expect(resolved.payload.outcome).toBe("accepted");
  });

  it("decodes rich user input and non-submit terminal outcomes", () => {
    const requested = decodeRuntimeEvent({
      type: "user-input.requested",
      eventId: "event-rich-ask",
      provider: "omp",
      createdAt: "2026-02-28T00:00:07.000Z",
      threadId: "thread-1",
      requestId: "ask-1",
      payload: {
        questions: [
          {
            id: "targets",
            question: "Where should this deploy?",
            options: [
              { label: "Web", preview: "https://preview.example.test" },
              { label: "Mobile", description: "Native clients" },
            ],
            multiSelect: true,
            recommended: 0,
            allowCustom: true,
          },
        ],
        allowedActions: ["submit", "chat", "cancel"],
        timeout: 30000,
      },
    });
    const resolved = decodeRuntimeEvent({
      type: "user-input.resolved",
      eventId: "event-rich-ask-resolved",
      provider: "omp",
      createdAt: "2026-02-28T00:00:08.000Z",
      threadId: "thread-1",
      requestId: "ask-1",
      payload: { outcome: "chat" },
    });

    expect(requested.type).toBe("user-input.requested");
    if (requested.type !== "user-input.requested") {
      throw new Error("expected user-input.requested");
    }
    expect(requested.payload.questions[0]?.header).toBeUndefined();
    expect(requested.payload.questions[0]?.options[0]?.preview).toContain("preview");
    expect(requested.payload.allowedActions).toEqual(["submit", "chat", "cancel"]);
    expect(resolved.type).toBe("user-input.resolved");
    if (resolved.type !== "user-input.resolved") throw new Error("expected resolved ask");
    expect(resolved.payload.outcome).toBe("chat");
  });

  it("decodes a rotated native resume cursor on session configuration", () => {
    const configured = decodeRuntimeEvent({
      type: "session.configured",
      eventId: "event-session-configured",
      provider: "omp",
      createdAt: "2026-02-28T00:00:08.500Z",
      threadId: "thread-1",
      payload: {
        config: {},
        resumeCursor: {
          schemaVersion: 1,
          sessionKey: "sessions/omp-session.jsonl",
          sessionId: "omp-session",
        },
      },
    });

    expect(configured.type).toBe("session.configured");
    if (configured.type !== "session.configured") throw new Error("expected configuration");
    expect(configured.payload.resumeCursor).toEqual({
      schemaVersion: 1,
      sessionKey: "sessions/omp-session.jsonl",
      sessionId: "omp-session",
    });
  });

  it("decodes queued turns and same-thread plan review lifecycle", () => {
    const queued = decodeRuntimeEvent({
      type: "turn.queued",
      eventId: "event-turn-queued",
      provider: "omp",
      createdAt: "2026-02-28T00:00:09.000Z",
      threadId: "thread-1",
      turnId: "turn-follow-up",
      payload: {
        deliveryMode: "follow-up",
        optionFingerprint: "sha256:abc",
        queuePosition: 2,
      },
    });
    const requested = decodeRuntimeEvent({
      type: "plan.review.requested",
      eventId: "event-plan-review",
      provider: "omp",
      createdAt: "2026-02-28T00:00:10.000Z",
      threadId: "thread-1",
      requestId: "plan-review-1",
      payload: {
        title: "Implementation plan",
        planArtifactId: "plan-abc",
        planArtifactUrl: "local://plans/plan-abc",
        planMarkdown: "# Plan\n\nShip it.",
        allowedContextStrategies: ["fresh", "preserve", "compact"],
        contextUsage: { usedTokens: 1000, maxTokens: 10000 },
        executionModels: [{ provider: "anthropic", modelId: "claude-sonnet" }],
        defaultExecutionModel: { provider: "anthropic", modelId: "claude-sonnet" },
      },
    });
    const resolved = decodeRuntimeEvent({
      type: "plan.review.resolved",
      eventId: "event-plan-review-resolved",
      provider: "omp",
      createdAt: "2026-02-28T00:00:11.000Z",
      threadId: "thread-1",
      requestId: "plan-review-1",
      turnId: "turn-plan-execute",
      payload: {
        outcome: "executing",
        clientTurnId: "turn-plan-execute",
        planDigest: "sha256:def",
        decision: {
          action: "execute",
          context: "compact",
          clientTurnId: "turn-plan-execute",
        },
      },
    });

    expect(queued.type).toBe("turn.queued");
    if (queued.type !== "turn.queued") throw new Error("expected turn.queued");
    expect(queued.payload.queuePosition).toBe(2);
    expect(requested.type).toBe("plan.review.requested");
    if (requested.type !== "plan.review.requested") throw new Error("expected plan review");
    expect(requested.payload.allowedContextStrategies).toContain("compact");
    expect(resolved.type).toBe("plan.review.resolved");
    if (resolved.type !== "plan.review.resolved") throw new Error("expected plan resolution");
    expect(resolved.payload.outcome).toBe("executing");
  });
});

describe("classifyTaskAgentKind", () => {
  it("classifies agent-flavored, watch-loop, and inert types", () => {
    expect(classifyTaskAgentKind({ taskType: "local_agent" })).toBe("agent");
    expect(classifyTaskAgentKind({ taskType: "local_workflow" })).toBe("agent");
    expect(classifyTaskAgentKind({ taskType: undefined })).toBe("agent");
    expect(classifyTaskAgentKind({ taskType: "brand_new_agent_type" })).toBe("agent");
    expect(classifyTaskAgentKind({ taskType: "local_bash" })).toBe("background");
    expect(classifyTaskAgentKind({ taskType: "monitor" })).toBe("background");
    expect(classifyTaskAgentKind({ taskType: "plan" })).toBe("background");
  });

  it("agent-owned tasks are background unless themselves agent-flavored", () => {
    expect(classifyTaskAgentKind({ taskType: "local_bash", agentId: "owner" })).toBe("background");
    expect(classifyTaskAgentKind({ taskType: undefined, agentId: "owner" })).toBe("background");
    // Nested agent: outlives its parent, stays in the roster.
    expect(classifyTaskAgentKind({ taskType: "local_agent", agentId: "owner" })).toBe("agent");
  });
});
