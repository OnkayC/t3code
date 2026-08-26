import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";

import {
  createPlanReviewResponseCoordinator,
  foldProviderInteractionActivities,
  resolveProviderTurnDeliveryMode,
  samePlanReviewResponseScope,
} from "./providerInteractionRuntime.ts";

function activity(
  kind: string,
  payload: Record<string, unknown>,
  sequence: number,
): OrchestrationThreadActivity {
  return {
    id: `event-${sequence}`,
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: payload.turnId === undefined ? null : String(payload.turnId),
    sequence,
    createdAt: `2026-06-01T00:00:${String(sequence).padStart(2, "0")}.000Z`,
  } as OrchestrationThreadActivity;
}

describe("resolveProviderTurnDeliveryMode", () => {
  const nativeFollowUpProvider = {
    supportedTurnDeliveryModes: ["steer", "follow-up"],
  } as const;

  it("maps queued delivery to native follow-up only when advertised", () => {
    expect(
      resolveProviderTurnDeliveryMode({ intent: "queue", provider: nativeFollowUpProvider }),
    ).toBe("follow-up");
    expect(
      resolveProviderTurnDeliveryMode({
        intent: "queue",
        provider: { supportedTurnDeliveryModes: ["steer"] },
      }),
    ).toBeUndefined();
  });

  it("keeps ordinary sends implicit and explicit steering explicit", () => {
    expect(
      resolveProviderTurnDeliveryMode({ intent: "send", provider: nativeFollowUpProvider }),
    ).toBeUndefined();
    expect(
      resolveProviderTurnDeliveryMode({ intent: "steer", provider: nativeFollowUpProvider }),
    ).toBe("steer");
  });
});

