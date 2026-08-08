import {
  CommandId,
  ApprovalRequestId,
  MessageId,
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ThreadId,
  TurnId,
  type ClientOrchestrationCommand,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import {
  archiveThread,
  cancelQueuedThreadTurn,
  createProject,
  settleThread,
  respondToThreadPlanReview,
  respondToThreadUserInput,
  setThreadInteractionMode,
  startThreadTurn,
  stopThreadSession,
  unsettleThread,
} from "./commands.ts";

const TEST_CRYPTO_LAYER = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const makeSupervisor = Effect.fn("TestEnvironmentCommands.makeSupervisor")(function* (
  dispatched: ClientOrchestrationCommand[],
) {
  const client = {
    [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
      Effect.sync(() => {
        dispatched.push(command);
        return { sequence: dispatched.length };
      }),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession.RpcSession = {
    client,
    initialConfig: Effect.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  return EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
});

describe("environment commands", () => {
  it.effect("adds generated command metadata", () =>
    Effect.gen(function* () {
      const dispatched: ClientOrchestrationCommand[] = [];
      const supervisor = yield* makeSupervisor(dispatched);

      const result = yield* createProject({
        projectId: ProjectId.make("project-1"),
        title: "Project",
        workspaceRoot: "/workspace/project",
        createdAt: "2026-06-06T00:00:00.000Z",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(result).toEqual({ sequence: 1 });
      expect(dispatched).toEqual([
        {
          type: "project.create",
          commandId: "00000000-0000-4000-8000-000000000000",
          projectId: "project-1",
          title: "Project",
          workspaceRoot: "/workspace/project",
          createdAt: "2026-06-06T00:00:00.000Z",
        },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("preserves caller metadata for idempotent queued commands", () =>
    Effect.gen(function* () {
      const dispatched: ClientOrchestrationCommand[] = [];
      const supervisor = yield* makeSupervisor(dispatched);

      yield* stopThreadSession({
        commandId: CommandId.make("queued-command"),
        threadId: ThreadId.make("thread-1"),
        createdAt: "2026-06-06T00:01:00.000Z",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(dispatched).toEqual([
        {
          type: "thread.session.stop",
          commandId: "queued-command",
          threadId: "thread-1",
          createdAt: "2026-06-06T00:01:00.000Z",
        },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("does not add timestamps to commands without createdAt", () =>
    Effect.gen(function* () {
      const dispatched: ClientOrchestrationCommand[] = [];
      const supervisor = yield* makeSupervisor(dispatched);

      yield* archiveThread({
        commandId: CommandId.make("archive-command"),
        threadId: ThreadId.make("thread-1"),
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(dispatched).toEqual([
        {
          type: "thread.archive",
          commandId: "archive-command",
          threadId: "thread-1",
        },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("dispatches settle and unsettle commands without timestamps", () =>
    Effect.gen(function* () {
      const dispatched: ClientOrchestrationCommand[] = [];
      const supervisor = yield* makeSupervisor(dispatched);

      yield* settleThread({
        commandId: CommandId.make("settle-command"),
        threadId: ThreadId.make("thread-1"),
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
      yield* unsettleThread({
        commandId: CommandId.make("unsettle-command"),
        threadId: ThreadId.make("thread-1"),
        reason: "user",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(dispatched).toEqual([
        {
          type: "thread.settle",
          commandId: "settle-command",
          threadId: "thread-1",
        },
        {
          type: "thread.unsettle",
          commandId: "unsettle-command",
          threadId: "thread-1",
          reason: "user",
        },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );
  it.effect("dispatches canonical rich-input, plan review, and follow-up commands", () =>
    Effect.gen(function* () {
      const dispatched: ClientOrchestrationCommand[] = [];
      const supervisor = yield* makeSupervisor(dispatched);
      const provideSupervisor = Effect.provideService(
        EnvironmentSupervisor.EnvironmentSupervisor,
        supervisor,
      );

      yield* respondToThreadUserInput({
        commandId: CommandId.make("user-input-command"),
        threadId: ThreadId.make("thread-1"),
        requestId: ApprovalRequestId.make("ask-1"),
        response: {
          kind: "submit",
          answers: {
            targets: { selectedOptions: ["Web", "Mobile"], note: "Ship together" },
          },
        },
        createdAt: "2026-06-06T00:02:00.000Z",
      }).pipe(provideSupervisor);
      yield* setThreadInteractionMode({
        commandId: CommandId.make("interaction-command"),
        threadId: ThreadId.make("thread-1"),
        interactionMode: "plan-paused",
        workflow: "parallel",
        createdAt: "2026-06-06T00:03:00.000Z",
      }).pipe(provideSupervisor);
      yield* startThreadTurn({
        commandId: CommandId.make("follow-up-command"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: MessageId.make("message-1"),
          role: "user",
          text: "Do this next",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        deliveryMode: "follow-up",
        createdAt: "2026-06-06T00:04:00.000Z",
      }).pipe(provideSupervisor);
      yield* respondToThreadPlanReview({
        commandId: CommandId.make("plan-review-command"),
        threadId: ThreadId.make("thread-1"),
        requestId: ApprovalRequestId.make("plan-review-1"),
        decision: {
          action: "cancel",
        },
        createdAt: "2026-06-06T00:05:00.000Z",
      }).pipe(provideSupervisor);

      expect(dispatched.map((command) => command.type)).toEqual([
        "thread.user-input.respond",
        "thread.interaction-mode.set",
        "thread.turn.start",
        "thread.plan-review.respond",
      ]);
      expect(dispatched[0]).toMatchObject({ response: { kind: "submit" } });
      expect(dispatched[1]).toMatchObject({ interactionMode: "plan-paused", workflow: "parallel" });
      expect(dispatched[2]).toMatchObject({ deliveryMode: "follow-up" });
      expect(dispatched[3]).toMatchObject({ decision: { action: "cancel" } });
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("dispatches a concrete queued follow-up cancel with turnId", () =>
    Effect.gen(function* () {
      const dispatched: ClientOrchestrationCommand[] = [];
      const supervisor = yield* makeSupervisor(dispatched);
      const provideSupervisor = Effect.provideService(
        EnvironmentSupervisor.EnvironmentSupervisor,
        supervisor,
      );

      yield* cancelQueuedThreadTurn({
        commandId: CommandId.make("cancel-queued-command"),
        threadId: ThreadId.make("thread-1"),
        turnId: TurnId.make("turn-queued-1"),
        createdAt: "2026-06-06T00:06:00.000Z",
      }).pipe(provideSupervisor);

      expect(dispatched).toEqual([
        {
          type: "thread.turn.interrupt",
          commandId: "cancel-queued-command",
          threadId: "thread-1",
          turnId: "turn-queued-1",
          createdAt: "2026-06-06T00:06:00.000Z",
        },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );
});
