// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { it } from "@effect/vitest";
import {
  ApprovalRequestId,
  OmpSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type ProviderPlanReviewTerminalOutcome,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as PubSub from "effect/PubSub";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { expect, vi } from "vite-plus/test";

import { ProviderAdapterValidationError, type ProviderAdapterError } from "../Errors.ts";
import {
  decodeOmpSessionCursor,
  OMP_REQUIRED_SEMANTIC_CAPABILITIES,
  type OmpRpcCommand,
  type OmpRpcFrame,
} from "../omp/OmpRpcProtocol.ts";
import {
  OmpRpcRuntimeError,
  type OmpRpcRuntimeOptions,
  type OmpRpcRuntimeShape,
} from "../omp/OmpRpcRuntime.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { makeOmpAdapter } from "./OmpAdapter.ts";

const fixture = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../omp/testFixtures/ompRpcConformanceAgent.mjs",
);
const decodeRequestLogEntry = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.String,
      status: Schema.optional(Schema.String),
      workflow: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
      images: Schema.optional(Schema.Unknown),
      approvalMode: Schema.optional(Schema.String),
      clientTurnId: Schema.optional(Schema.String),
      modelId: Schema.optional(Schema.String),
      level: Schema.optional(Schema.String),
      enabled: Schema.optional(Schema.Boolean),
      optionFingerprint: Schema.optional(Schema.String),
      turnOptions: Schema.optional(Schema.Unknown),
    }),
  ),
);
const decodeSettings = Schema.decodeSync(OmpSettings);

