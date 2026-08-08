// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeBuffer from "node:buffer";
import * as NodeChildProcess from "node:child_process";
import * as NodeTimers from "node:timers";

import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  isOmpRpcChunkFrame,
  isOmpRpcFrame,
  isOmpRpcReadyFrame,
  isOmpRpcResponseFrame,
  OMP_RPC_CHUNK_PAYLOAD_BYTES,
  OMP_RPC_MAX_LOGICAL_BYTES,
  OMP_RPC_MAX_PHYSICAL_BYTES,
  type OmpRpcCommand,
  type OmpRpcFrame,
  type OmpRpcReadyFrame,
  type OmpRpcSemanticCapabilities,
} from "./OmpRpcProtocol.ts";
export { OMP_REQUIRED_SEMANTIC_CAPABILITIES } from "./OmpRpcProtocol.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_CHUNK_ASSEMBLY_TIMEOUT_MS = 15_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_STDERR_TAIL_BYTES = 64 * 1024;
const MAX_CHUNK_ID_CHARS = 128;

export class OmpRpcRuntimeError extends Schema.TaggedErrorClass<OmpRpcRuntimeError>()(
  "OmpRpcRuntimeError",
  {
    operation: Schema.String,
    detail: Schema.String,
    command: Schema.optional(Schema.String),
    exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `OMP RPC ${this.operation} failed${this.command ? ` for ${this.command}` : ""}: ${this.detail}`;
  }
}
const isOmpRpcRuntimeError = Schema.is(OmpRpcRuntimeError);

export interface OmpRpcRuntimeOptions {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly capabilities?: OmpRpcSemanticCapabilities;
  readonly requestTimeoutMs?: number;
  readonly chunkAssemblyTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly stderrTailBytes?: number;
}

export type OmpRpcInteractionKind = "approval" | "ask" | "plan_review";

export interface OmpRpcRuntimeShape {
  readonly ready: OmpRpcReadyFrame;
  readonly protocolVersion: 1 | 2;
  readonly capabilities: OmpRpcSemanticCapabilities;
  readonly notifications: Stream.Stream<OmpRpcFrame>;
  /**
   * Acquire a PubSub subscription synchronously in the caller's fiber so the
   * consumer is registered before any subsequent publish. Prefer this over
   * forking `Stream.fromPubSub(notifications)` which races stream start.
   */
  readonly subscribeNotifications: Effect.Effect<
    PubSub.Subscription<OmpRpcFrame>,
    never,
    Scope.Scope
  >;
  readonly stderrTail: string;
  readonly request: <T = unknown>(
    command: OmpRpcCommand,
    options?: { readonly timeoutMs?: number },
  ) => Effect.Effect<T, OmpRpcRuntimeError>;
  readonly notify: (frame: OmpRpcCommand) => Effect.Effect<void, OmpRpcRuntimeError>;
  readonly awaitInteractionResolution: (
    kind: OmpRpcInteractionKind,
    id: string,
  ) => Effect.Effect<OmpRpcFrame, OmpRpcRuntimeError>;
  readonly close: Effect.Effect<void>;
}

interface PendingRequest {
  readonly command: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: OmpRpcRuntimeError) => void;
  timer?: NodeJS.Timeout;
}

interface PendingInteraction {
  readonly kind: OmpRpcInteractionKind;
  readonly id: string;
  readonly resolve: (frame: OmpRpcFrame) => void;
  readonly reject: (error: OmpRpcRuntimeError) => void;
}

interface PendingChunks {
  readonly chunkId: string;
  readonly count: number;
  readonly byteLength: number;
  readonly timer: NodeJS.Timeout;
  nextIndex: number;
  receivedBytes: number;
  readonly chunks: Array<NodeBuffer.Buffer>;
}

interface OmpRpcRuntimeDiagnostic {
  readonly message: string;
  readonly annotations: Readonly<Record<string, unknown>>;
}

