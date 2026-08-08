// @effect-diagnostics nodeBuiltinImport:off
import * as NodeBuffer from "node:buffer";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";

import {
  OMP_REQUIRED_SEMANTIC_CAPABILITIES,
  type OmpRpcRuntimeShape,
  makeOmpRpcRuntime,
} from "./OmpRpcRuntime.ts";
import { OMP_RPC_MAX_LOGICAL_BYTES, OMP_RPC_MAX_PHYSICAL_BYTES } from "./OmpRpcProtocol.ts";

const fixture = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "testFixtures/ompRpcConformanceAgent.mjs",
);
const decodeArgv = Schema.decodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

function withRuntime<A, E, R>(f: (runtime: OmpRpcRuntimeShape) => Effect.Effect<A, E, R>) {
  return Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* makeOmpRpcRuntime({
        binaryPath: process.execPath,
        args: [fixture, "--mode", "rpc-ui", "--session-dir", "/tmp/fixture-sessions"],
        cwd: process.cwd(),
        capabilities: OMP_REQUIRED_SEMANTIC_CAPABILITIES,
      });
      return yield* f(runtime);
    }),
  );
}

it.effect("negotiates transport v2 and the complete revisioned semantic profile", () =>
  withRuntime((runtime) =>
    Effect.sync(() => {
      expect(runtime.protocolVersion).toBe(2);
      expect(runtime.capabilities).toEqual(OMP_REQUIRED_SEMANTIC_CAPABILITIES);
      expect(runtime.ready.supportedProtocolVersions).toEqual([1, 2]);
    }),
  ),
);

it.effect("closes scoped runtimes after success and initialization failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-omp-runtime-scope-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
      );
      const lifecycleLog = NodePath.join(tempDir, "lifecycle.log");
      const options = {
        binaryPath: process.execPath,
        args: [fixture, "--mode", "rpc-ui", "--session-dir", "/tmp/fixture-sessions"],
        cwd: process.cwd(),
        capabilities: OMP_REQUIRED_SEMANTIC_CAPABILITIES,
      } as const;

      yield* Effect.scoped(
        makeOmpRpcRuntime({
          ...options,
          env: { ...process.env, T3_OMP_FIXTURE_LIFECYCLE_LOG: lifecycleLog },
        }),
      );
      expect(NodeFS.readFileSync(lifecycleLog, "utf8").trim().split("\n")).toEqual([
        "started",
        "closed",
      ]);

      NodeFS.writeFileSync(lifecycleLog, "", "utf8");
      const failed = yield* Effect.exit(
        makeOmpRpcRuntime({
          ...options,
          env: {
            ...process.env,
            T3_OMP_FIXTURE_LIFECYCLE_LOG: lifecycleLog,
            T3_OMP_FIXTURE_PROTOCOL_MISMATCH: "1",
          },
        }),
      );
      expect(failed._tag).toBe("Failure");
      expect(NodeFS.readFileSync(lifecycleLog, "utf8").trim().split("\n")).toEqual([
        "started",
        "closed",
      ]);
    }),
  ),
);

it.effect("correlates concurrent requests and preserves ordered stdin writes", () =>
  withRuntime((runtime) =>
    Effect.gen(function* () {
      const results = yield* Effect.all(
        Array.from({ length: 32 }, (_, sequence) =>
          runtime.request<{ value: string; sequence: number }>({
            type: "echo",
            value: `request-${sequence}`,
            sequence,
          }),
        ),
        { concurrency: "unbounded" },
      );
      expect(results.map((result) => result.sequence)).toEqual(
        Array.from({ length: 32 }, (_, sequence) => sequence),
      );
    }),
  ),
);

it.effect("starts response timeouts after queued frame delivery", () =>
  withRuntime((runtime) =>
    Effect.gen(function* () {
      yield* runtime.request({ type: "pause_stdin", durationMs: 100 });
      const value = "q".repeat(2_000_000);
      const response = yield* runtime.request<{ value: string }>(
        { type: "echo", value },
        { timeoutMs: 20 },
      );
      expect(response.value).toBe(value);
    }),
  ),
);

it.effect("encodes oversized outbound commands and reassembles oversized inbound responses", () =>
  withRuntime((runtime) =>
    Effect.gen(function* () {
      const outbound = "δ".repeat(700_000);
      const echoed = yield* runtime.request<{ value: string }>({ type: "echo", value: outbound });
      expect(echoed.value).toBe(outbound);

      const inbound = yield* runtime.request<{ value: string }>({
        type: "emit_large",
        characters: 700_000,
      });
      expect(inbound.value).toBe("λ".repeat(700_000));
    }),
  ),
);

