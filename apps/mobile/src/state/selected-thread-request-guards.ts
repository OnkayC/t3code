import {
  samePlanReviewResponseScope,
  type PlanReviewResponseScope,
} from "@t3tools/client-runtime/state/providerInteractionRuntime";

export function addPlanReviewResponseScope(
  scopes: ReadonlyArray<PlanReviewResponseScope>,
  scope: PlanReviewResponseScope,
): ReadonlyArray<PlanReviewResponseScope> {
  return scopes.some((current) => samePlanReviewResponseScope(current, scope))
    ? scopes
    : [...scopes, scope];
}

export function removePlanReviewResponseScope(
  scopes: ReadonlyArray<PlanReviewResponseScope>,
  scope: PlanReviewResponseScope,
): ReadonlyArray<PlanReviewResponseScope> {
  const next = scopes.filter((current) => !samePlanReviewResponseScope(current, scope));
  return next.length === scopes.length ? scopes : next;
}

export function reconcileCancellingQueuedTurnIds(
  cancellingTurnIds: ReadonlyArray<string>,
  queuedTurnIds: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (cancellingTurnIds.length === 0) return cancellingTurnIds;
  const queuedTurnIdSet = new Set(queuedTurnIds);
  const next = cancellingTurnIds.filter((turnId) => queuedTurnIdSet.has(turnId));
  return next.length === cancellingTurnIds.length ? cancellingTurnIds : next;
}
