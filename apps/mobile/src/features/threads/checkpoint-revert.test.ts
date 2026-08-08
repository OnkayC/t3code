import {
  CheckpointRef,
  EventId,
  ThreadId,
  TurnId,
  type OrchestrationCheckpointSummary,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { checkpointRevertHasSettled, type PendingCheckpointRevert } from "./checkpoint-revert";

const threadId = ThreadId.make("thread-1");
const requestedAt = "2026-08-09T10:00:00.000Z";

function checkpoint(turnCount: number): OrchestrationCheckpointSummary {
  return {
    turnId: TurnId.make(`turn-${turnCount}`),
    checkpointTurnCount: turnCount,
    checkpointRef: CheckpointRef.make(`checkpoint-${turnCount}`),
    status: "ready",
    files: [],
    assistantMessageId: null,
    completedAt: `2026-08-09T09:0${turnCount}:00.000Z`,
  };
}

function failureActivity(input: {
  readonly turnCount: number;
  readonly createdAt: string;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(`failure-${input.turnCount}-${input.createdAt}`),
    tone: "error",
    kind: "checkpoint.revert.failed",
    summary: "Checkpoint revert failed",
    payload: { turnCount: input.turnCount, detail: "rollback failed" },
    turnId: null,
    createdAt: input.createdAt,
  };
}

const pending: PendingCheckpointRevert = {
  threadId,
  turnCount: 1,
  requestedAt,
  discardedCheckpointRefs: [CheckpointRef.make("checkpoint-2")],
};

describe("checkpointRevertHasSettled", () => {
  it("waits while checkpoints that the revert will discard remain projected", () => {
    expect(
      checkpointRevertHasSettled(pending, {
        id: threadId,
        checkpoints: [checkpoint(1), checkpoint(2)],
        activities: [],
      }),
    ).toBe(false);
  });

  it("settles after the reverted projection removes newer checkpoints", () => {
    expect(
      checkpointRevertHasSettled(pending, {
        id: threadId,
        checkpoints: [checkpoint(1)],
        activities: [],
      }),
    ).toBe(true);
  });

  it("settles on a matching failure emitted after the request", () => {
    expect(
      checkpointRevertHasSettled(pending, {
        id: threadId,
        checkpoints: [checkpoint(1), checkpoint(2)],
        activities: [failureActivity({ turnCount: 1, createdAt: "2026-08-09T10:00:01.000Z" })],
      }),
    ).toBe(true);
  });

  it("ignores stale and differently targeted failure activities", () => {
    expect(
      checkpointRevertHasSettled(pending, {
        id: threadId,
        checkpoints: [checkpoint(1), checkpoint(2)],
        activities: [
          failureActivity({ turnCount: 1, createdAt: "2026-08-09T09:59:59.000Z" }),
          failureActivity({ turnCount: 2, createdAt: "2026-08-09T10:00:01.000Z" }),
        ],
      }),
    ).toBe(false);
  });
});