describe("foldProviderInteractionActivities", () => {
  it("settles approval and rich-input requests from authoritative terminal activities", () => {
    const state = foldProviderInteractionActivities([
      activity(
        "request.opened",
        {
          requestId: "approval-1",
          requestType: "tool_approval",
          toolName: "bash",
          tier: "exec",
          allowedDecisions: ["accept", "decline"],
        },
        1,
      ),
      activity(
        "user-input.requested",
        {
          requestId: "ask-1",
          questions: [{ id: "target", question: "Target?", options: [] }],
          allowedActions: ["submit", "chat", "cancel"],
        },
        2,
      ),
      activity(
        "request.resolved",
        { requestId: "approval-1", outcome: "accepted", decision: "accept" },
        3,
      ),
      activity("user-input.resolved", { requestId: "ask-1", outcome: "chat" }, 4),
    ]);

    expect(state.pendingRequests).toEqual([]);
    expect(state.pendingUserInputs).toEqual([]);
    expect(state.resolvedRequests[0]).toMatchObject({
      requestId: "approval-1",
      outcome: "accepted",
    });
    expect(state.resolvedUserInputs[0]).toMatchObject({ requestId: "ask-1", outcome: "chat" });
  });

  it("accepts legacy approval activity aliases emitted by orchestration ingestion", () => {
    const state = foldProviderInteractionActivities([
      activity(
        "approval.requested",
        { requestId: "approval-legacy", requestType: "tool_approval" },
        1,
      ),
      activity(
        "approval.resolved",
        { requestId: "approval-legacy", outcome: "accepted", decision: "accept" },
        2,
      ),
    ]);

    expect(state.pendingRequests).toEqual([]);
    expect(state.resolvedRequests[0]).toMatchObject({
      requestId: "approval-legacy",
      outcome: "accepted",
      decision: "accept",
    });
  });

  it("tracks queued follow-ups and same-thread plan review without provider-specific state", () => {
    const state = foldProviderInteractionActivities([
      activity(
        "turn.queued",
        {
          turnId: "turn-follow-up",
          deliveryMode: "follow-up",
          optionFingerprint: "sha256:abc",
          queuePosition: 1,
        },
        1,
      ),
      activity(
        "plan.review.requested",
        {
          requestId: "plan-review-1",
          title: "Plan",
          planArtifactId: "artifact-1",
          planArtifactUrl: "local://plans/artifact-1",
          planMarkdown: "# Plan",
          allowedContextStrategies: ["fresh", "compact"],
        },
        2,
      ),
      activity("turn.started", { turnId: "turn-follow-up" }, 3),
      activity("plan.review.resolved", { requestId: "plan-review-1", outcome: "cancelled" }, 4),
    ]);

    expect(state.queuedTurns).toEqual([]);
    expect(state.planReview).toBeNull();
    expect(state.lastPlanReviewResolution).toMatchObject({
      requestId: "plan-review-1",
      outcome: "cancelled",
    });
  });

  it("folds turn.queued before same-timestamp terminal lifecycle so banners clear", () => {
    const sharedTime = "2026-06-01T00:00:00.000Z";
    const make = (
      kind: string,
      payload: Record<string, unknown>,
      id: string,
    ): OrchestrationThreadActivity =>
      ({
        id,
        tone: "info",
        kind,
        summary: kind,
        payload,
        turnId: "turn-race",
        // Same sequence forces time + kind ranking.
        sequence: 1,
        createdAt: sharedTime,
      }) as OrchestrationThreadActivity;

    // Intentionally list completed before queued; fold sort must still clear.
    const state = foldProviderInteractionActivities([
      make("turn.completed", { turnId: "turn-race" }, "event-z-completed"),
      make(
        "turn.queued",
        {
          turnId: "turn-race",
          deliveryMode: "follow-up",
          optionFingerprint: "sha256:race",
          queuePosition: 1,
        },
        "event-a-queued",
      ),
    ]);

    expect(state.queuedTurns).toEqual([]);
  });

  it("keeps plan review open after a nonterminal respond failure", () => {
    const state = foldProviderInteractionActivities([
      activity(
        "plan.review.requested",
        {
          requestId: "plan-review-retry",
          title: "Plan",
          planArtifactId: "artifact-1",
          planArtifactUrl: "local://plans/artifact-1",
          planMarkdown: "# Plan",
          allowedContextStrategies: ["fresh"],
        },
        1,
      ),
      activity(
        "provider.plan-review.respond.failed",
        {
          requestId: "plan-review-retry",
          detail: "provider connection reset",
        },
        2,
      ),
    ]);

    expect(state.planReview?.requestId).toBe("plan-review-retry");
    expect(state.lastPlanReviewResolution).toBeNull();
    expect(state.lastPlanReviewRespondFailure).toMatchObject({
      requestId: "plan-review-retry",
      payload: { detail: "provider connection reset" },
    });
  });

  it("releases the response coordinator when fold surfaces a reactor respond failure", () => {
    const coordinator = createPlanReviewResponseCoordinator();
    const responseScope = {
      environmentId: "env-1",
      threadId: "thread-a",
      requestId: "plan-review-retry",
    };
    expect(coordinator.begin(responseScope)).toBe(true);

    const state = foldProviderInteractionActivities([
      activity(
        "plan.review.requested",
        {
          requestId: "plan-review-retry",
          title: "Plan",
          planArtifactId: "artifact-1",
          planArtifactUrl: "local://plans/artifact-1",
          planMarkdown: "# Plan",
          allowedContextStrategies: ["fresh"],
        },
        1,
      ),
      activity(
        "provider.plan-review.respond.failed",
        {
          requestId: "plan-review-retry",
          detail: "provider connection reset",
        },
        2,
      ),
    ]);

    // Open review stays; failure record drives guard release for retry.
    expect(state.planReview?.requestId).toBe("plan-review-retry");
    expect(state.lastPlanReviewRespondFailure?.requestId).toBe("plan-review-retry");
    expect(
      coordinator.fail({
        ...responseScope,
        requestId: state.lastPlanReviewRespondFailure!.requestId,
      }),
    ).toBe(true);
    expect(coordinator.scope()).toBeNull();
    // reconcile alone would keep the guard (request still open).
    expect(coordinator.begin(responseScope)).toBe(true);
    expect(
      coordinator.reconcile({
        environmentId: responseScope.environmentId,
        threadId: responseScope.threadId,
        requestId: state.planReview?.requestId ?? null,
      }),
    ).toBe(false);
    expect(coordinator.fail(responseScope)).toBe(true);
  });

  it("clears respond-failure state when a new review is requested or resolved", () => {
    const failed = foldProviderInteractionActivities([
      activity("plan.review.requested", { requestId: "plan-1" }, 1),
      activity(
        "provider.plan-review.respond.failed",
        { requestId: "plan-1", detail: "timeout" },
        2,
      ),
    ]);
    expect(failed.lastPlanReviewRespondFailure?.requestId).toBe("plan-1");

    const afterResolve = foldProviderInteractionActivities([
      activity("plan.review.requested", { requestId: "plan-1" }, 1),
      activity(
        "provider.plan-review.respond.failed",
        { requestId: "plan-1", detail: "timeout" },
        2,
      ),
      activity("plan.review.resolved", { requestId: "plan-1", outcome: "cancelled" }, 3),
    ]);
    expect(afterResolve.lastPlanReviewRespondFailure).toBeNull();

    const afterNewRequest = foldProviderInteractionActivities([
      activity("plan.review.requested", { requestId: "plan-1" }, 1),
      activity(
        "provider.plan-review.respond.failed",
        { requestId: "plan-1", detail: "timeout" },
        2,
      ),
      activity("plan.review.requested", { requestId: "plan-2" }, 3),
    ]);
    expect(afterNewRequest.lastPlanReviewRespondFailure).toBeNull();
    expect(afterNewRequest.planReview?.requestId).toBe("plan-2");
  });

  it("retains multi-thread plan review response guards until each request resolves", () => {
    const coordinator = createPlanReviewResponseCoordinator();
    const scopeA = {
      environmentId: "env-1",
      threadId: "thread-a",
      requestId: "review-1",
    };
    const scopeB = {
      environmentId: "env-1",
      threadId: "thread-b",
      requestId: "review-1",
    };

    expect(coordinator.begin(scopeA)).toBe(true);
    expect(coordinator.begin(scopeB)).toBe(true);
    expect(coordinator.reconcile({ ...scopeB, requestId: "review-1" })).toBe(false);
    expect(
      coordinator.reconcile({ environmentId: "env-1", threadId: "thread-a", requestId: null }),
    ).toBe(true);
    expect(coordinator.fail(scopeB)).toBe(true);
  });

  it("matches presentation scopes by full environment/thread/request identity", () => {
    const scopeA = {
      environmentId: "env-1",
      threadId: "thread-a",
      requestId: "review-1",
    };
    expect(
      samePlanReviewResponseScope(scopeA, {
        environmentId: "env-1",
        threadId: "thread-b",
        requestId: "review-1",
      }),
    ).toBe(false);
    expect(samePlanReviewResponseScope(scopeA, scopeA)).toBe(true);
    expect(samePlanReviewResponseScope(null, scopeA)).toBe(false);
  });

  it("ignores unknown additive terminal metadata without poisoning typed state", () => {
    const state = foldProviderInteractionActivities([
      activity("request.resolved", { requestId: "approval-future", outcome: "future" }, 1),
      activity("user-input.resolved", { requestId: "ask-future", outcome: "future" }, 2),
      activity("plan.review.resolved", { requestId: "plan-future", outcome: "future" }, 3),
    ]);

    expect(state.resolvedRequests[0]?.outcome).toBeUndefined();
    expect(state.resolvedUserInputs[0]?.outcome).toBeUndefined();
    expect(state.lastPlanReviewResolution).toBeNull();
  });
});
