import type {
  OrchestrationThreadActivity,
  ProviderApprovalDecision,
  ProviderPlanReviewTerminalOutcome,
  ProviderRequestTerminalOutcome,
  ProviderTurnDeliveryMode,
  ProviderUserInputTerminalOutcome,
  ServerProvider,
} from "@t3tools/contracts";

export type ProviderTurnDeliveryIntent = "send" | "queue" | "steer";
export interface PlanReviewResponseScope {
  readonly environmentId: string;
  readonly threadId: string;
  readonly requestId: string;
}

/**
 * Selected-thread view used to release response guards without clearing other
 * threads. `requestId` is null when that thread has no open plan review.
 */
export interface PlanReviewReconcileScope {
  readonly environmentId: string;
  readonly threadId: string;
  readonly requestId: string | null;
}

export interface PlanReviewResponseCoordinator {
  /** Most recently begun pending scope, if any (debug/tests). */
  readonly scope: () => PlanReviewResponseScope | null;
  readonly begin: (scope: PlanReviewResponseScope) => boolean;
  readonly fail: (scope: PlanReviewResponseScope) => boolean;
  /**
   * Clears only pending scopes for the selected thread when that thread's
   * open review no longer matches (resolved or replaced). Never clears other
   * threads' guards when switching selection.
   */
  readonly reconcile: (activeScope: PlanReviewReconcileScope | null) => boolean;
}

function planReviewScopeKey(scope: PlanReviewResponseScope): string {
  return `${scope.environmentId}\0${scope.threadId}\0${scope.requestId}`;
}

/** True when both scopes name the same environment, thread, and request. */
export function samePlanReviewResponseScope(
  left: PlanReviewResponseScope | null | undefined,
  right: PlanReviewResponseScope | null | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.environmentId === right.environmentId &&
    left.threadId === right.threadId &&
    left.requestId === right.requestId
  );
}

/**
 * Guards plan-review responses across the command-persistence/native-resolution gap.
 * A successful command remains pending until the authoritative activity fold removes
 * that exact scoped request. Immediate command failures release the guard for retry.
 * Tracks multiple scopes (environmentId+threadId+requestId) so reused provider
 * request IDs and thread switches cannot leave another review's actions disabled.
 */
export function createPlanReviewResponseCoordinator(): PlanReviewResponseCoordinator {
  const pendingScopes = new Map<string, PlanReviewResponseScope>();
  let lastBegun: PlanReviewResponseScope | null = null;

  return {
    scope: () => lastBegun,
    begin: (scope) => {
      const key = planReviewScopeKey(scope);
      if (pendingScopes.has(key)) return false;
      pendingScopes.set(key, scope);
      lastBegun = scope;
      return true;
    },
    fail: (scope) => {
      const key = planReviewScopeKey(scope);
      if (!pendingScopes.has(key)) return false;
      pendingScopes.delete(key);
      if (samePlanReviewResponseScope(lastBegun, scope)) {
        lastBegun = pendingScopes.values().next().value ?? null;
      }
      return true;
    },
    reconcile: (activeScope) => {
      if (activeScope === null || pendingScopes.size === 0) return false;
      let cleared = false;
      for (const [key, scope] of pendingScopes) {
        if (
          scope.environmentId !== activeScope.environmentId ||
          scope.threadId !== activeScope.threadId
        ) {
          continue;
        }
        // Same thread: keep only while the open review still matches this scope.
        if (activeScope.requestId !== null && scope.requestId === activeScope.requestId) {
          continue;
        }
        pendingScopes.delete(key);
        cleared = true;
      }
      if (cleared && lastBegun !== null && !pendingScopes.has(planReviewScopeKey(lastBegun))) {
        lastBegun = pendingScopes.values().next().value ?? null;
      }
      return cleared;
    },
  };
}

export function resolveProviderTurnDeliveryMode(input: {
  readonly intent: ProviderTurnDeliveryIntent;
  readonly provider: Pick<ServerProvider, "supportedTurnDeliveryModes"> | null | undefined;
}): ProviderTurnDeliveryMode | undefined {
  if (input.intent === "steer") {
    return "steer";
  }
  if (
    input.intent === "queue" &&
    input.provider?.supportedTurnDeliveryModes?.includes("follow-up")
  ) {
    return "follow-up";
  }
  return undefined;
}