it.effect("drains the final stdout response before publishing process exit", () =>
  withRuntime((runtime) =>
    Effect.gen(function* () {
      const response = yield* runtime.request<{ value: string }>({
        type: "respond_then_exit",
        characters: 700_000,
      });
      expect(response.value).toBe("z".repeat(700_000));
    }),
  ),
);

it.effect(
  "transports the maximum contract-valid attachment payload under the v2 ceiling",
  () =>
    withRuntime((runtime) =>
      Effect.gen(function* () {
        expect(OMP_RPC_MAX_PHYSICAL_BYTES).toBe(1024 * 1024);
        expect(OMP_RPC_MAX_LOGICAL_BYTES).toBe(128 * 1024 * 1024);
        expect(runtime.ready.maxFrameBytes).toBe(1024 * 1024);
        expect(runtime.ready.maxReassembledFrameBytes).toBe(128 * 1024 * 1024);

        const imageData = NodeBuffer.Buffer.alloc(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES).toString(
          "base64",
        );
        const images = Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS }, () => ({
          type: "image" as const,
          data: imageData,
          mimeType: "image/png",
        }));
        const command = {
          type: "accept_images",
          id: "maximum-contract-valid-attachments",
          images,
        };
        const encodedBytes =
          NodeBuffer.Buffer.byteLength(
            encodeUnknownJson({
              ...command,
              images: images.map((image) => ({ ...image, data: "" })),
            }),
            "utf8",
          ) +
          imageData.length * images.length;
        expect(encodedBytes).toBeGreaterThan(64 * 1024 * 1024);
        expect(encodedBytes).toBeLessThanOrEqual(OMP_RPC_MAX_LOGICAL_BYTES);

        const accepted = yield* runtime.request<{ imageCount: number }>(command, {
          timeoutMs: 60_000,
        });
        expect(accepted).toEqual({ imageCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS });
      }),
    ),
  120_000,
);

it.effect("rejects an inbound logical frame advertised above the bounded v2 ceiling", () =>
  withRuntime((runtime) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        runtime.request<never>({ type: "emit_oversized_logical_frame" }),
      );
      expect(error.operation).toBe("decode");
      expect(error.detail).toBe("OMP RPC chunk metadata is invalid.");
    }),
  ),
);

it.effect("expires incomplete inbound chunk assemblies", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* makeOmpRpcRuntime({
        binaryPath: process.execPath,
        args: [fixture, "--mode", "rpc-ui", "--session-dir", "/tmp/fixture-sessions"],
        cwd: process.cwd(),
        capabilities: OMP_REQUIRED_SEMANTIC_CAPABILITIES,
        chunkAssemblyTimeoutMs: 25,
        requestTimeoutMs: 1_000,
      });
      const error = yield* Effect.flip(runtime.request<never>({ type: "emit_incomplete_chunk" }));
      expect(error.operation).toBe("decode");
      expect(error.detail).toBe("OMP RPC chunk sequence timed out after 25ms.");
    }),
  ),
);

it.effect("publishes terminal interaction resolutions before failing malformed input", () =>
  withRuntime((runtime) =>
    Effect.gen(function* () {
      const published = yield* runtime.notifications.pipe(
        Stream.filter((frame) => frame.type === "t3_runtime_interaction_resolved"),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
        Effect.forkChild,
      );
      const waiter = yield* runtime
        .awaitInteractionResolution("approval", "approval-fatal")
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      const failure = yield* Effect.exit(runtime.request({ type: "malformed" }));
      const resolution = yield* Fiber.join(waiter);
      expect(failure._tag).toBe("Failure");
      expect(resolution).toMatchObject({
        type: "t3_runtime_interaction_resolved",
        interactionType: "approval",
        id: "approval-fatal",
        outcome: "process_exited",
      });
      expect(yield* Fiber.join(published)).toEqual(resolution);
    }),
  ),
);

it.effect("preserves fatal exit outcomes when cleanup races child termination", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* makeOmpRpcRuntime({
        binaryPath: process.execPath,
        args: [fixture, "--mode", "rpc-ui", "--session-dir", "/tmp/fixture-sessions"],
        cwd: process.cwd(),
        env: { ...process.env, T3_OMP_FIXTURE_IGNORE_SIGTERM: "1" },
        capabilities: OMP_REQUIRED_SEMANTIC_CAPABILITIES,
      });
      const exitFiber = yield* runtime.notifications.pipe(
        Stream.filter((frame) => frame.type === "t3_runtime_process_exited"),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
        Effect.timeout("5 seconds"),
        Effect.forkChild,
      );

      const failure = yield* Effect.exit(runtime.request({ type: "malformed" }));
      expect(failure._tag).toBe("Failure");

      // close() must not hang or downgrade the fatal result after SIGTERM was ignored.
      yield* runtime.close.pipe(Effect.timeout("5 seconds"));
      expect(yield* Fiber.join(exitFiber)).toMatchObject({
        type: "t3_runtime_process_exited",
        outcome: "process_exited",
      });
    }),
  ),
);