function makeExecutable(tempDir: string): string {
  const executable = NodePath.join(tempDir, "omp-fixture");
  NodeFS.writeFileSync(
    executable,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} "$@"\n`,
    { mode: 0o755 },
  );
  return executable;
}

function withAdapter<A, E, R>(
  f: (input: {
    adapter: ProviderAdapterShape<ProviderAdapterError>;
    adapterScope: Scope.Closeable;
    requestLogPath: string;
    sessionFile: string;
    attachmentsDir: string;
  }) => Effect.Effect<A, E, R>,
  adapterOptions: {
    readonly now?: () => string;
    readonly interactionResolutionTimeout?: `${number} seconds` | `${number} millis`;
    readonly makeRuntime?: (
      options: OmpRpcRuntimeOptions,
    ) => Effect.Effect<OmpRpcRuntimeShape, OmpRpcRuntimeError, Scope.Scope>;
  } = {},
): Effect.Effect<A, E, R> {
  return Effect.scoped(
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-omp-adapter-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
      );
      const sessionRoot = NodePath.join(tempDir, "provider-sessions", "omp_work");
      NodeFS.mkdirSync(sessionRoot, { recursive: true });
      const attachmentsDir = NodePath.join(tempDir, "attachments");
      NodeFS.mkdirSync(attachmentsDir, { recursive: true });
      const sessionFile = NodePath.join(sessionRoot, "session.jsonl");
      NodeFS.writeFileSync(sessionFile, "", "utf8");
      const adapterScope = yield* Scope.make("sequential");
      yield* Effect.addFinalizer(() => Scope.close(adapterScope, Exit.void));
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const adapter = yield* makeOmpAdapter(
        decodeSettings({ binaryPath: makeExecutable(tempDir) }),
        {
          instanceId: ProviderInstanceId.make("omp_work"),
          sessionRoot,
          attachmentsDir,
          ...(adapterOptions.now ? { now: adapterOptions.now } : {}),
          ...(adapterOptions.interactionResolutionTimeout
            ? {
                interactionResolutionTimeout: adapterOptions.interactionResolutionTimeout,
              }
            : {}),
          ...(adapterOptions.makeRuntime ? { makeRuntime: adapterOptions.makeRuntime } : {}),
          environment: {
            ...process.env,
            T3_OMP_FIXTURE_SESSION_FILE: sessionFile,
            T3_OMP_FIXTURE_REQUEST_LOG: requestLogPath,
          },
        },
      ).pipe(Effect.provideService(Scope.Scope, adapterScope));
      return yield* f({ adapter, adapterScope, requestLogPath, sessionFile, attachmentsDir });
    }),
  );
}

function withPlanReviewOutcome<A, E, R>(
  options: {
    readonly outcome: ProviderPlanReviewTerminalOutcome;
    readonly isStreaming: boolean;
    readonly failCommand?: "respond_to_plan_review" | "get_state";
    readonly failureOperation?: "request" | "process";
  },
  f: (input: {
    readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly postResponseStateReads: () => number;
    readonly publish: (frame: OmpRpcFrame) => Effect.Effect<void>;
  }) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ProviderAdapterError, Exclude<R, Scope.Scope>> {
  return Effect.scoped(
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-omp-plan-review-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
      );
      const sessionRoot = NodePath.join(tempDir, "provider-sessions", "omp_work");
      NodeFS.mkdirSync(sessionRoot, { recursive: true });
      const sessionFile = NodePath.join(sessionRoot, "session.jsonl");
      NodeFS.writeFileSync(sessionFile, "", "utf8");
      const notifications = yield* PubSub.unbounded<OmpRpcFrame>();
      let stateReads = 0;
      const runtime: OmpRpcRuntimeShape = {
        ready: {
          type: "ready",
          protocolVersion: 2,
          supportedProtocolVersions: [1, 2],
          capabilities: OMP_REQUIRED_SEMANTIC_CAPABILITIES,
        },
        protocolVersion: 2,
        capabilities: OMP_REQUIRED_SEMANTIC_CAPABILITIES,
        notifications: Stream.fromPubSub(notifications),
        subscribeNotifications: PubSub.subscribe(notifications),
        stderrTail: "",
        request: <T = unknown>(command: OmpRpcCommand) => {
          if (command.type === "get_state") {
            const isPostResponseRead = stateReads > 0;
            const isStreaming = isPostResponseRead && options.isStreaming;
            stateReads += 1;
            if (options.failCommand === "get_state" && isPostResponseRead) {
              return Effect.fail(
                new OmpRpcRuntimeError({
                  operation: options.failureOperation ?? "request",
                  command: command.type,
                  detail: `Injected ${command.type} failure.`,
                }),
              );
            }
            return Effect.succeed({
              sessionId: "plan-review-session",
              sessionFile,
              isStreaming,
            } as unknown as T);
          }
          if (command.type === options.failCommand) {
            return Effect.fail(
              new OmpRpcRuntimeError({
                operation: options.failureOperation ?? "request",
                command: command.type,
                detail: `Injected ${command.type} failure.`,
              }),
            );
          }
          if (command.type === "get_turns") return Effect.succeed({ turns: [] } as unknown as T);
          if (command.type === "get_messages_page") {
            return Effect.succeed({ messages: [], totalMessages: 0 } as unknown as T);
          }
          return Effect.succeed({} as T);
        },
        notify: () => Effect.void,
        awaitInteractionResolution: (_kind, id) =>
          Effect.succeed({
            type: "plan_review_resolved",
            id,
            outcome: options.outcome,
            clientTurnId: "turn-plan-outcome",
          }),
        close: PubSub.shutdown(notifications),
      };
      const adapter = yield* makeOmpAdapter(decodeSettings({ binaryPath: "omp" }), {
        instanceId: ProviderInstanceId.make("omp_work"),
        sessionRoot,
        makeRuntime: () => Effect.succeed(runtime),
      });
      const threadId = ThreadId.make(
        `thread-plan-${options.outcome}-${String(options.isStreaming)}`,
      );
      const turnId = TurnId.make("turn-plan-outcome");
      yield* adapter.startSession({ threadId, runtimeMode: "full-access", cwd: process.cwd() });
      const reviewFiber = yield* Effect.forkChild(
        waitForEvent(adapter.streamEvents, (event) => event.type === "plan.review.requested"),
      );
      yield* Effect.yieldNow;
      yield* PubSub.publish(notifications, {
        type: "plan_review_request",
        id: "review-outcome",
        title: "Outcome plan",
        path: sessionFile,
        planArtifactId: "outcome-plan",
        markdown: "# Outcome plan",
        allowedContextStrategies: ["fresh"],
        executionModels: [],
      });
      yield* Fiber.join(reviewFiber);
      return yield* f({
        adapter,
        threadId,
        turnId,
        postResponseStateReads: () => Math.max(0, stateReads - 1),
        publish: (frame) => PubSub.publish(notifications, frame).pipe(Effect.asVoid),
      });
    }),
  );
}

function waitForEvent(
  stream: Stream.Stream<ProviderRuntimeEvent>,
  predicate: (event: ProviderRuntimeEvent) => boolean,
) {
  return stream.pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new ProviderAdapterValidationError({
              provider: ProviderDriverKind.make("omp"),
              operation: "waitForEvent",
              issue: "Event not found in stream",
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
    Effect.timeout("5 seconds"),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: ProviderDriverKind.make("omp"),
          operation: "waitForEvent",
          issue: "Timed out waiting for event",
        }),
      ),
    ),
  );
}

function makeSetupRuntimeFactory(
  options: {
    readonly failCommand?: string;
    readonly stateSessionId?: string;
  } = {},
) {
  const close = vi.fn(() => undefined);
  const factory = vi.fn((runtimeOptions: OmpRpcRuntimeOptions) => {
    const sessionDirIndex = runtimeOptions.args.indexOf("--session-dir");
    const sessionDir = runtimeOptions.args[sessionDirIndex + 1];
    if (sessionDirIndex < 0 || sessionDir === undefined) {
      return Effect.die(new Error("OMP runtime options omitted --session-dir"));
    }
    const sessionFile = NodePath.join(sessionDir, "session.jsonl");
    const request = <T = unknown>(command: OmpRpcCommand) => {
      if (command.type === options.failCommand) {
        return Effect.fail(
          new OmpRpcRuntimeError({
            operation: "request",
            command: command.type,
            detail: `Injected ${command.type} failure.`,
          }),
        );
      }
      const response: unknown =
        command.type === "get_state"
          ? {
              sessionId: options.stateSessionId ?? "omp-session-1",
              sessionFile,
              isStreaming: false,
            }
          : command.type === "get_turns"
            ? { turns: [] }
            : undefined;
      return Effect.succeed(response as T);
    };
    const runtime: OmpRpcRuntimeShape = {
      ready: { type: "ready", protocolVersion: 2 },
      protocolVersion: 2,
      capabilities: OMP_REQUIRED_SEMANTIC_CAPABILITIES,
      notifications: Stream.empty,
      subscribeNotifications: Effect.flatMap(PubSub.unbounded<OmpRpcFrame>(), PubSub.subscribe),
      stderrTail: "",
      request,
      notify: () => Effect.void,
      awaitInteractionResolution: () => Effect.never,
      close: Effect.sync(close),
    };
    return Effect.acquireRelease(Effect.succeed(runtime), (ownedRuntime) => ownedRuntime.close);
  });
  return { close, factory };
}

function makeInteractionRuntimeFactory() {
  let publishFrame: ((frame: OmpRpcFrame) => Effect.Effect<void>) | undefined;
  const close = vi.fn(() => undefined);
  const factory = vi.fn((runtimeOptions: OmpRpcRuntimeOptions) => {
    const sessionDirIndex = runtimeOptions.args.indexOf("--session-dir");
    const sessionDir = runtimeOptions.args[sessionDirIndex + 1];
    if (sessionDirIndex < 0 || sessionDir === undefined) {
      return Effect.die(new Error("OMP runtime options omitted --session-dir"));
    }
    const sessionFile = NodePath.join(sessionDir, "session.jsonl");
    return Effect.acquireRelease(
      Effect.gen(function* () {
        const notifications = yield* PubSub.unbounded<OmpRpcFrame>();
        publishFrame = (frame) => PubSub.publish(notifications, frame).pipe(Effect.asVoid);
        const runtime: OmpRpcRuntimeShape = {
          ready: { type: "ready", protocolVersion: 2 },
          protocolVersion: 2,
          capabilities: OMP_REQUIRED_SEMANTIC_CAPABILITIES,
          notifications: Stream.fromPubSub(notifications),
          subscribeNotifications: PubSub.subscribe(notifications),
          stderrTail: "",
          request: <T = unknown>(command: OmpRpcCommand) =>
            Effect.succeed(
              (command.type === "get_state"
                ? {
                    sessionId: "omp-session-1",
                    sessionFile,
                    isStreaming: false,
                  }
                : command.type === "get_turns"
                  ? { turns: [] }
                  : undefined) as T,
            ),
          notify: () => Effect.void,
          awaitInteractionResolution: () => Effect.never,
          close: Effect.sync(close),
        };
        return { notifications, runtime };
      }),
      ({ notifications, runtime }) =>
        runtime.close.pipe(Effect.andThen(PubSub.shutdown(notifications))),
    ).pipe(Effect.map(({ runtime }) => runtime));
  });
  return {
    close,
    factory,
    publish: (frame: OmpRpcFrame) =>
      publishFrame
        ? publishFrame(frame)
        : Effect.die(new Error("OMP interaction runtime has not started")),
  };
}

function collectEvents(
  stream: Stream.Stream<ProviderRuntimeEvent>,
  events: Array<ProviderRuntimeEvent>,
) {
  return stream.pipe(Stream.runForEach((event) => Effect.sync(() => events.push(event))));
}

const interactionEventTypes: Partial<Record<ProviderRuntimeEvent["type"], true>> = {
  "request.opened": true,
  "request.resolved": true,
  "user-input.requested": true,
  "user-input.resolved": true,
  "plan.review.requested": true,
  "plan.review.resolved": true,
};

function collectInteractionEvents(
  stream: Stream.Stream<ProviderRuntimeEvent>,
  events: Array<ProviderRuntimeEvent>,
) {
  return stream.pipe(
    Stream.filter((event) => interactionEventTypes[event.type] === true),
    Stream.runForEach((event) => Effect.sync(() => events.push(event))),
  );
}

const setupFailureCases: ReadonlyArray<{
  readonly name: string;
  readonly failCommand?: string;
  readonly stateSessionId?: string;
  readonly resume: boolean;
}> = [
  { name: "runtime policy", failCommand: "set_runtime_policy", resume: false },
  { name: "state", failCommand: "get_state", resume: false },
  { name: "resume validation", stateSessionId: "different-session", resume: true },
  { name: "turn history", failCommand: "get_turns", resume: true },
  { name: "subagent subscription", failCommand: "set_subagent_subscription", resume: false },
] as const;

it.effect.each(setupFailureCases)(
  "closes the locally owned runtime when $name setup fails",
  ({ failCommand, stateSessionId, resume }) => {
    const runtimeFactory = makeSetupRuntimeFactory({
      ...(failCommand !== undefined ? { failCommand } : {}),
      ...(stateSessionId !== undefined ? { stateSessionId } : {}),
    });
    return withAdapter(
      ({ adapter, sessionFile }) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make(`thread-setup-failure-${failCommand ?? "resume"}`);
          const result = yield* adapter
            .startSession({
              threadId,
              runtimeMode: "full-access",
              cwd: process.cwd(),
              ...(resume
                ? {
                    resumeCursor: {
                      schemaVersion: 1,
                      sessionKey: NodePath.basename(sessionFile),
                      sessionId: "omp-session-1",
                    },
                  }
                : {}),
            })
            .pipe(Effect.exit);

          expect(result._tag).toBe("Failure");
          expect(runtimeFactory.close).toHaveBeenCalledTimes(1);
          expect(yield* adapter.hasSession(threadId)).toBe(false);
          yield* adapter.stopAll();
          expect(runtimeFactory.close).toHaveBeenCalledTimes(1);
        }),
      { makeRuntime: runtimeFactory.factory },
    );
  },
);

it.effect("transfers runtime ownership only after registration and closes once on teardown", () => {
  const runtimeFactory = makeSetupRuntimeFactory();
  return withAdapter(
    ({ adapter }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-setup-success");
        yield* adapter.startSession({
          threadId,
          runtimeMode: "full-access",
          cwd: process.cwd(),
        });

        expect(runtimeFactory.close).not.toHaveBeenCalled();
        expect(yield* adapter.hasSession(threadId)).toBe(true);
        yield* adapter.stopSession(threadId);
        expect(runtimeFactory.close).toHaveBeenCalledTimes(1);
        yield* adapter.stopAll();
        expect(runtimeFactory.close).toHaveBeenCalledTimes(1);
      }),
    { makeRuntime: runtimeFactory.factory },
  ).pipe(Effect.andThen(Effect.sync(() => expect(runtimeFactory.close).toHaveBeenCalledTimes(1))));
});

it.effect("publishes one session exit before adapter scope teardown closes streams", () => {
  const runtimeFactory = makeSetupRuntimeFactory();
  return withAdapter(
    ({ adapter, adapterScope }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-adapter-scope-teardown");
        yield* adapter.startSession({
          threadId,
          runtimeMode: "full-access",
          cwd: process.cwd(),
        });
        const runtimeEvents: Array<ProviderRuntimeEvent> = [];
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
          Effect.forkChild,
        );
        const exitedFiber = yield* waitForEvent(
          adapter.streamEvents,
          (event) => event.type === "session.exited" && event.threadId === threadId,
        ).pipe(Effect.forkChild);
        yield* Effect.yieldNow;

        yield* adapter.sendTurn({ threadId, input: "Keep running until teardown." });
        expect(
          (yield* adapter.listSessions()).find((session) => session.threadId === threadId),
        ).toMatchObject({ status: "running" });

        yield* Scope.close(adapterScope, Exit.void);
        const exited = yield* Fiber.join(exitedFiber);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(eventsFiber);

        expect(exited).toMatchObject({
          type: "session.exited",
          threadId,
          payload: {
            reason: "OMP session stopped.",
            recoverable: false,
            exitKind: "graceful",
          },
        });
        expect(runtimeEvents.filter((event) => event.type === "session.exited")).toHaveLength(1);
        expect(runtimeFactory.close).toHaveBeenCalledTimes(1);
        expect(yield* adapter.hasSession(threadId)).toBe(false);
      }),
    { makeRuntime: runtimeFactory.factory },
  );
});

it.effect("closes an unexpectedly exited runtime once and allows clean recovery", () => {
  const runtimeFactory = makeInteractionRuntimeFactory();
  return withAdapter(
    ({ adapter }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-unexpected-exit-recovery");
        const events: Array<ProviderRuntimeEvent> = [];
        const eventsFiber = yield* collectEvents(adapter.streamEvents, events).pipe(
          Effect.forkChild,
        );
        yield* adapter.startSession({ threadId, runtimeMode: "approval-required" });

        const scopedApprovalExit = `${threadId}:approval-exit`;
        const openedFiber = yield* waitForEvent(
          adapter.streamEvents,
          (event) => event.type === "request.opened" && event.requestId === scopedApprovalExit,
        ).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* runtimeFactory.publish({
          type: "approval_request",
          id: "approval-exit",
          toolName: "write",
          allowedDecisions: ["deny", "accept_once"],
        });
        yield* Fiber.join(openedFiber);

        const resolvedFiber = yield* waitForEvent(
          adapter.streamEvents,
          (event) => event.type === "request.resolved" && event.requestId === scopedApprovalExit,
        ).pipe(Effect.forkChild);
        const exitedFiber = yield* waitForEvent(
          adapter.streamEvents,
          (event) => event.type === "session.exited" && event.threadId === threadId,
        ).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* runtimeFactory.publish({ type: "t3_runtime_process_exited", outcome: "error" });
        yield* Effect.all([Fiber.join(resolvedFiber), Fiber.join(exitedFiber)]);

        expect(runtimeFactory.close).toHaveBeenCalledTimes(1);
        expect(events.filter((event) => event.type === "session.exited")).toHaveLength(1);
        expect(
          events.filter(
            (event) => event.type === "request.resolved" && event.requestId === scopedApprovalExit,
          ),
        ).toHaveLength(1);

        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        expect(runtimeFactory.factory).toHaveBeenCalledTimes(2);
        expect(yield* adapter.hasSession(threadId)).toBe(true);
        yield* adapter.stopSession(threadId);
        expect(runtimeFactory.close).toHaveBeenCalledTimes(2);
        yield* adapter.stopAll();
        expect(runtimeFactory.close).toHaveBeenCalledTimes(2);
        yield* Fiber.interrupt(eventsFiber);
      }),
    { makeRuntime: runtimeFactory.factory },
  ).pipe(Effect.andThen(Effect.sync(() => expect(runtimeFactory.close).toHaveBeenCalledTimes(2))));
});

it.effect(
  "starts native rpc-ui with policy/model options and returns an opaque contained cursor",
  () =>
    withAdapter(({ adapter, requestLogPath, sessionFile }) =>
      Effect.gen(function* () {
        const session = yield* adapter.startSession({
          threadId: ThreadId.make("thread-start"),
          provider: ProviderDriverKind.make("omp"),
          providerInstanceId: ProviderInstanceId.make("omp_work"),
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          modelSelection: {
            instanceId: ProviderInstanceId.make("omp_work"),
            model: "fixture-model",
            options: [
              { id: "reasoning", value: "high" },
              { id: "fastMode", value: true },
            ],
          },
        });

        expect(session.status).toBe("ready");
        expect(session.resumeCursor).toEqual({
          schemaVersion: 1,
          sessionKey: NodePath.relative(NodePath.dirname(sessionFile), sessionFile),
          sessionId: "omp-session-1",
        });
        expect(decodeOmpSessionCursor(session.resumeCursor)?.sessionKey).not.toContain(
          NodePath.dirname(sessionFile),
        );
        const requests = NodeFS.readFileSync(requestLogPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => decodeRequestLogEntry(line));
        expect(requests).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "set_runtime_policy", approvalMode: "always-ask" }),
            expect.objectContaining({ type: "set_model", modelId: "fixture-model" }),
            expect.objectContaining({ type: "set_thinking_level", level: "high" }),
            expect.objectContaining({ type: "set_fast_mode", enabled: true }),
          ]),
        );
        expect(requests.some((request) => request.type === "acp")).toBe(false);
      }),
    ),
);

it.effect("omits resume cursor while OMP lazy session file is still missing", () =>
  withAdapter(({ adapter, sessionFile }) =>
    Effect.gen(function* () {
      NodeFS.rmSync(sessionFile);

      const session = yield* adapter.startSession({
        threadId: ThreadId.make("thread-lazy-session-file"),
        provider: ProviderDriverKind.make("omp"),
        providerInstanceId: ProviderInstanceId.make("omp_work"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      expect(NodeFS.existsSync(sessionFile)).toBe(false);
      expect(session.resumeCursor).toBeUndefined();
    }),
  ),
);

it.effect("recovers empty sessions when a resume cursor points at a missing lazy file", () => {
  const runtimeFactory = makeSetupRuntimeFactory();
  return withAdapter(
    ({ adapter, sessionFile }) =>
      Effect.gen(function* () {
        NodeFS.rmSync(sessionFile, { force: true });
        const session = yield* adapter.startSession({
          threadId: ThreadId.make("thread-missing-resume"),
          provider: ProviderDriverKind.make("omp"),
          providerInstanceId: ProviderInstanceId.make("omp_work"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: {
            schemaVersion: 1,
            sessionKey: NodePath.basename(sessionFile),
            sessionId: "omp-session-stale",
          },
        });
        expect(session.resumeCursor).toBeUndefined();
        const launchArgs = runtimeFactory.factory.mock.calls[0]?.[0]?.args ?? [];
        expect(launchArgs).not.toContain("--resume");
        expect(yield* adapter.hasSession(ThreadId.make("thread-missing-resume"))).toBe(true);
      }),
    { makeRuntime: runtimeFactory.factory },
  );
});

it.effect("treats null and foreign resume cursors as no resume", () => {
  const runtimeFactory = makeSetupRuntimeFactory();
  return withAdapter(
    ({ adapter }) =>
      Effect.gen(function* () {
        const nullSession = yield* adapter.startSession({
          threadId: ThreadId.make("thread-null-resume"),
          provider: ProviderDriverKind.make("omp"),
          providerInstanceId: ProviderInstanceId.make("omp_work"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          // Persisted bindings store SQL NULL as JS null after a lazy start.
          resumeCursor: null,
        });
        expect(nullSession.status).toBe("ready");
        expect(yield* adapter.hasSession(ThreadId.make("thread-null-resume"))).toBe(true);

        yield* adapter.stopSession(ThreadId.make("thread-null-resume"));

        const foreignSession = yield* adapter.startSession({
          threadId: ThreadId.make("thread-foreign-resume"),
          provider: ProviderDriverKind.make("omp"),
          providerInstanceId: ProviderInstanceId.make("omp_work"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          // e.g. leftover codex/claude shape or incomplete OMP cursor.
          resumeCursor: { opaque: "not-an-omp-cursor" },
        });
        expect(foreignSession.status).toBe("ready");
        expect(yield* adapter.hasSession(ThreadId.make("thread-foreign-resume"))).toBe(true);

        const launchArgs = runtimeFactory.factory.mock.calls.flatMap((call) => call[0]?.args ?? []);
        expect(launchArgs).not.toContain("--resume");
      }),
    { makeRuntime: runtimeFactory.factory },
  );
});

it.effect("timestamps normalized events when each frame arrives", () => {
  let tick = 0;
  return withAdapter(
    ({ adapter }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-event-time");
        const session = yield* adapter.startSession({
          threadId,
          runtimeMode: "full-access",
          cwd: process.cwd(),
        });
        const turnFiber = yield* Effect.forkChild(
          waitForEvent(adapter.streamEvents, (event) => event.type === "turn.started"),
          { startImmediately: true },
        );
        yield* Effect.yieldNow;
        yield* adapter.sendTurn({ threadId, input: "timestamp me" });
        const turn = yield* Fiber.join(turnFiber);
        expect(turn.createdAt > session.createdAt).toBe(true);
      }),
    { now: () => `2026-08-08T12:00:00.${String(tick++).padStart(3, "0")}Z` },
  );
});

it.effect("waits for authoritative approval and ask resolution frames", () =>
  withAdapter(({ adapter }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-interactions");
      yield* adapter.startSession({
        threadId,
        runtimeMode: "approval-required",
        cwd: process.cwd(),
      });

      const approvalEventFiber = yield* Effect.forkChild(
        waitForEvent(adapter.streamEvents, (event) => event.type === "request.opened"),
      );
      yield* adapter.sendTurn({ threadId, input: "TRIGGER_APPROVAL" });
      const approvalEvent = yield* Fiber.join(approvalEventFiber);
      const scopedApprovalId = RuntimeRequestId.make(`${threadId}:approval-1`);
      expect(approvalEvent.requestId).toBe(scopedApprovalId);
      expect(approvalEvent.providerRefs?.providerRequestId).toBe("approval-1");
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(scopedApprovalId),
        "acceptForSession",
      );

      const askEventFiber = yield* Effect.forkChild(
        waitForEvent(adapter.streamEvents, (event) => event.type === "user-input.requested"),
      );
      yield* adapter.sendTurn({ threadId, input: "TRIGGER_ASK" });
      yield* Fiber.join(askEventFiber);
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("ask-1"), {
        kind: "submit",
        answers: {
          target: { selectedOptions: ["Web", "Mobile"], note: "Keep parity" },
        },
      });
    }),
  ),
);

it.effect("times out stuck native approval resolution so the reactor can fail-activity", () => {
  const runtimeFactory = makeInteractionRuntimeFactory();
  return withAdapter(
    ({ adapter }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-approval-timeout");
        yield* adapter.startSession({ threadId, runtimeMode: "approval-required" });
        const opened = yield* waitForEvent(
          adapter.streamEvents,
          (event) => event.type === "request.opened",
        ).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* runtimeFactory.publish({
          type: "approval_request",
          id: "approval-timeout",
          toolName: "bash",
          allowedDecisions: ["approve_once", "deny"],
        });
        yield* Fiber.join(opened);
        const resultFiber = yield* Effect.forkChild(
          adapter.respondToRequest(
            threadId,
            ApprovalRequestId.make(`${threadId}:approval-timeout`),
            "accept",
          ),
        );
        // TestClock is frozen under @effect/vitest; advance past the bound wait.
        yield* TestClock.adjust("100 millis");
        const result = yield* Fiber.join(resultFiber).pipe(Effect.exit);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(String(result.cause)).toContain("Timed out waiting for approval_resolved");
        }
      }),
    {
      makeRuntime: runtimeFactory.factory,
      interactionResolutionTimeout: "50 millis",
    },
  );
});

it.effect("applies the initial workflow and does not promote a finished plan review", () =>
  withAdapter(({ adapter, requestLogPath }) =>
    Effect.gen(function* () {
      expect(adapter.setInteractionMode).toBeDefined();
      expect(adapter.respondToPlanReview).toBeDefined();
      const setInteractionMode = adapter.setInteractionMode!;
      const respondToPlanReview = adapter.respondToPlanReview!;
      const threadId = ThreadId.make("thread-plan");
      yield* adapter.startSession({ threadId, runtimeMode: "full-access", cwd: process.cwd() });
      const reviewFiber = yield* Effect.forkChild(
        waitForEvent(adapter.streamEvents, (event) => event.type === "plan.review.requested"),
      );
      yield* adapter.sendTurn({
        threadId,
        input: "TRIGGER_PLAN_REVIEW",
        interactionMode: "plan",
        workflow: "parallel",
      });
      yield* Fiber.join(reviewFiber);

      const requests = NodeFS.readFileSync(requestLogPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => decodeRequestLogEntry(line));
      const planModeIndex = requests.findIndex(
        (request) =>
          request.type === "set_plan_mode" &&
          request.status === "active" &&
          request.workflow === "parallel",
      );
      const promptIndex = requests.findIndex(
        (request) => request.type === "prompt" && request.message === "TRIGGER_PLAN_REVIEW",
      );
      expect(planModeIndex).toBeGreaterThanOrEqual(0);
      expect(promptIndex).toBeGreaterThan(planModeIndex);

      yield* setInteractionMode({ threadId, interactionMode: "plan-paused" });
      yield* setInteractionMode({ threadId, interactionMode: "plan" });
      const executionTurnId = TurnId.make("turn-plan-execute");
      const result = yield* respondToPlanReview({
        threadId,
        requestId: ApprovalRequestId.make("review-1"),
        decision: {
          action: "execute",
          context: "compact",
          clientTurnId: executionTurnId,
          executionModel: {
            provider: "fixture",
            modelId: "fixture-model",
            thinkingLevel: "high",
          },
        },
      });
      expect(result).toBeUndefined();
      const [session] = yield* adapter.listSessions();
      expect(session?.status).toBe("ready");
      expect(session?.activeTurnId).toBeUndefined();
      yield* setInteractionMode({ threadId, interactionMode: "default" });
    }),
  ),
);

it.effect("applies the selected workflow before a restored session prompt", () =>
  withAdapter(({ adapter, requestLogPath, sessionFile }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-restored-plan");
      yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
        cwd: process.cwd(),
        resumeCursor: {
          schemaVersion: 1,
          sessionKey: NodePath.basename(sessionFile),
          sessionId: "omp-session-1",
        },
      });
      yield* adapter.sendTurn({
        threadId,
        input: "restored plan turn",
        interactionMode: "plan",
        workflow: "iterative",
      });

      const requests = NodeFS.readFileSync(requestLogPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => decodeRequestLogEntry(line));
      const planModeIndex = requests.findIndex(
        (request) =>
          request.type === "set_plan_mode" &&
          request.status === "active" &&
          request.workflow === "iterative",
      );
      const promptIndex = requests.findIndex(
        (request) => request.type === "prompt" && request.message === "restored plan turn",
      );
      expect(planModeIndex).toBeGreaterThanOrEqual(0);
      expect(promptIndex).toBeGreaterThan(planModeIndex);
    }),
  ),
);

it.effect("loads image attachments through asynchronous filesystem I/O", () =>
  withAdapter(({ adapter, requestLogPath, attachmentsDir }) =>
    Effect.gen(function* () {
      const attachmentId = "thread-images-image-1";
      const attachmentPath = NodePath.join(attachmentsDir, `${attachmentId}.png`);
      NodeFS.writeFileSync(attachmentPath, "fixture-image", "utf8");
      const readFile = vi.spyOn(NodeFS.promises, "readFile");
      yield* Effect.addFinalizer(() => Effect.sync(() => readFile.mockRestore()));
      const threadId = ThreadId.make("thread-images");
      yield* adapter.startSession({ threadId, runtimeMode: "full-access", cwd: process.cwd() });
      yield* adapter.sendTurn({
        threadId,
        attachments: [
          {
            type: "image",
            id: attachmentId,
            name: "fixture.png",
            mimeType: "image/png",
            sizeBytes: 13,
          },
        ],
      });

      expect(readFile).toHaveBeenCalledWith(attachmentPath, "base64");
      const requests = NodeFS.readFileSync(requestLogPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => decodeRequestLogEntry(line));
      expect(requests.find((request) => request.type === "prompt")?.images).toEqual([
        {
          type: "image",
          data: Buffer.from("fixture-image").toString("base64"),
          mimeType: "image/png",
        },
      ]);
    }),
  ),
);

it.effect("clears the expected plan turn for terminal non-starting outcomes", () =>
  Effect.forEach(
    ["cancelled", "stale", "aborted", "process_exited"] as const,
    (outcome) =>
      withPlanReviewOutcome(
        { outcome, isStreaming: true },
        ({ adapter, threadId, turnId, postResponseStateReads, publish }) =>
          Effect.gen(function* () {
            const events: Array<ProviderRuntimeEvent> = [];
            const eventFiber = yield* collectEvents(adapter.streamEvents, events).pipe(
              Effect.forkChild,
            );
            yield* Effect.yieldNow;

            const result = yield* adapter.respondToPlanReview!({
              threadId,
              requestId: ApprovalRequestId.make("review-outcome"),
              decision: {
                action: "execute",
                context: "fresh",
                clientTurnId: turnId,
              },
            });

            expect(result).toBeUndefined();
            expect(postResponseStateReads()).toBe(0);
            const [session] = yield* adapter.listSessions();
            expect(session?.status).toBe("ready");
            expect(session?.activeTurnId).toBeUndefined();

            yield* publish({ type: "agent_start" });
            yield* publish({ type: "t3_runtime_process_exited", outcome: "error" });
            yield* Effect.yieldNow;
            yield* Fiber.interrupt(eventFiber);
            expect(
              events.filter(
                (event) =>
                  event.turnId === turnId &&
                  (event.type === "turn.started" || event.type === "turn.aborted"),
              ),
            ).toHaveLength(0);
          }),
      ),
    { discard: true },
  ),
);

it.effect("clears the expected plan turn when the promoted native stream has finished", () =>
  Effect.forEach(
    [
      { outcome: "executing", action: "execute" },
      { outcome: "refining", action: "refine" },
    ] as const,
    ({ outcome, action }) =>
      withPlanReviewOutcome(
        { outcome, isStreaming: false },
        ({ adapter, threadId, turnId, postResponseStateReads, publish }) =>
          Effect.gen(function* () {
            const events: Array<ProviderRuntimeEvent> = [];
            const eventFiber = yield* collectEvents(adapter.streamEvents, events).pipe(
              Effect.forkChild,
            );
            yield* Effect.yieldNow;
            const decision =
              action === "execute"
                ? ({ action, context: "compact", clientTurnId: turnId } as const)
                : ({ action, feedback: "Keep refining", clientTurnId: turnId } as const);
            const result = yield* adapter.respondToPlanReview!({
              threadId,
              requestId: ApprovalRequestId.make("review-outcome"),
              decision,
            });

            expect(result).toBeUndefined();
            expect(postResponseStateReads()).toBe(1);
            const [session] = yield* adapter.listSessions();
            expect(session?.status).toBe("ready");
            expect(session?.activeTurnId).toBeUndefined();

            yield* publish({ type: "agent_start" });
            yield* publish({ type: "t3_runtime_process_exited", outcome: "error" });
            yield* Effect.yieldNow;
            yield* Fiber.interrupt(eventFiber);
            expect(
              events.filter(
                (event) =>
                  event.turnId === turnId &&
                  (event.type === "turn.started" || event.type === "turn.aborted"),
              ),
            ).toHaveLength(0);
          }),
      ),
    { discard: true },
  ),
);

it.effect("keeps one expected turn through live plan execution and refinement", () =>
  Effect.forEach(
    [
      { outcome: "executing", action: "execute" },
      { outcome: "refining", action: "refine" },
    ] as const,
    ({ outcome, action }) =>
      withPlanReviewOutcome(
        { outcome, isStreaming: true },
        ({ adapter, threadId, turnId, postResponseStateReads, publish }) =>
          Effect.gen(function* () {
            const events: Array<ProviderRuntimeEvent> = [];
            const eventFiber = yield* collectEvents(adapter.streamEvents, events).pipe(
              Effect.forkChild,
            );
            yield* Effect.yieldNow;
            const decision =
              action === "execute"
                ? ({ action, context: "preserve", clientTurnId: turnId } as const)
                : ({ action, feedback: "Revise the plan", clientTurnId: turnId } as const);
            const result = yield* adapter.respondToPlanReview!({
              threadId,
              requestId: ApprovalRequestId.make("review-outcome"),
              decision,
            });

            expect(result).toMatchObject({ threadId, turnId });
            expect(postResponseStateReads()).toBe(1);
            const [session] = yield* adapter.listSessions();
            expect(session?.status).toBe("running");
            expect(session?.activeTurnId).toBe(turnId);

            yield* publish({ type: "agent_start", clientTurnId: turnId });
            yield* publish({ type: "agent_end", clientTurnId: turnId });
            yield* publish({ type: "agent_start" });
            yield* publish({ type: "t3_runtime_process_exited", outcome: "error" });
            yield* Effect.yieldNow;
            yield* Fiber.interrupt(eventFiber);
            expect(
              events.filter((event) => event.type === "turn.started" && event.turnId === turnId),
            ).toHaveLength(1);
            expect(
              events.filter((event) => event.type === "turn.aborted" && event.turnId === turnId),
            ).toHaveLength(0);
          }),
      ),
    { discard: true },
  ),
);

it.effect("clears the expected plan turn when response or state requests fail", () =>
  Effect.forEach(
    [
      {
        failCommand: "respond_to_plan_review",
        failureOperation: "request",
        expectFailure: true,
      },
      {
        failCommand: "respond_to_plan_review",
        failureOperation: "process",
        expectFailure: false,
      },
      { failCommand: "get_state", failureOperation: "request", expectFailure: true },
    ] as const,
    ({ failCommand, failureOperation, expectFailure }) =>
      withPlanReviewOutcome(
        { outcome: "executing", isStreaming: true, failCommand, failureOperation },
        ({ adapter, threadId, turnId, publish }) =>
          Effect.gen(function* () {
            const events: Array<ProviderRuntimeEvent> = [];
            const eventFiber = yield* collectEvents(adapter.streamEvents, events).pipe(
              Effect.forkChild,
            );
            yield* Effect.yieldNow;
            const responseExit = yield* Effect.exit(
              adapter.respondToPlanReview!({
                threadId,
                requestId: ApprovalRequestId.make("review-outcome"),
                decision: {
                  action: "execute",
                  context: "fresh",
                  clientTurnId: turnId,
                },
              }),
            );
            expect(Exit.isFailure(responseExit)).toBe(expectFailure);

            yield* publish({ type: "agent_start" });
            yield* publish({ type: "t3_runtime_process_exited", outcome: "error" });
            yield* Effect.yieldNow;
            yield* Fiber.interrupt(eventFiber);
            expect(
              events.filter(
                (event) =>
                  event.turnId === turnId &&
                  (event.type === "turn.started" || event.type === "turn.aborted"),
              ),
            ).toHaveLength(0);
          }),
      ),
    { discard: true },
  ),
);

it.effect("distinguishes steer from queued follow-up and rolls back the exact durable suffix", () =>
  withAdapter(({ adapter, requestLogPath }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-turns");
      yield* adapter.startSession({ threadId, runtimeMode: "full-access", cwd: process.cwd() });
      const approvalOpened = yield* Effect.forkChild(
        waitForEvent(adapter.streamEvents, (event) => event.type === "request.opened"),
      );
      const first = yield* adapter.sendTurn({ threadId, input: "TRIGGER_APPROVAL" });
      yield* Fiber.join(approvalOpened);

      const queuedEvent = yield* Effect.forkChild(
        waitForEvent(adapter.streamEvents, (event) => event.type === "turn.queued"),
      );
      const promotedEvent = yield* Effect.forkChild(
        waitForEvent(
          adapter.streamEvents,
          (event) => event.type === "turn.started" && event.turnId !== first.turnId,
        ),
      );
      const second = yield* adapter.sendTurn({
        threadId,
        input: "second",
        deliveryMode: "follow-up",
        modelSelection: {
          instanceId: ProviderInstanceId.make("omp_work"),
          model: "fixture/fixture-model",
          options: [
            { id: "reasoning", value: "high" },
            { id: "fastMode", value: true },
          ],
        },
      });
      expect(second.queued).toBe(true);
      expect((yield* Fiber.join(queuedEvent)).turnId).toBe(second.turnId);
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(`${threadId}:approval-1`),
        "accept",
      );
      expect((yield* Fiber.join(promotedEvent)).turnId).toBe(second.turnId);

      const requests = NodeFS.readFileSync(requestLogPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => decodeRequestLogEntry(line));
      expect(requests.find((request) => request.type === "follow_up")).toMatchObject({
        clientTurnId: second.turnId,
        optionFingerprint: expect.any(String),
        turnOptions: {
          provider: "fixture",
          modelId: "fixture-model",
          thinkingLevel: "high",
          fastMode: true,
        },
      });

      const snapshot = yield* adapter.readThread(threadId);
      expect(snapshot.turns.map((turn) => turn.id)).toEqual([first.turnId, second.turnId]);
      expect(snapshot.turns.every((turn) => turn.items.length > 0)).toBe(true);
      const rolledBack = yield* adapter.rollbackThread(threadId, 1);
      expect(rolledBack.turns.map((turn) => turn.id)).toEqual([first.turnId]);
    }),
  ),
);

it.effect("cancels a concrete queued follow-up without aborting the active turn", () =>
  withAdapter(({ adapter, requestLogPath }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-cancel-queued");
      yield* adapter.startSession({ threadId, runtimeMode: "full-access", cwd: process.cwd() });
      const approvalOpened = yield* Effect.forkChild(
        waitForEvent(adapter.streamEvents, (event) => event.type === "request.opened"),
      );
      const first = yield* adapter.sendTurn({ threadId, input: "TRIGGER_APPROVAL" });
      yield* Fiber.join(approvalOpened);

      const queuedEvent = yield* Effect.forkChild(
        waitForEvent(adapter.streamEvents, (event) => event.type === "turn.queued"),
      );
      const cancelledEvent = yield* Effect.forkChild(
        waitForEvent(
          adapter.streamEvents,
          (event) => event.type === "turn.aborted" && event.turnId !== first.turnId,
        ),
      );
      const second = yield* adapter.sendTurn({
        threadId,
        input: "cancel me",
        deliveryMode: "follow-up",
      });
      expect(second.queued).toBe(true);
      expect((yield* Fiber.join(queuedEvent)).turnId).toBe(second.turnId);

      yield* adapter.interruptTurn(threadId, second.turnId);
      const cancelled = yield* Fiber.join(cancelledEvent);
      expect(cancelled).toMatchObject({
        type: "turn.aborted",
        turnId: second.turnId,
        payload: {
          reason: expect.stringMatching(/cancel/i),
        },
      });

      const requests = NodeFS.readFileSync(requestLogPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => decodeRequestLogEntry(line));
      expect(requests.find((request) => request.type === "cancel_follow_up")).toMatchObject({
        clientTurnId: second.turnId,
      });
      expect(requests.some((request) => request.type === "abort")).toBe(false);
      expect(yield* adapter.hasSession(threadId)).toBe(true);
    }),
  ),
);

it.effect("settles queued follow-ups before publishing OMP session exit", () =>
  withAdapter(({ adapter }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-stop-queued");
      yield* adapter.startSession({ threadId, runtimeMode: "full-access", cwd: process.cwd() });
      const approvalOpened = yield* waitForEvent(
        adapter.streamEvents,
        (event) => event.type === "request.opened",
      ).pipe(Effect.forkChild);
      yield* adapter.sendTurn({ threadId, input: "TRIGGER_APPROVAL" });
      yield* Fiber.join(approvalOpened);
      const queued = yield* adapter.sendTurn({
        threadId,
        input: "queued until stop",
        deliveryMode: "follow-up",
      });

      const terminalEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            (event.type === "turn.aborted" && event.turnId === queued.turnId) ||
            (event.type === "session.exited" && event.threadId === threadId),
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* adapter.stopSession(threadId);

      const terminalEvents = Array.from(yield* Fiber.join(terminalEventsFiber));
      expect(terminalEvents.map((event) => event.type)).toEqual(["turn.aborted", "session.exited"]);
      expect(terminalEvents[0]).toMatchObject({
        type: "turn.aborted",
        turnId: queued.turnId,
        payload: { reason: "OMP session stopped." },
      });
    }),
  ),
);

it.effect("resolves every pending interaction before closing an OMP session", () => {
  const runtimeFactory = makeInteractionRuntimeFactory();
  return withAdapter(
    ({ adapter }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-stop-interactions");
        yield* adapter.startSession({ threadId, runtimeMode: "approval-required" });
        const events: Array<ProviderRuntimeEvent> = [];
        const eventFiber = yield* collectInteractionEvents(adapter.streamEvents, events).pipe(
          Effect.forkChild,
        );
        const planOpenedFiber = yield* waitForEvent(
          adapter.streamEvents,
          (event) => event.type === "plan.review.requested",
        ).pipe(Effect.forkChild);
        yield* Effect.yieldNow;

        yield* runtimeFactory.publish({
          type: "approval_request",
          id: "approval-stop",
          toolName: "write",
          allowedDecisions: ["deny", "accept_once"],
        });
        yield* runtimeFactory.publish({
          type: "extension_ui_request",
          method: "ask",
          id: "ask-stop",
          questions: [{ id: "target", question: "Which target?", options: [] }],
        });
        yield* runtimeFactory.publish({
          type: "plan_review_request",
          id: "plan-stop",
          title: "Review plan",
          markdown: "1. Stop safely",
        });
        yield* Fiber.join(planOpenedFiber);

        const scopedApprovalStop = `${threadId}:approval-stop`;
        const approvalResolvedFiber = yield* waitForEvent(
          adapter.streamEvents,
          (event) => event.type === "request.resolved" && event.requestId === scopedApprovalStop,
        ).pipe(Effect.forkChild);
        const askResolvedFiber = yield* waitForEvent(
          adapter.streamEvents,
          (event) => event.type === "user-input.resolved" && event.requestId === "ask-stop",
        ).pipe(Effect.forkChild);
        const planResolvedFiber = yield* waitForEvent(
          adapter.streamEvents,
          (event) => event.type === "plan.review.resolved" && event.requestId === "plan-stop",
        ).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* adapter.stopSession(threadId);
        const [approvalResolved, askResolved, planResolved] = yield* Effect.all([
          Fiber.join(approvalResolvedFiber),
          Fiber.join(askResolvedFiber),
          Fiber.join(planResolvedFiber),
        ]);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(eventFiber);

        expect(runtimeFactory.close).toHaveBeenCalledTimes(1);
        expect(approvalResolved).toMatchObject({
          type: "request.resolved",
          requestId: scopedApprovalStop,
          payload: { requestType: "tool_approval", outcome: "aborted" },
        });
        expect(askResolved).toMatchObject({
          type: "user-input.resolved",
          requestId: "ask-stop",
          payload: { outcome: "aborted" },
        });
        expect(planResolved).toMatchObject({
          type: "plan.review.resolved",
          requestId: "plan-stop",
          payload: { outcome: "aborted" },
        });
        expect(events.filter((event) => event.type.endsWith("resolved"))).toHaveLength(3);
      }),
    { makeRuntime: runtimeFactory.factory },
  );
});

it.effect("emits one resolution per interaction when native terminal frames race with stop", () => {
  const runtimeFactory = makeInteractionRuntimeFactory();
  return withAdapter(
    ({ adapter }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-stop-resolution-race");
        yield* adapter.startSession({ threadId, runtimeMode: "approval-required" });
        const events: Array<ProviderRuntimeEvent> = [];
        const eventFiber = yield* collectInteractionEvents(adapter.streamEvents, events).pipe(
          Effect.forkChild,
        );
        const openedFiber = yield* waitForEvent(
          adapter.streamEvents,
          (event) => event.type === "plan.review.requested" && event.requestId === "plan-race",
        ).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* runtimeFactory.publish({
          type: "approval_request",
          id: "approval-race",
          toolName: "write",
          allowedDecisions: ["deny", "accept_once"],
        });
        yield* runtimeFactory.publish({
          type: "extension_ui_request",
          method: "ask",
          id: "ask-race",
          questions: [{ id: "target", question: "Which target?", options: [] }],
        });
        yield* runtimeFactory.publish({
          type: "plan_review_request",
          id: "plan-race",
          title: "Review plan",
          markdown: "1. Race safely",
        });
        yield* Fiber.join(openedFiber);
        const scopedApprovalRace = `${threadId}:approval-race`;
        const approvalResolvedFiber = yield* waitForEvent(
          adapter.streamEvents,
          (event) => event.type === "request.resolved" && event.requestId === scopedApprovalRace,
        ).pipe(Effect.forkChild);
        const askResolvedFiber = yield* waitForEvent(
          adapter.streamEvents,
          (event) => event.type === "user-input.resolved" && event.requestId === "ask-race",
        ).pipe(Effect.forkChild);
        const planResolvedFiber = yield* waitForEvent(
          adapter.streamEvents,
          (event) => event.type === "plan.review.resolved" && event.requestId === "plan-race",
        ).pipe(Effect.forkChild);
        yield* Effect.yieldNow;

        yield* Effect.all(
          [
            runtimeFactory.publish({
              type: "approval_resolved",
              id: "approval-race",
              outcome: "responded",
              decision: "deny",
            }),
            runtimeFactory.publish({
              type: "extension_ui_resolved",
              method: "ask",
              id: "ask-race",
              outcome: "cancelled",
              result: { results: [] },
            }),
            runtimeFactory.publish({
              type: "plan_review_resolved",
              id: "plan-race",
              outcome: "cancelled",
            }),
            adapter.stopSession(threadId),
          ],
          { concurrency: "unbounded", discard: true },
        );
        yield* Effect.all([
          Fiber.join(approvalResolvedFiber),
          Fiber.join(askResolvedFiber),
          Fiber.join(planResolvedFiber),
        ]);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(eventFiber);

        expect(
          events.filter(
            (event) => event.type === "request.resolved" && event.requestId === scopedApprovalRace,
          ),
        ).toHaveLength(1);
        expect(
          events.filter(
            (event) => event.type === "user-input.resolved" && event.requestId === "ask-race",
          ),
        ).toHaveLength(1);
        expect(
          events.filter(
            (event) => event.type === "plan.review.resolved" && event.requestId === "plan-race",
          ),
        ).toHaveLength(1);
      }),
    { makeRuntime: runtimeFactory.factory },
  );
});
it.effect("promotes queued model selections for later implicit follow-ups", () =>
  withAdapter(({ adapter, requestLogPath }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-promoted-model");
      yield* adapter.startSession({ threadId, runtimeMode: "full-access", cwd: process.cwd() });
      const approvalOpened = yield* waitForEvent(
        adapter.streamEvents,
        (event) => event.type === "request.opened",
      ).pipe(Effect.forkChild);
      yield* adapter.sendTurn({ threadId, input: "TRIGGER_APPROVAL" });
      yield* Fiber.join(approvalOpened);

      const selectedModel = {
        instanceId: ProviderInstanceId.make("omp_work"),
        model: "fixture/fixture-model",
        options: [
          { id: "reasoning", value: "high" },
          { id: "fastMode", value: true },
        ],
      } as const;
      yield* adapter.sendTurn({
        threadId,
        input: "selected follow-up",
        deliveryMode: "follow-up",
        modelSelection: selectedModel,
      });
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(`${threadId}:approval-1`),
        "accept",
      );

      const nextApproval = yield* waitForEvent(
        adapter.streamEvents,
        (event) => event.type === "request.opened",
      ).pipe(Effect.forkChild);
      yield* adapter.sendTurn({ threadId, input: "TRIGGER_APPROVAL" });
      yield* Fiber.join(nextApproval);
      yield* adapter.sendTurn({
        threadId,
        input: "implicit selected follow-up",
        deliveryMode: "follow-up",
      });

      const followUps = NodeFS.readFileSync(requestLogPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => decodeRequestLogEntry(line))
        .filter((request) => request.type === "follow_up");
      expect(followUps.at(-1)).toMatchObject({
        turnOptions: {
          provider: "fixture",
          modelId: "fixture-model",
          thinkingLevel: "high",
          fastMode: true,
        },
      });
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(`${threadId}:approval-1`),
        "accept",
      );
    }),
  ),
);

it.effect(
  "cancels prompt, follow-up, and plan turn expectations when native dispatch rejects",
  () =>
    withAdapter(({ adapter }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-rejected-expectations");
        yield* adapter.startSession({ threadId, runtimeMode: "full-access", cwd: process.cwd() });

        const expectIdlessStart = Effect.fn("expectIdlessStart")(function* () {
          const started = yield* waitForEvent(
            adapter.streamEvents,
            (event) => event.type === "turn.started",
          ).pipe(Effect.forkChild);
          const turn = yield* adapter.sendTurn({ threadId, input: "IDLESS_START" });
          expect((yield* Fiber.join(started)).turnId).toBe(turn.turnId);
        });

        expect(
          (yield* Effect.exit(adapter.sendTurn({ threadId, input: "REJECT_PROMPT" })))._tag,
        ).toBe("Failure");
        yield* expectIdlessStart();

        const approvalOpened = yield* waitForEvent(
          adapter.streamEvents,
          (event) => event.type === "request.opened",
        ).pipe(Effect.forkChild);
        yield* adapter.sendTurn({ threadId, input: "TRIGGER_APPROVAL" });
        yield* Fiber.join(approvalOpened);
        expect(
          (yield* Effect.exit(
            adapter.sendTurn({
              threadId,
              input: "REJECT_FOLLOW_UP",
              deliveryMode: "follow-up",
            }),
          ))._tag,
        ).toBe("Failure");
        yield* adapter.respondToRequest(
          threadId,
          ApprovalRequestId.make(`${threadId}:approval-1`),
          "accept",
        );
        yield* expectIdlessStart();

        const planReviewOpened = yield* waitForEvent(
          adapter.streamEvents,
          (event) => event.type === "plan.review.requested",
        ).pipe(Effect.forkChild);
        yield* adapter.sendTurn({ threadId, input: "TRIGGER_PLAN_REVIEW" });
        yield* Fiber.join(planReviewOpened);
        expect(
          (yield* Effect.exit(
            adapter.respondToPlanReview?.({
              threadId,
              requestId: ApprovalRequestId.make("review-1"),
              decision: {
                action: "execute",
                context: "preserve",
                clientTurnId: TurnId.make("turn-rejected-plan"),
              },
            }) ?? Effect.die("OMP plan review is unavailable"),
          ))._tag,
        ).toBe("Failure");
        yield* expectIdlessStart();
      }),
    ),
);

it.effect("isolates sessions and stopAll lifecycle per configured OMP instance", () =>
  withAdapter(({ adapter }) =>
    Effect.gen(function* () {
      const first = ThreadId.make("thread-one");
      const second = ThreadId.make("thread-two");
      yield* adapter.startSession({ threadId: first, runtimeMode: "full-access" });
      yield* adapter.startSession({ threadId: second, runtimeMode: "full-access" });
      expect(yield* adapter.hasSession(first)).toBe(true);
      expect(yield* adapter.hasSession(second)).toBe(true);
      expect((yield* adapter.listSessions()).map((session) => session.threadId).toSorted()).toEqual(
        [first, second].toSorted(),
      );
      yield* adapter.stopSession(first);
      expect(yield* adapter.hasSession(first)).toBe(false);
      expect(yield* adapter.hasSession(second)).toBe(true);
      yield* adapter.stopAll();
      expect(yield* adapter.hasSession(second)).toBe(false);
    }),
  ),
);

it.effect("merges native thinking changes under reasoning and retains fastMode options", () => {
  let publishFrame: ((frame: OmpRpcFrame) => Effect.Effect<void>) | undefined;
  const close = vi.fn(() => undefined);
  const factory = vi.fn((runtimeOptions: OmpRpcRuntimeOptions) => {
    const sessionDirIndex = runtimeOptions.args.indexOf("--session-dir");
    const sessionDir = runtimeOptions.args[sessionDirIndex + 1];
    if (sessionDirIndex < 0 || sessionDir === undefined) {
      return Effect.die(new Error("OMP runtime options omitted --session-dir"));
    }
    const sessionFile = NodePath.join(sessionDir, "session.jsonl");
    return Effect.acquireRelease(
      Effect.gen(function* () {
        const notifications = yield* PubSub.unbounded<OmpRpcFrame>();
        publishFrame = (frame) => PubSub.publish(notifications, frame).pipe(Effect.asVoid);
        const runtime: OmpRpcRuntimeShape = {
          ready: { type: "ready", protocolVersion: 2 },
          protocolVersion: 2,
          capabilities: OMP_REQUIRED_SEMANTIC_CAPABILITIES,
          notifications: Stream.fromPubSub(notifications),
          subscribeNotifications: PubSub.subscribe(notifications),
          stderrTail: "",
          request: <T = unknown>(command: OmpRpcCommand) =>
            Effect.succeed(
              (command.type === "get_state"
                ? {
                    sessionId: "omp-session-1",
                    sessionFile,
                    isStreaming: false,
                    model: { provider: "anthropic", id: "claude-sonnet-4-5" },
                    thinkingLevel: "low",
                  }
                : command.type === "get_turns"
                  ? { turns: [] }
                  : undefined) as T,
            ),
          notify: () => Effect.void,
          awaitInteractionResolution: () => Effect.never,
          close: Effect.sync(close),
        };
        return { notifications, runtime };
      }),
      ({ notifications, runtime }) =>
        runtime.close.pipe(Effect.andThen(PubSub.shutdown(notifications))),
    ).pipe(Effect.map(({ runtime }) => runtime));
  });

  return withAdapter(
    ({ adapter }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-model-options");
        yield* adapter.startSession({
          threadId,
          runtimeMode: "full-access",
          cwd: process.cwd(),
          modelSelection: {
            instanceId: ProviderInstanceId.make("omp_work"),
            model: "anthropic/claude-sonnet-4-5",
            options: [
              { id: "reasoning", value: "high" },
              { id: "fastMode", value: true },
            ],
          },
        });

        const configured = yield* waitForEvent(
          adapter.streamEvents,
          (event) =>
            event.type === "session.configured" &&
            (
              (
                event.payload as {
                  modelSelection?: { options?: ReadonlyArray<{ value: unknown }> };
                }
              ).modelSelection?.options ?? []
            ).some((option) => option.value === "low"),
        ).pipe(Effect.forkChild);
        // Let the stream subscriber attach before publishing (PubSub drops otherwise).
        yield* Effect.yieldNow;
        if (!publishFrame) throw new Error("runtime not started");
        yield* publishFrame({ type: "thinking_level_changed", thinkingLevel: "low" });
        const event = yield* Fiber.join(configured);
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
      }),
    { makeRuntime: factory },
  );
});

it.effect("does not block stopSession on a hanging native model get_state refresh", () => {
  let publishFrame: ((frame: OmpRpcFrame) => Effect.Effect<void>) | undefined;
  let hangLatch: Deferred.Deferred<void> | undefined;
  let getStateCalls = 0;
  const close = vi.fn(() => undefined);
  const factory = vi.fn((runtimeOptions: OmpRpcRuntimeOptions) => {
    const sessionDirIndex = runtimeOptions.args.indexOf("--session-dir");
    const sessionDir = runtimeOptions.args[sessionDirIndex + 1];
    if (sessionDirIndex < 0 || sessionDir === undefined) {
      return Effect.die(new Error("OMP runtime options omitted --session-dir"));
    }
    const sessionFile = NodePath.join(sessionDir, "session.jsonl");
    return Effect.acquireRelease(
      Effect.gen(function* () {
        const notifications = yield* PubSub.unbounded<OmpRpcFrame>();
        publishFrame = (frame) => PubSub.publish(notifications, frame).pipe(Effect.asVoid);
        hangLatch = yield* Deferred.make<void>();
        const runtime: OmpRpcRuntimeShape = {
          ready: { type: "ready", protocolVersion: 2 },
          protocolVersion: 2,
          capabilities: OMP_REQUIRED_SEMANTIC_CAPABILITIES,
          notifications: Stream.fromPubSub(notifications),
          subscribeNotifications: PubSub.subscribe(notifications),
          stderrTail: "",
          request: <T = unknown>(command: OmpRpcCommand) => {
            if (command.type === "get_state") {
              getStateCalls += 1;
              // First get_state is session start; subsequent hangs simulate a
              // stuck enrichment during model_changed (must stay interruptible).
              if (getStateCalls > 1) {
                return Effect.gen(function* () {
                  if (hangLatch) yield* Deferred.succeed(hangLatch, undefined);
                  return yield* Effect.never;
                });
              }
              return Effect.succeed({
                sessionId: "omp-session-1",
                sessionFile,
                isStreaming: false,
                model: "fixture-model",
              } as T);
            }
            if (command.type === "get_turns") {
              return Effect.succeed({ turns: [] } as T);
            }
            return Effect.succeed(undefined as T);
          },
          notify: () => Effect.void,
          awaitInteractionResolution: () => Effect.never,
          close: Effect.sync(close),
        };
        return { notifications, runtime };
      }),
      ({ notifications, runtime }) =>
        runtime.close.pipe(Effect.andThen(PubSub.shutdown(notifications))),
    ).pipe(Effect.map(({ runtime }) => runtime));
  });

  return withAdapter(
    ({ adapter }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-interruptible-model");
        yield* adapter.startSession({
          threadId,
          runtimeMode: "full-access",
          cwd: process.cwd(),
        });
        if (!publishFrame || !hangLatch) throw new Error("runtime not started");
        // Let the notification subscriber attach, then hang on enrichment get_state.
        yield* Effect.yieldNow;
        yield* publishFrame({ type: "model_changed" });
        yield* Deferred.await(hangLatch).pipe(Effect.timeout("2 seconds"));
        // stopSession must complete even though get_state never returns.
        yield* adapter.stopSession(threadId).pipe(Effect.timeout("2 seconds"));
        expect(yield* adapter.hasSession(threadId)).toBe(false);
        expect(getStateCalls).toBeGreaterThan(1);
      }),
    { makeRuntime: factory },
  );
});