class OmpRpcRuntimeImpl {
  readonly #child: NodeChildProcess.ChildProcessWithoutNullStreams;
  readonly #options: Required<
    Pick<
      OmpRpcRuntimeOptions,
      "chunkAssemblyTimeoutMs" | "requestTimeoutMs" | "startupTimeoutMs" | "stderrTailBytes"
    >
  > &
    Omit<
      OmpRpcRuntimeOptions,
      "chunkAssemblyTimeoutMs" | "requestTimeoutMs" | "startupTimeoutMs" | "stderrTailBytes"
    >;
  readonly #publish: (frame: OmpRpcFrame) => void;
  readonly #logDiagnostic: (diagnostic: OmpRpcRuntimeDiagnostic) => void;
  readonly #pendingRequests = new Map<string, PendingRequest>();
  readonly #pendingInteractions = new Map<string, PendingInteraction>();
  #inputBuffer: NodeBuffer.Buffer<ArrayBufferLike> = NodeBuffer.Buffer.alloc(0);
  #pendingChunks: PendingChunks | undefined;
  #nextRequestId = 0;
  #nextChunkId = 0;
  #writeTail: Promise<void> = Promise.resolve();
  #readyResolve!: (ready: OmpRpcReadyFrame) => void;
  #readyReject!: (error: OmpRpcRuntimeError) => void;
  readonly #readyPromise: Promise<OmpRpcReadyFrame>;
  #readyFrame: OmpRpcReadyFrame | undefined;
  #protocolVersion: 1 | 2 = 1;
  #selectedCapabilities: OmpRpcSemanticCapabilities = {};
  /** Outbound physical frame ceiling (min of local + peer advertisement). */
  #maxPhysicalBytes = OMP_RPC_MAX_PHYSICAL_BYTES;
  /** Outbound logical frame ceiling (min of local + peer advertisement). */
  #maxLogicalBytes = OMP_RPC_MAX_LOGICAL_BYTES;
  /** Chunk payload size derived from the negotiated physical ceiling. */
  #chunkPayloadBytes = OMP_RPC_CHUNK_PAYLOAD_BYTES;
  #fatalError: OmpRpcRuntimeError | undefined;
  #stderrTail: NodeBuffer.Buffer<ArrayBufferLike> = NodeBuffer.Buffer.alloc(0);
  #closing = false;
  #closed = false;
  #exitPromise: Promise<number | null>;