it.effect("forwards unknown additive notifications without decoding them away", () =>
  withRuntime((runtime) =>
    Effect.gen(function* () {
      const notificationFiber = yield* Effect.forkChild(
        runtime.notifications.pipe(
          Stream.filter((frame) => frame.type === "future_additive_notification"),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
          Effect.timeout("5 seconds"),
        ),
      );
      yield* runtime.request({ type: "emit_unknown", payload: { future: true } });
      const notification = yield* Fiber.join(notificationFiber);
      expect(notification).toMatchObject({
        type: "future_additive_notification",
        payload: { future: true },
      });
    }),
  ),
);

it.effect("keeps child stderr out of runtime failures and logs only safe diagnostics", () => {
  const messages: Array<unknown> = [];
  const logCapture = Logger.make<unknown, void>(({ message }) => {
    if (Array.isArray(message)) messages.push(...message);
    else messages.push(message);
  });

  return withRuntime((runtime) =>
    Effect.gen(function* () {
      const processExitFiber = yield* Effect.forkChild(
        runtime.notifications.pipe(
          Stream.filter((frame) => frame.type === "t3_runtime_process_exited"),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
          Effect.timeout("5 seconds"),
        ),
      );
      yield* Effect.yieldNow;
      const pending = yield* Effect.forkChild(
        Effect.exit(runtime.request({ type: "never_respond" })),
      );
      yield* Effect.yieldNow;
      const error = yield* Effect.flip(runtime.request<never>({ type: "crash", code: 23 }));
      const pendingExit = yield* Fiber.join(pending);
      const processExit = yield* Fiber.join(processExitFiber);
      const persistedFailure = encodeUnknownJson({ detail: error.detail, message: error.message });
      const publishedExit = encodeUnknownJson(processExit);
      const serializedLogs = encodeUnknownJson(messages);

      expect(processExit).toMatchObject({
        type: "t3_runtime_process_exited",
        outcome: "process_exited",
        exitCode: 23,
      });
      expect(error.detail).toBe("OMP RPC process exited.");
      expect(pendingExit._tag).toBe("Failure");
      expect(NodeBuffer.Buffer.byteLength(runtime.stderrTail, "utf8")).toBeLessThanOrEqual(
        64 * 1024,
      );
      expect(runtime.stderrTail).not.toContain("token\nfixture-secret".repeat(2048));
      expect(persistedFailure).not.toContain("fixture-secret");
      expect(persistedFailure).not.toContain("/private/tmp/secret/token");
      expect(publishedExit).not.toContain("fixture-secret");
      expect(publishedExit).not.toContain("/private/tmp/secret/token");
      expect(publishedExit).not.toContain("stderrTail");
      expect(serializedLogs).not.toContain("fixture-secret");
      expect(serializedLogs).not.toContain("/private/tmp/secret/token");
      expect(serializedLogs).toContain("OMP RPC process exited unexpectedly.");
      expect(serializedLogs).toContain('"operation":"process"');
      expect(serializedLogs).toContain('"exitCode":23');
      expect(serializedLogs).toMatch(/"stderrBytes":\d+/);
    }),
  ).pipe(Effect.provide(Logger.layer([logCapture], { mergeWithExisting: false })));
});

it.effect("uses the exact caller-owned native argv without ACP mode or command", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-omp-runtime-"));
      const logPath = NodePath.join(tempDir, "argv.ndjson");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
      );
      const args = [
        fixture,
        "--profile",
        "work",
        "--mode",
        "rpc-ui",
        "--session-dir",
        NodePath.join(tempDir, "sessions"),
      ];
      yield* makeOmpRpcRuntime({
        binaryPath: process.execPath,
        args,
        cwd: process.cwd(),
        env: { ...process.env, T3_OMP_FIXTURE_ARGV_LOG: logPath },
        capabilities: OMP_REQUIRED_SEMANTIC_CAPABILITIES,
      });
      const [logged] = NodeFS.readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => decodeArgv(line));
      expect(logged).toEqual(args.slice(1));
      expect(logged).not.toContain("acp");
    }),
  ),
);
