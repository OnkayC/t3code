import { describe, expect, it } from "vite-plus/test";

import { createPlanReviewResponseCoordinator } from "@t3tools/client-runtime/state/providerInteractionRuntime";
import {
  addPlanReviewResponseScope,
  reconcileCancellingQueuedTurnIds,
  removePlanReviewResponseScope,
} from "./selected-thread-request-guards";

const scope = (requestId: string, overrides?: { environmentId?: string; threadId?: string }) => ({
  environmentId: overrides?.environmentId ?? "env-1",
  threadId: overrides?.threadId ?? "thread-1",
  requestId,
});

const reconcileScope = (
  requestId: string | null,
  overrides?: { environmentId?: string; threadId?: string },
) => ({
  environmentId: overrides?.environmentId ?? "env-1",
  threadId: overrides?.threadId ?? "thread-1",
  requestId,
});

describe("mobile plan review response pending state", () => {
  it("keeps a persisted response pending and releases only on correlated resolution", () => {
    const coordinator = createPlanReviewResponseCoordinator();

    expect(coordinator.begin(scope("review-1"))).toBe(true);
    expect(coordinator.begin(scope("review-1"))).toBe(false);
    expect(coordinator.reconcile(reconcileScope("review-1"))).toBe(false);
    expect(coordinator.scope()).toEqual(scope("review-1"));

    expect(coordinator.reconcile(reconcileScope(null))).toBe(true);
    expect(coordinator.scope()).toBeNull();
  });

  it("clears pending state when command persistence fails", () => {
    const coordinator = createPlanReviewResponseCoordinator();

    expect(coordinator.begin(scope("review-1"))).toBe(true);
    expect(coordinator.fail(scope("review-1"))).toBe(true);
    expect(coordinator.scope()).toBeNull();
    expect(coordinator.begin(scope("review-1"))).toBe(true);
  });

  it("allows the same request id on another thread after a pending response", () => {
    const coordinator = createPlanReviewResponseCoordinator();

    expect(coordinator.begin(scope("review-1", { threadId: "thread-a" }))).toBe(true);
    expect(coordinator.begin(scope("review-1", { threadId: "thread-b" }))).toBe(true);
    expect(coordinator.scope()).toEqual(scope("review-1", { threadId: "thread-b" }));
    // Reconciling B must not clear A's guard.
    expect(coordinator.reconcile(reconcileScope("review-1", { threadId: "thread-b" }))).toBe(false);
    expect(coordinator.fail(scope("review-1", { threadId: "thread-a" }))).toBe(true);
  });

  it("releases presentation guard on reactor respond.failed while review stays open", () => {
    const coordinator = createPlanReviewResponseCoordinator();
    const responseScope = scope("review-1");
    expect(coordinator.begin(responseScope)).toBe(true);
    expect(coordinator.reconcile(reconcileScope("review-1"))).toBe(false);
    expect(coordinator.fail(responseScope)).toBe(true);
    expect(coordinator.scope()).toBeNull();
    expect(coordinator.begin(responseScope)).toBe(true);
  });
});

describe("mobile presentation guards", () => {
  it("retains independent plan-review scopes across thread switches", () => {
    const first = scope("review-1", { threadId: "thread-a" });
    const second = scope("review-1", { threadId: "thread-b" });
    const both = addPlanReviewResponseScope(addPlanReviewResponseScope([], first), second);

    expect(both).toEqual([first, second]);
    expect(removePlanReviewResponseScope(both, second)).toEqual([first]);
  });

  it("keeps queued cancellation guarded until projection removes the turn", () => {
    const current = ["turn-1", "turn-2"];
    expect(reconcileCancellingQueuedTurnIds(current, ["turn-1", "turn-2"])).toBe(current);
    expect(reconcileCancellingQueuedTurnIds(current, ["turn-2"])).toEqual(["turn-2"]);
  });
});