  constructor(
    options: OmpRpcRuntimeOptions,
    publish: (frame: OmpRpcFrame) => void,
    logDiagnostic: (diagnostic: OmpRpcRuntimeDiagnostic) => void,
  ) {
    this.#options = {
      ...options,
      chunkAssemblyTimeoutMs: options.chunkAssemblyTimeoutMs ?? DEFAULT_CHUNK_ASSEMBLY_TIMEOUT_MS,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      stderrTailBytes: options.stderrTailBytes ?? DEFAULT_STDERR_TAIL_BYTES,
    };
    this.#publish = publish;
    this.#logDiagnostic = logDiagnostic;
    const readyGate = Promise.withResolvers<OmpRpcReadyFrame>();
    this.#readyPromise = readyGate.promise;
    this.#readyResolve = readyGate.resolve;
    this.#readyReject = readyGate.reject;
    // Startup timeout races #readyPromise; if timeout wins, a later reject
    // would otherwise surface as an unhandled rejection. Attach a no-op
    // handler so the promise is always observed.
    void this.#readyPromise.then(
      () => undefined,
      () => undefined,
    );

    try {
      this.#child = NodeChildProcess.spawn(options.binaryPath, [...options.args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (cause) {
      throw new OmpRpcRuntimeError({
        operation: "spawn",
        detail: `Failed to spawn ${options.binaryPath}.`,
        cause,
      });
    }

    const exitGate = Promise.withResolvers<number | null>();
    this.#exitPromise = exitGate.promise;
    this.#child.once("close", (code, signal) => {
      exitGate.resolve(code);
      this.#onExit(code, signal);
    });
    this.#child.stdout.on("data", (chunk: NodeBuffer.Buffer) => this.#onStdout(chunk));
    this.#child.stderr.on("data", (chunk: NodeBuffer.Buffer) => this.#onStderr(chunk));
    this.#child.once("error", (cause) => {
      this.#fail(
        new OmpRpcRuntimeError({
          operation: "process",
          detail: "OMP child process emitted an error.",
          cause,
        }),
      );
    });
  }

  get ready(): OmpRpcReadyFrame {
    if (!this.#readyFrame) throw new Error("OMP RPC runtime is not initialized.");
    return this.#readyFrame;
  }

  get protocolVersion(): 1 | 2 {
    return this.#protocolVersion;
  }

  get capabilities(): OmpRpcSemanticCapabilities {
    return this.#selectedCapabilities;
  }

  get stderrTail(): string {
    return this.#stderrTail.toString("utf8");
  }

  async initialize(): Promise<void> {
    const ready = await this.#withTimeout(
      this.#readyPromise,
      this.#options.startupTimeoutMs,
      "startup",
      "Timed out waiting for the OMP ready frame.",
    );
    this.#readyFrame = ready;
    // Cap outbound frames at the peer's advertised limits so we never send a
    // physical/logical payload the native process declared it cannot accept.
    if (typeof ready.maxFrameBytes === "number" && ready.maxFrameBytes > 0) {
      this.#maxPhysicalBytes = Math.min(OMP_RPC_MAX_PHYSICAL_BYTES, ready.maxFrameBytes);
    }
    if (typeof ready.maxReassembledFrameBytes === "number" && ready.maxReassembledFrameBytes > 0) {
      this.#maxLogicalBytes = Math.min(OMP_RPC_MAX_LOGICAL_BYTES, ready.maxReassembledFrameBytes);
    }
    // Keep chunk payload comfortably under the physical ceiling (base64 overhead).
    this.#chunkPayloadBytes = Math.max(1024, Math.floor(this.#maxPhysicalBytes / 4));

    if (ready.supportedProtocolVersions?.includes(2)) {
      const negotiated = await this.#requestPromise<{ protocolVersion?: number }>(
        { type: "negotiate_protocol", protocolVersion: 2 },
        this.#options.requestTimeoutMs,
      );
      if (negotiated.protocolVersion !== 2) {
        throw new OmpRpcRuntimeError({
          operation: "negotiate_protocol",
          command: "negotiate_protocol",
          detail: "OMP did not confirm transport protocol v2.",
        });
      }
      this.#protocolVersion = 2;
    }

    const requestedCapabilities = this.#selectOfferedCapabilities(
      ready.capabilities,
      this.#options.capabilities,
    );
    if (Object.keys(requestedCapabilities).length > 0) {
      const selected = await this.#requestPromise<{ capabilities?: OmpRpcSemanticCapabilities }>(
        { type: "negotiate_capabilities", capabilities: requestedCapabilities },
        this.#options.requestTimeoutMs,
      );
      this.#selectedCapabilities = selected.capabilities ?? {};
    }
  }

  request<T = unknown>(
    command: OmpRpcCommand,
    options?: { readonly timeoutMs?: number },
  ): Effect.Effect<T, OmpRpcRuntimeError> {
    return Effect.tryPromise({
      try: () =>
        this.#requestPromise<T>(command, options?.timeoutMs ?? this.#options.requestTimeoutMs),
      catch: (cause) =>
        isOmpRpcRuntimeError(cause)
          ? cause
          : new OmpRpcRuntimeError({
              operation: "request",
              command: command.type,
              detail: "OMP request failed.",
              cause,
            }),
    });
  }

  notify(frame: OmpRpcCommand): Effect.Effect<void, OmpRpcRuntimeError> {
    return Effect.tryPromise({
      try: () => this.#enqueueFrame(frame),
      catch: (cause) =>
        isOmpRpcRuntimeError(cause)
          ? cause
          : new OmpRpcRuntimeError({
              operation: "notify",
              command: frame.type,
              detail: "Failed to write OMP notification.",
              cause,
            }),
    });
  }

  awaitInteractionResolution(
    kind: OmpRpcInteractionKind,
    id: string,
  ): Effect.Effect<OmpRpcFrame, OmpRpcRuntimeError> {
    const key = `${kind}:${id}`;
    return Effect.callback<OmpRpcFrame, OmpRpcRuntimeError>((resume) => {
      if (this.#fatalError) {
        resume(Effect.fail(this.#fatalError));
        return;
      }
      if (this.#pendingInteractions.has(key)) {
        resume(
          Effect.fail(
            new OmpRpcRuntimeError({
              operation: "interaction",
              detail: `Interaction ${key} already has a waiter.`,
            }),
          ),
        );
        return;
      }
      this.#pendingInteractions.set(key, {
        kind,
        id,
        resolve: (frame) => resume(Effect.succeed(frame)),
        reject: (error) => resume(Effect.fail(error)),
      });
      return Effect.sync(() => {
        this.#pendingInteractions.delete(key);
      });
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closing = true;
    this.#resolveInteractionsForExit(this.#fatalError ? "process_exited" : "aborted");
    // Base escalation on the process still running. `#fail` may already have
    // sent SIGTERM (setting ChildProcess.killed) without the child having
    // exited — still wait the grace window and escalate to SIGKILL.
    if (this.#child.exitCode === null) {
      if (!this.#child.killed) {
        this.#child.stdin.end();
      }
      const gracefulGate = Promise.withResolvers<boolean>();
      const gracefulTimer = NodeTimers.setTimeout(() => gracefulGate.resolve(false), 1_000);
      gracefulTimer.unref();
      const graceful = await Promise.race([
        this.#exitPromise.then(() => true),
        gracefulGate.promise,
      ]);
      NodeTimers.clearTimeout(gracefulTimer);
      if (!graceful && this.#child.exitCode === null) this.#child.kill("SIGKILL");
    }
    await this.#exitPromise.catch(() => undefined);
    this.#closed = true;
  }

  async #requestPromise<T>(command: OmpRpcCommand, timeoutMs: number): Promise<T> {
    if (this.#fatalError) throw this.#fatalError;
    const id = command.id ?? `t3-omp-${++this.#nextRequestId}`;
    if (this.#pendingRequests.has(id)) {
      throw new OmpRpcRuntimeError({
        operation: "request",
        command: command.type,
        detail: `Duplicate OMP request id ${id}.`,
      });
    }
    const responseGate = Promise.withResolvers<T>();
    this.#pendingRequests.set(id, {
      command: command.type,
      resolve: (value) => responseGate.resolve(value as T),
      reject: responseGate.reject,
    });
    try {
      await this.#enqueueFrame({ ...command, id });
    } catch (cause) {
      const pending = this.#pendingRequests.get(id);
      if (pending) {
        if (pending.timer) NodeTimers.clearTimeout(pending.timer);
        this.#pendingRequests.delete(id);
      }
      throw cause;
    }
    const pending = this.#pendingRequests.get(id);
    if (pending) {
      pending.timer = NodeTimers.setTimeout(() => {
        const expired = this.#pendingRequests.get(id);
        if (!expired) return;
        this.#pendingRequests.delete(id);
        expired.reject(
          new OmpRpcRuntimeError({
            operation: "request",
            command: command.type,
            detail: `Timed out after ${timeoutMs}ms.`,
          }),
        );
      }, timeoutMs);
      pending.timer.unref();
    }
    return responseGate.promise;
  }

  #selectOfferedCapabilities(
    offered: OmpRpcSemanticCapabilities | undefined,
    requested: OmpRpcSemanticCapabilities | undefined,
  ): OmpRpcSemanticCapabilities {
    if (!offered || !requested) return {};
    return Object.fromEntries(
      Object.entries(requested).flatMap(([key, revision]) => {
        const offeredRevision = offered[key as keyof OmpRpcSemanticCapabilities];
        return typeof revision === "number" &&
          typeof offeredRevision === "number" &&
          offeredRevision >= revision
          ? [[key, revision]]
          : [];
      }),
    );
  }

  async #enqueueFrame(frame: OmpRpcCommand): Promise<void> {
    const write = async () => {
      if (this.#fatalError) throw this.#fatalError;
      const json = JSON.stringify(frame);
      const byteLength = NodeBuffer.Buffer.byteLength(json, "utf8");
      if (byteLength > this.#maxLogicalBytes) {
        throw new OmpRpcRuntimeError({
          operation: "encode",
          command: frame.type,
          detail: `Logical frame exceeds ${this.#maxLogicalBytes} bytes.`,
        });
      }
      if (byteLength + 1 <= this.#maxPhysicalBytes) {
        await this.#writeLine(`${json}\n`);
        return;
      }
      if (this.#protocolVersion !== 2) {
        throw new OmpRpcRuntimeError({
          operation: "encode",
          command: frame.type,
          detail: "Oversized outbound frame requires transport protocol v2.",
        });
      }
      const bytes = NodeBuffer.Buffer.from(json, "utf8");
      const count = Math.ceil(bytes.byteLength / this.#chunkPayloadBytes);
      const chunkId = `t3-omp-chunk-${++this.#nextChunkId}`;
      for (let index = 0; index < count; index += 1) {
        const chunk = {
          type: "rpc_chunk",
          chunkId,
          index,
          count,
          byteLength: bytes.byteLength,
          data: bytes
            .subarray(index * this.#chunkPayloadBytes, (index + 1) * this.#chunkPayloadBytes)
            .toString("base64"),
        };
        const line = `${JSON.stringify(chunk)}\n`;
        if (NodeBuffer.Buffer.byteLength(line, "utf8") > this.#maxPhysicalBytes) {
          throw new OmpRpcRuntimeError({
            operation: "encode",
            command: frame.type,
            detail: "Encoded OMP RPC chunk exceeds the physical frame limit.",
          });
        }
        await this.#writeLine(line);
      }
    };
    const queued = this.#writeTail.then(write, write);
    this.#writeTail = queued.catch(() => undefined);
    return queued;
  }

  async #writeLine(line: string): Promise<void> {
    if (this.#child.stdin.destroyed || !this.#child.stdin.writable) {
      throw new OmpRpcRuntimeError({
        operation: "write",
        detail: "OMP stdin is closed.",
        exitCode: this.#child.exitCode,
      });
    }
    if (!this.#child.stdin.write(line, "utf8")) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          this.#child.stdin.off("drain", onDrain);
          this.#child.off("exit", onExit);
        };
        const onDrain = () => {
          cleanup();
          resolve();
        };
        const onExit = () => {
          cleanup();
          reject(
            new OmpRpcRuntimeError({
              operation: "write",
              detail: "OMP exited while waiting for stdin backpressure.",
              exitCode: this.#child.exitCode,
            }),
          );
        };
        this.#child.stdin.once("drain", onDrain);
        this.#child.once("exit", onExit);
        if (this.#child.exitCode !== null) onExit();
      });
    }
  }

  #onStdout(chunk: NodeBuffer.Buffer): void {
    if (this.#fatalError) return;
    this.#inputBuffer =
      this.#inputBuffer.byteLength === 0
        ? chunk
        : (NodeBuffer.Buffer.concat([this.#inputBuffer, chunk]) as unknown as NodeBuffer.Buffer);
    // Inbound physical ceiling tracks negotiated #maxPhysicalBytes (capped by
    // OMP_RPC_MAX_PHYSICAL_BYTES at ready). Same limit as outbound / chunks.
    const maxPhysical = this.#maxPhysicalBytes;
    for (;;) {
      const newline = this.#inputBuffer.indexOf(10);
      if (newline < 0) {
        if (this.#inputBuffer.byteLength >= maxPhysical) {
          this.#fail(
            new OmpRpcRuntimeError({
              operation: "decode",
              detail: `OMP physical frame exceeds ${maxPhysical} bytes.`,
            }),
          );
        }
        return;
      }
      const line = this.#inputBuffer.subarray(0, newline);
      this.#inputBuffer = this.#inputBuffer.subarray(newline + 1);
      if (line.byteLength === 0) continue;
      if (line.byteLength + 1 > maxPhysical) {
        this.#fail(
          new OmpRpcRuntimeError({
            operation: "decode",
            detail: `OMP physical frame exceeds ${maxPhysical} bytes.`,
          }),
        );
        return;
      }
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
        this.#handleParsedFrame(JSON.parse(text));
      } catch (cause) {
        this.#fail(
          isOmpRpcRuntimeError(cause)
            ? cause
            : new OmpRpcRuntimeError({
                operation: "decode",
                detail: "OMP emitted malformed JSONL.",
                cause,
              }),
        );
        return;
      }
    }
  }

  #handleParsedFrame(value: unknown): void {
    if (!isOmpRpcFrame(value)) {
      throw new OmpRpcRuntimeError({
        operation: "decode",
        detail: "OMP RPC frame must be an object with a string type.",
      });
    }
    if (isOmpRpcChunkFrame(value)) {
      const decoded = this.#decodeChunk(value);
      if (decoded) this.#dispatchFrame(decoded);
      return;
    }
    if (this.#pendingChunks) {
      throw new OmpRpcRuntimeError({
        operation: "decode",
        detail: "OMP RPC chunk sequence was interrupted.",
      });
    }
    this.#dispatchFrame(value);
  }

  #decodeChunk(frame: OmpRpcFrame): OmpRpcFrame | undefined {
    const chunkId = frame.chunkId;
    const index = frame.index;
    const count = frame.count;
    const byteLength = frame.byteLength;
    const data = frame.data;
    // Validate against negotiated peer ceilings, not only local constants.
    const maxPhysical = this.#maxPhysicalBytes;
    const maxLogical = this.#maxLogicalBytes;
    const chunkPayload = this.#chunkPayloadBytes;
    if (
      typeof chunkId !== "string" ||
      chunkId.length === 0 ||
      chunkId.length > MAX_CHUNK_ID_CHARS ||
      !Number.isSafeInteger(index) ||
      !Number.isSafeInteger(count) ||
      !Number.isSafeInteger(byteLength) ||
      typeof index !== "number" ||
      typeof count !== "number" ||
      typeof byteLength !== "number" ||
      index < 0 ||
      count < 2 ||
      index >= count ||
      count > Math.ceil(maxLogical / chunkPayload) ||
      byteLength < maxPhysical ||
      byteLength > maxLogical ||
      typeof data !== "string" ||
      data.length === 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
    ) {
      throw new OmpRpcRuntimeError({
        operation: "decode",
        detail: "OMP RPC chunk metadata is invalid.",
      });
    }
    const bytes = NodeBuffer.Buffer.from(data, "base64");
    if (bytes.toString("base64") !== data || bytes.byteLength > chunkPayload) {
      throw new OmpRpcRuntimeError({
        operation: "decode",
        detail: "OMP RPC chunk payload is invalid.",
      });
    }

    if (!this.#pendingChunks) {
      if (index !== 0) {
        throw new OmpRpcRuntimeError({
          operation: "decode",
          detail: "OMP RPC chunk sequence must start at index zero.",
        });
      }
      const timer = NodeTimers.setTimeout(() => {
        if (this.#pendingChunks?.chunkId !== chunkId) return;
        this.#pendingChunks = undefined;
        this.#fail(
          new OmpRpcRuntimeError({
            operation: "decode",
            detail: `OMP RPC chunk sequence timed out after ${this.#options.chunkAssemblyTimeoutMs}ms.`,
          }),
        );
      }, this.#options.chunkAssemblyTimeoutMs);
      timer.unref();
      this.#pendingChunks = {
        chunkId,
        count,
        byteLength,
        timer,
        nextIndex: 0,
        receivedBytes: 0,
        chunks: [],
      };
    }
    const pending = this.#pendingChunks;
    if (
      pending.chunkId !== chunkId ||
      pending.count !== count ||
      pending.byteLength !== byteLength ||
      pending.nextIndex !== index
    ) {
      throw new OmpRpcRuntimeError({
        operation: "decode",
        detail: "OMP RPC chunk sequence is interleaved or out of order.",
      });
    }
    pending.chunks.push(bytes);
    pending.receivedBytes += bytes.byteLength;
    pending.nextIndex += 1;
    if (pending.receivedBytes > pending.byteLength) {
      throw new OmpRpcRuntimeError({
        operation: "decode",
        detail: "OMP RPC chunk sequence exceeds its declared length.",
      });
    }
    if (pending.nextIndex < pending.count) return undefined;
    this.#pendingChunks = undefined;
    NodeTimers.clearTimeout(pending.timer);
    if (pending.receivedBytes !== pending.byteLength) {
      throw new OmpRpcRuntimeError({
        operation: "decode",
        detail: "OMP RPC chunk sequence length does not match its declaration.",
      });
    }
    const json = new TextDecoder("utf-8", { fatal: true }).decode(
      NodeBuffer.Buffer.concat(pending.chunks),
    );
    const decoded: unknown = JSON.parse(json);
    if (!isOmpRpcFrame(decoded) || decoded.type === "rpc_chunk") {
      throw new OmpRpcRuntimeError({
        operation: "decode",
        detail: "Reassembled OMP logical frame is invalid.",
      });
    }
    return decoded;
  }

  #clearPendingChunks(): void {
    if (!this.#pendingChunks) return;
    NodeTimers.clearTimeout(this.#pendingChunks.timer);
    this.#pendingChunks = undefined;
  }

  #dispatchFrame(frame: OmpRpcFrame): void {
    if (isOmpRpcReadyFrame(frame)) {
      if (this.#readyFrame) {
        throw new OmpRpcRuntimeError({
          operation: "decode",
          detail: "OMP emitted more than one ready frame.",
        });
      }
      this.#readyFrame = frame;
      this.#readyResolve(frame);
      return;
    }

    if (isOmpRpcResponseFrame(frame) && typeof frame.id === "string") {
      const pending = this.#pendingRequests.get(frame.id);
      if (pending) {
        if (pending.timer) NodeTimers.clearTimeout(pending.timer);
        this.#pendingRequests.delete(frame.id);
        if (frame.success) {
          pending.resolve(frame.data);
        } else {
          pending.reject(
            new OmpRpcRuntimeError({
              operation: "request",
              command: pending.command,
              detail: frame.error ?? "OMP rejected the request.",
            }),
          );
        }
        return;
      }
    }

    this.#resolveInteraction(frame);
    this.#publish(frame);
  }

  #resolveInteraction(frame: OmpRpcFrame): void {
    const id = typeof frame.id === "string" ? frame.id : undefined;
    if (!id) return;
    const kind =
      frame.type === "approval_resolved"
        ? "approval"
        : frame.type === "extension_ui_resolved" && frame.method === "ask"
          ? "ask"
          : frame.type === "plan_review_resolved"
            ? "plan_review"
            : undefined;
    if (!kind) return;
    const key = `${kind}:${id}`;
    const pending = this.#pendingInteractions.get(key);
    if (!pending) return;
    this.#pendingInteractions.delete(key);
    pending.resolve(frame);
  }

  #onStderr(chunk: NodeBuffer.Buffer): void {
    const combined =
      this.#stderrTail.byteLength === 0
        ? chunk
        : (NodeBuffer.Buffer.concat([this.#stderrTail, chunk]) as unknown as NodeBuffer.Buffer);
    this.#stderrTail =
      combined.byteLength <= this.#options.stderrTailBytes
        ? combined
        : (combined.subarray(
            combined.byteLength - this.#options.stderrTailBytes,
          ) as NodeBuffer.Buffer);
  }

  #onExit(exitCode: number | null, signal: NodeJS.Signals | null): void {
    this.#clearPendingChunks();
    this.#closed = true;
    const stderrBytes = this.#stderrTail.byteLength;
    const unexpected = this.#fatalError !== undefined || !this.#closing;
    const error =
      this.#fatalError ??
      new OmpRpcRuntimeError({
        operation: "process",
        detail: unexpected
          ? `OMP RPC process exited${signal ? ` from ${signal}` : ""}.`
          : "OMP RPC process closed.",
        exitCode,
      });
    if (unexpected) {
      this.#fatalError = error;
      this.#logDiagnostic({
        message: "OMP RPC process exited unexpectedly.",
        annotations: {
          operation: "process",
          exitCode,
          ...(signal ? { signal } : {}),
          stderrBytes,
        },
      });
    }
    this.#readyReject(error);
    for (const pending of this.#pendingRequests.values()) {
      if (pending.timer) NodeTimers.clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pendingRequests.clear();
    const outcome = unexpected ? "process_exited" : "aborted";
    this.#resolveInteractionsForExit(outcome);
    this.#publish({
      type: "t3_runtime_process_exited",
      outcome,
      exitCode,
    });
  }

  #resolveInteractionsForExit(outcome: "aborted" | "process_exited"): void {
    for (const [key, pending] of this.#pendingInteractions) {
      const frame: OmpRpcFrame = {
        type: "t3_runtime_interaction_resolved",
        interactionType: pending.kind,
        id: pending.id,
        outcome,
      };
      this.#pendingInteractions.delete(key);
      pending.resolve(frame);
      this.#publish(frame);
    }
  }

  #fail(error: OmpRpcRuntimeError): void {
    this.#clearPendingChunks();
    if (this.#fatalError) return;
    this.#fatalError = error;
    this.#readyReject(error);
    for (const pending of this.#pendingRequests.values()) {
      if (pending.timer) NodeTimers.clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pendingRequests.clear();
    this.#resolveInteractionsForExit("process_exited");
    this.#publish({
      type: "t3_runtime_error",
      error: error.detail,
      operation: error.operation,
    });
    if (this.#child.exitCode === null) this.#child.kill("SIGTERM");
  }

  async #withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    operation: string,
    detail: string,
  ): Promise<T> {
    const timeoutGate = Promise.withResolvers<T>();
    const timer = NodeTimers.setTimeout(
      () => timeoutGate.reject(new OmpRpcRuntimeError({ operation, detail })),
      timeoutMs,
    );
    timer.unref();
    try {
      return await Promise.race([promise, timeoutGate.promise]);
    } finally {
      NodeTimers.clearTimeout(timer);
    }
  }
}

