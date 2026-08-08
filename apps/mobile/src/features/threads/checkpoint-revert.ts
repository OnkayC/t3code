import type {
  CheckpointRef,
  OrchestrationThread,
  OrchestrationThreadActivity,
  ThreadId,
} from "@t3tools/contracts";

export interface PendingCheckpointRevert {
  readonly threadId: ThreadId;
  readonly turnCount: number;
  readonly requestedAt: string;
  readonly discardedCheckpointRefs: ReadonlyArray<CheckpointRef>;
}

function isMatchingFailure(
  activity: OrchestrationThreadActivity,
  pending: PendingCheckpointRevert,
): boolean {
  if (
    activity.kind !== "checkpoint.revert.failed" ||
    activity.createdAt < pending.requestedAt ||
    activity.payload === null ||
    typeof activity.payload !== "object" ||
    Array.isArray(activity.payload)
  ) {
    return false;
  }

  return (activity.payload as Record<string, unknown>).turnCount === pending.turnCount;
}

export function checkpointRevertHasSettled(
  pending: PendingCheckpointRevert,
  thread: Pick<OrchestrationThread, "id" | "activities" | "checkpoints">,
): boolean {
  if (thread.id !== pending.threadId || pending.discardedCheckpointRefs.length === 0) {
    return false;
  }

  if (thread.activities.some((activity) => isMatchingFailure(activity, pending))) {
    return true;
  }

  const retainedCheckpointRefs = new Set(
    thread.checkpoints.map((checkpoint) => checkpoint.checkpointRef),
  );
  return pending.discardedCheckpointRefs.every(
    (checkpointRef) => !retainedCheckpointRefs.has(checkpointRef),
  );
}
