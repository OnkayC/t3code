import { describe, expect, it } from "vite-plus/test";

import { createPlanReviewResponseCoordinator } from "@t3tools/client-runtime/state/providerInteractionRuntime";

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

describe("web plan review response pending state", () => {
  it("blocks duplicate responses after persistence until the correlated review resolves", () => {
    const coordinator = createPlanReviewResponseCoordinator();

    expect(coordinator.begin(scope("review-1"))).toBe(true);
    expect(coordinator.begin(scope("review-1"))).toBe(false);
    expect(coordinator.scope()).toEqual(scope("review-1"));

    expect(coordinator.reconcile(reconcileScope("review-1"))).toBe(false);
    expect(coordinator.scope()).toEqual(scope("review-1"));

    expect(coordinator.reconcile(reconcileScope(null))).toBe(true);
    expect(coordinator.scope()).toBeNull();
    expect(coordinator.begin(scope("review-1"))).toBe(true);
  });

  it("re-enables review actions when command persistence fails", () => {
    const coordinator = createPlanReviewResponseCoordinator();

    expect(coordinator.begin(scope("review-1"))).toBe(true);
    expect(coordinator.fail(scope("review-1"))).toBe(true);
    expect(coordinator.scope()).toBeNull();
  });

  it("retains inactive thread guards while reconciling the selected thread", () => {
    const coordinator = createPlanReviewResponseCoordinator();

    expect(coordinator.begin(scope("review-1", { threadId: "thread-a" }))).toBe(true);
    expect(coordinator.begin(scope("review-1", { threadId: "thread-b" }))).toBe(true);
    expect(coordinator.scope()).toEqual(scope("review-1", { threadId: "thread-b" }));

    // Thread B still pending — keep both guards.
    expect(coordinator.reconcile(reconcileScope("review-1", { threadId: "thread-b" }))).toBe(false);
    // Switching the selected view to thread A must not clear B.
    expect(coordinator.reconcile(reconcileScope("review-1", { threadId: "thread-a" }))).toBe(false);
    // Only clear A when A no longer has an open review.
    expect(coordinator.reconcile(reconcileScope(null, { threadId: "thread-a" }))).toBe(true);
    expect(coordinator.fail(scope("review-1", { threadId: "thread-b" }))).toBe(true);
    expect(coordinator.scope()).toBeNull();
  });

  it("does not keep a second environment disabled when request IDs collide", () => {
    const coordinator = createPlanReviewResponseCoordinator();

    expect(coordinator.begin(scope("review-1", { environmentId: "env-a" }))).toBe(true);
    expect(coordinator.begin(scope("review-1", { environmentId: "env-b" }))).toBe(true);
    expect(coordinator.scope()).toEqual(scope("review-1", { environmentId: "env-b" }));
    expect(
      coordinator.reconcile(reconcileScope(null, { environmentId: "env-a", threadId: "thread-1" })),
    ).toBe(true);
    expect(coordinator.fail(scope("review-1", { environmentId: "env-b" }))).toBe(true);
  });

  it("releases presentation guard on reactor respond.failed while review stays open", () => {
    const coordinator = createPlanReviewResponseCoordinator();
    const responseScope = scope("review-1");
    expect(coordinator.begin(responseScope)).toBe(true);
    // Review still open — reconcile alone must not clear the in-flight guard.
    expect(coordinator.reconcile(reconcileScope("review-1"))).toBe(false);
    // Reactors emit provider.plan-review.respond.failed for timeouts/errors.
    expect(coordinator.fail(responseScope)).toBe(true);
    expect(coordinator.scope()).toBeNull();
    // Card is retryable under the same open request id.
    expect(coordinator.begin(responseScope)).toBe(true);
  });
});