export const makeOmpRpcRuntime = Effect.fn("makeOmpRpcRuntime")(function* (
  options: OmpRpcRuntimeOptions,
) {
  const notifications = yield* Effect.acquireRelease(
    PubSub.unbounded<OmpRpcFrame>(),
    PubSub.shutdown,
  );
  const services = yield* Effect.context<never>();
  const implementation = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        new OmpRpcRuntimeImpl(
          options,
          (frame) => {
            Effect.runSyncWith(services)(PubSub.publish(notifications, frame));
          },
          ({ message, annotations }) => {
            Effect.runSyncWith(services)(Effect.logWarning(message, annotations));
          },
        ),
      catch: (cause) =>
        isOmpRpcRuntimeError(cause)
          ? cause
          : new OmpRpcRuntimeError({
              operation: "spawn",
              detail: `Failed to spawn ${options.binaryPath}.`,
              cause,
            }),
    }),
    (runtime) => Effect.promise(() => runtime.close()),
  );
  yield* Effect.tryPromise({
    try: () => implementation.initialize(),
    catch: (cause) =>
      isOmpRpcRuntimeError(cause)
        ? cause
        : new OmpRpcRuntimeError({
            operation: "initialize",
            detail: "Failed to initialize OMP RPC runtime.",
            cause,
          }),
  }).pipe(
    Effect.onError(() =>
      Effect.promise(() => implementation.close()).pipe(
        Effect.andThen(PubSub.shutdown(notifications)),
      ),
    ),
  );

  return {
    get ready() {
      return implementation.ready;
    },
    get protocolVersion() {
      return implementation.protocolVersion;
    },
    get capabilities() {
      return implementation.capabilities;
    },
    get stderrTail() {
      return implementation.stderrTail;
    },
    request: <T = unknown>(
      command: OmpRpcCommand,
      requestOptions?: { readonly timeoutMs?: number },
    ) => implementation.request<T>(command, requestOptions),
    notify: (frame: OmpRpcCommand) => implementation.notify(frame),
    awaitInteractionResolution: (kind: OmpRpcInteractionKind, id: string) =>
      implementation.awaitInteractionResolution(kind, id),
    close: Effect.promise(() => implementation.close()).pipe(
      Effect.andThen(PubSub.shutdown(notifications)),
    ),
    notifications: Stream.fromPubSub(notifications),
    subscribeNotifications: PubSub.subscribe(notifications),
  } satisfies OmpRpcRuntimeShape;
});