export interface ProviderInteractionRecord {
  readonly requestId: string;
  readonly createdAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ResolvedProviderRequest extends ProviderInteractionRecord {
  readonly outcome?: ProviderRequestTerminalOutcome | undefined;
  readonly decision?: ProviderApprovalDecision | undefined;
}

export interface ResolvedProviderUserInput extends ProviderInteractionRecord {
  readonly outcome?: ProviderUserInputTerminalOutcome | undefined;
}

export interface ProviderQueuedTurn {
  readonly turnId: string;
  readonly createdAt: string;
  readonly deliveryMode: "steer" | "follow-up";
  readonly optionFingerprint: string;
  readonly queuePosition: number;
}

export interface ProviderInteractionRuntimeState {
  readonly pendingRequests: ReadonlyArray<ProviderInteractionRecord>;
  readonly resolvedRequests: ReadonlyArray<ResolvedProviderRequest>;
  readonly pendingUserInputs: ReadonlyArray<ProviderInteractionRecord>;
  readonly resolvedUserInputs: ReadonlyArray<ResolvedProviderUserInput>;
  readonly planReview: ProviderInteractionRecord | null;
  readonly lastPlanReviewResolution:
    | (ProviderInteractionRecord & {
        readonly outcome: ProviderPlanReviewTerminalOutcome;
      })
    | null;
  /**
   * Latest nonterminal `provider.plan-review.respond.failed` for the open
   * review. Clients use this to release response guards so the card is
   * retryable after reactor timeouts/errors (command success ≠ native resolve).
   */
  readonly lastPlanReviewRespondFailure: ProviderInteractionRecord | null;
  readonly queuedTurns: ReadonlyArray<ProviderQueuedTurn>;
}

function isRequestOutcome(value: unknown): value is ProviderRequestTerminalOutcome {
  return (
    value === "accepted" ||
    value === "denied" ||
    value === "cancelled" ||
    value === "timed_out" ||
    value === "stale" ||
    value === "aborted" ||
    value === "process_exited"
  );
}

function isUserInputOutcome(value: unknown): value is ProviderUserInputTerminalOutcome {
  return (
    value === "submitted" ||
    value === "chat" ||
    value === "cancelled" ||
    value === "timed_out" ||
    value === "stale" ||
    value === "aborted" ||
    value === "process_exited"
  );
}

function isPlanReviewOutcome(value: unknown): value is ProviderPlanReviewTerminalOutcome {
  return (
    value === "executing" ||
    value === "refining" ||
    value === "cancelled" ||
    value === "stale" ||
    value === "aborted" ||
    value === "process_exited"
  );
}

function isApprovalDecision(value: unknown): value is ProviderApprovalDecision {
  return (
    value === "accept" || value === "acceptForSession" || value === "decline" || value === "cancel"
  );
}

function recordPayload(activity: OrchestrationThreadActivity): Record<string, unknown> | null {
  return activity.payload !== null &&
    typeof activity.payload === "object" &&
    !Array.isArray(activity.payload)
    ? (activity.payload as Record<string, unknown>)
    : null;
}

function requestIdFrom(payload: Record<string, unknown> | null): string | null {
  return typeof payload?.requestId === "string" && payload.requestId.trim().length > 0
    ? payload.requestId
    : null;
}

function interactionRecord(
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown>,
  requestId: string,
): ProviderInteractionRecord {
  return {
    requestId,
    createdAt: activity.createdAt,
    payload,
  };
}

export function foldProviderInteractionActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ProviderInteractionRuntimeState {
  const pendingRequests = new Map<string, ProviderInteractionRecord>();
  const pendingUserInputs = new Map<string, ProviderInteractionRecord>();
  const resolvedRequests = new Map<string, ResolvedProviderRequest>();
  const resolvedUserInputs = new Map<string, ResolvedProviderUserInput>();
  const queuedTurns = new Map<string, ProviderQueuedTurn>();
  let planReview: ProviderInteractionRecord | null = null;
  let lastPlanReviewResolution: ProviderInteractionRuntimeState["lastPlanReviewResolution"] = null;
  let lastPlanReviewRespondFailure: ProviderInteractionRecord | null = null;

  const ordered = [...activities].toSorted((left, right) => {
    // Missing sequence sorts after sequenced activities (matches threadReducer /
    // mobile sortThreadActivities). Using 0 would place unsequenced rows first.
    const sequenceOrder =
      (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER);
    if (sequenceOrder !== 0) return sequenceOrder;
    const timeOrder = left.createdAt.localeCompare(right.createdAt);
    if (timeOrder !== 0) return timeOrder;
    // Same sequence/time: fold queued before terminal so a sticky queued banner
    // cannot survive when turn.completed/aborted/started races the queue row.
    const lifecycleRank = (kind: string) => {
      if (kind === "turn.queued") return 0;
      if (kind === "turn.started" || kind === "turn.completed" || kind === "turn.aborted") return 1;
      return 2;
    };
    const byLifecycle = lifecycleRank(left.kind) - lifecycleRank(right.kind);
    if (byLifecycle !== 0) return byLifecycle;
    return String(left.id).localeCompare(String(right.id));
  });

  for (const activity of ordered) {
    const payload = recordPayload(activity);
    const requestId = requestIdFrom(payload);

    if (
      (activity.kind === "request.opened" || activity.kind === "approval.requested") &&
      payload &&
      requestId
    ) {
      pendingRequests.set(requestId, interactionRecord(activity, payload, requestId));
      continue;
    }

    if (
      (activity.kind === "request.resolved" || activity.kind === "approval.resolved") &&
      payload &&
      requestId
    ) {
      pendingRequests.delete(requestId);
      const outcome = payload.outcome;
      const decision = payload.decision;
      resolvedRequests.set(requestId, {
        ...interactionRecord(activity, payload, requestId),
        ...(isRequestOutcome(outcome) ? { outcome } : {}),
        ...(isApprovalDecision(decision) ? { decision } : {}),
      });
      continue;
    }

    if (activity.kind === "user-input.requested" && payload && requestId) {
      pendingUserInputs.set(requestId, interactionRecord(activity, payload, requestId));
      continue;
    }

    if (activity.kind === "user-input.resolved" && payload && requestId) {
      pendingUserInputs.delete(requestId);
      const outcome = payload.outcome;
      resolvedUserInputs.set(requestId, {
        ...interactionRecord(activity, payload, requestId),
        ...(isUserInputOutcome(outcome) ? { outcome } : {}),
      });
      continue;
    }

    if (activity.kind === "plan.review.requested" && payload && requestId) {
      planReview = interactionRecord(activity, payload, requestId);
      lastPlanReviewRespondFailure = null;
      continue;
    }

    if (activity.kind === "plan.review.resolved" && payload && requestId) {
      if (planReview?.requestId === requestId) planReview = null;
      if (lastPlanReviewRespondFailure?.requestId === requestId) {
        lastPlanReviewRespondFailure = null;
      }
      if (isPlanReviewOutcome(payload.outcome)) {
        lastPlanReviewResolution = {
          ...interactionRecord(activity, payload, requestId),
          outcome: payload.outcome,
        };
      }
      continue;
    }

    // Reactor-side respond failure: keep the open review, surface the failure so
    // presentation/coordinator can release the in-flight guard for retry.
    if (activity.kind === "provider.plan-review.respond.failed" && payload && requestId) {
      lastPlanReviewRespondFailure = interactionRecord(activity, payload, requestId);
      continue;
    }

    const turnId =
      typeof payload?.turnId === "string"
        ? payload.turnId
        : activity.turnId === null
          ? null
          : activity.turnId;
    if (activity.kind === "turn.queued" && payload && turnId) {
      const deliveryMode = payload.deliveryMode;
      const optionFingerprint = payload.optionFingerprint;
      const queuePosition = payload.queuePosition;
      if (
        (deliveryMode === "steer" || deliveryMode === "follow-up") &&
        typeof optionFingerprint === "string" &&
        typeof queuePosition === "number" &&
        Number.isInteger(queuePosition) &&
        queuePosition > 0
      ) {
        queuedTurns.set(turnId, {
          turnId,
          createdAt: activity.createdAt,
          deliveryMode,
          optionFingerprint,
          queuePosition,
        });
      }
      continue;
    }

    if (
      turnId &&
      (activity.kind === "turn.started" ||
        activity.kind === "turn.completed" ||
        activity.kind === "turn.aborted")
    ) {
      queuedTurns.delete(turnId);
    }
  }

  const byCreatedAt = <T extends { readonly createdAt: string }>(left: T, right: T) =>
    left.createdAt.localeCompare(right.createdAt);
  return {
    pendingRequests: [...pendingRequests.values()].toSorted(byCreatedAt),
    resolvedRequests: [...resolvedRequests.values()].toSorted(byCreatedAt),
    pendingUserInputs: [...pendingUserInputs.values()].toSorted(byCreatedAt),
    resolvedUserInputs: [...resolvedUserInputs.values()].toSorted(byCreatedAt),
    planReview,
    lastPlanReviewResolution,
    lastPlanReviewRespondFailure,
    queuedTurns: [...queuedTurns.values()].toSorted(
      (left, right) => left.queuePosition - right.queuePosition,
    ),
  };
}
