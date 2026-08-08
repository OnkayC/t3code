// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  EventId,
  ProviderDriverKind,
  TurnId,
  type OmpSettings,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type ProviderRespondToPlanReviewInput,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderSetInteractionModeInput,
  type ProviderUserInputResponse,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import {
  type ProviderAdapterError,
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type {
  ProviderAdapterShape,
  ProviderThreadSnapshot,
  ProviderThreadTurnSnapshot,
} from "../Services/ProviderAdapter.ts";
import {
  buildOmpInteractiveArgs,
  decodeOmpSessionCursor,
  isFullOmpCapabilityProfile,
  OMP_REQUIRED_SEMANTIC_CAPABILITIES,
  redactOmpRpcPayload,
  type OmpRpcFrame,
  type OmpSessionCursor,
} from "../omp/OmpRpcProtocol.ts";
import {
  makeOmpRpcRuntime,
  OmpRpcRuntimeError,
  type OmpRpcRuntimeOptions,
  type OmpRpcRuntimeShape,
} from "../omp/OmpRpcRuntime.ts";
import {
  makeOmpRuntimeEventNormalizer,
  scopedOmpApprovalRequestId,
  type OmpRuntimeEventNormalizer,
} from "../omp/OmpRuntimeEvents.ts";

const PROVIDER = ProviderDriverKind.make("omp");
const DEFAULT_CWD = process.cwd();
const isProviderAdapterValidationError = Schema.is(ProviderAdapterValidationError);

export interface MakeOmpAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly sessionRoot: string;
  readonly attachmentsDir?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => string;
  /** Bound for native approval/ask/plan-review resolution waits. */
  readonly interactionResolutionTimeout?: `${number} seconds` | `${number} millis`;
  readonly makeRuntime?: (
    options: OmpRpcRuntimeOptions,
  ) => Effect.Effect<OmpRpcRuntimeShape, OmpRpcRuntimeError, Scope.Scope>;
}

interface PendingOmpApproval {
  readonly nativeId: string;
  readonly allowedDecisions: ReadonlySet<string>;
}

interface OmpSessionContext {
  readonly threadId: ThreadId;
  readonly scope: Scope.Closeable;
  readonly runtime: OmpRpcRuntimeShape;
  readonly normalizer: OmpRuntimeEventNormalizer;
  /** Serializes sendTurn admission so idle races cannot open two new turns. */
  readonly sendTurnLock: Semaphore.Semaphore;
  /** Keyed by thread-scoped request id; value holds native id for respond. */
  readonly pendingApprovals: Map<string, PendingOmpApproval>;
  readonly pendingAsks: Set<string>;
  readonly pendingPlanReviews: Set<string>;
  readonly nativeTurns: Array<TurnId>;
  /** Queued follow-up turn ids awaiting promotion (may lack a model override). */
  readonly queuedTurnIds: Set<TurnId>;
  readonly queuedModelSelections: Map<
    TurnId,
    NonNullable<ProviderSessionStartInput["modelSelection"]>
  >;
  readonly cwd: string;
  session: ProviderSession;
  modelSelection: ProviderSessionStartInput["modelSelection"];
  stopped: boolean;
  exitPublished: boolean;
  eventFiber?: Fiber.Fiber<void, unknown>;
}

interface OmpStateResponse {
  readonly sessionId?: unknown;
  readonly sessionFile?: unknown;
  readonly isStreaming?: unknown;
  readonly model?: unknown;
  readonly thinkingLevel?: unknown;
}

function modelSlugFromOmpState(model: unknown): string | undefined {
  if (typeof model === "string" && model.length > 0) return model;
  if (model === null || typeof model !== "object" || Array.isArray(model)) return undefined;
  const record = model as Record<string, unknown>;
  const id =
    typeof record.id === "string"
      ? record.id
      : typeof record.modelId === "string"
        ? record.modelId
        : undefined;
  if (!id) return undefined;
  const provider = typeof record.provider === "string" ? record.provider : undefined;
  return provider ? `${provider}/${id}` : id;
}

interface OmpTurnsResponse {
  readonly turns?: unknown;
}

interface OmpMessagesResponse {
  readonly messages?: unknown;
  readonly nextCursor?: unknown;
  readonly totalMessages?: unknown;
}

const failValidation = (operation: string, issue: string, cause?: unknown) =>
  new ProviderAdapterValidationError({
    provider: PROVIDER,
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });

const mapRuntimeError = (method: string, error: OmpRpcRuntimeError): ProviderAdapterRequestError =>
  new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: error.message,
    cause: error,
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const OMP_THINKING_OPTION_IDS = ["reasoning", "effort", "thinking", "thinkingLevel"] as const;
/** OMP advertises thinking under `reasoning` (see OmpProvider descriptors). */
const OMP_DEFAULT_THINKING_OPTION_ID = "reasoning";

function optionValue(
  selection: ProviderSessionStartInput["modelSelection"],
  ids: ReadonlyArray<string>,
): string | boolean | undefined {
  for (const option of selection?.options ?? []) {
    if (ids.includes(option.id)) return option.value;
  }
  return undefined;
}

/**
 * Merge a native thinking-level change into existing model options without
 * dropping unrelated entries (e.g. fastMode). Prefer the advertised option id
 * already present on the selection; fall back to OMP's `reasoning` descriptor.
 */
function mergeNativeThinkingOptions(
  options: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined,
  thinkingLevel: string | undefined,
): ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> {
  const existing = options ? [...options] : [];
  if (thinkingLevel === undefined) return existing;
  const thinkingIds: ReadonlyArray<string> = OMP_THINKING_OPTION_IDS;
  const current = existing.find((option) => thinkingIds.includes(option.id));
  const id = current?.id ?? OMP_DEFAULT_THINKING_OPTION_ID;
  if (current) {
    return existing.map((option) =>
      option.id === current.id ? { id: option.id, value: thinkingLevel } : option,
    );
  }
  return [...existing, { id, value: thinkingLevel }];
}

function modelParts(model: string): { readonly provider?: string; readonly modelId: string } {
  const separator = model.indexOf("/");
  return separator > 0
    ? { provider: model.slice(0, separator), modelId: model.slice(separator + 1) }
    : { modelId: model };
}

function selectionFingerprint(selection: ProviderSessionStartInput["modelSelection"]): string {
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify(selection ?? null))
    .digest("hex");
}

function nativeTurnOptions(selection: ProviderSessionStartInput["modelSelection"]):
  | {
      readonly provider?: string;
      readonly modelId: string;
      readonly thinkingLevel?: string;
      readonly fastMode?: boolean;
    }
  | undefined {
  if (!selection) return undefined;
  const model = modelParts(selection.model);
  const thinking = optionValue(selection, ["reasoning", "effort", "thinking", "thinkingLevel"]);
  const fastMode = optionValue(selection, ["fastMode", "fast"]);
  return {
    ...model,
    ...(typeof thinking === "string" ? { thinkingLevel: thinking } : {}),
    ...(typeof fastMode === "boolean" ? { fastMode } : {}),
  };
}

function isContained(root: string, candidate: string): boolean {
  const relative = NodePath.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${NodePath.sep}`) &&
      relative !== ".." &&
      !NodePath.isAbsolute(relative))
  );
}

function containedSessionFileInside(
  root: string,
  candidate: string,
  operation: string,
  options?: { readonly allowMissingFile?: boolean },
): string {
  try {
    const realRoot = NodeFS.realpathSync(root);
    const absoluteCandidate = NodePath.resolve(candidate);
    let candidateExists = true;
    try {
      NodeFS.lstatSync(absoluteCandidate);
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
      candidateExists = false;
    }

    if (!candidateExists) {
      if (!options?.allowMissingFile) {
        throw failValidation(
          operation,
          "OMP session cursor does not resolve to a readable regular file.",
        );
      }
      const realParent = NodeFS.realpathSync(NodePath.dirname(absoluteCandidate));
      if (!NodeFS.statSync(realParent).isDirectory() || !isContained(realRoot, realParent)) {
        throw failValidation(
          operation,
          "OMP session cursor escapes the selected instance session directory.",
        );
      }
      return NodePath.join(realParent, NodePath.basename(absoluteCandidate));
    }

    const realCandidate = NodeFS.realpathSync(absoluteCandidate);
    if (!isContained(realRoot, realCandidate)) {
      throw failValidation(
        operation,
        "OMP session cursor escapes the selected instance session directory.",
      );
    }
    if (!NodeFS.statSync(realCandidate).isFile()) {
      throw failValidation(operation, "OMP session cursor does not resolve to a regular file.");
    }
    return realCandidate;
  } catch (cause) {
    if (isProviderAdapterValidationError(cause)) throw cause;
    throw failValidation(
      operation,
      "OMP session cursor does not resolve to a readable regular file.",
      cause,
    );
  }
}

function realRegularFileInside(root: string, candidate: string, operation: string): string {
  return containedSessionFileInside(root, candidate, operation);
}

function resolveResumePath(
  sessionRoot: string,
  value: unknown,
): {
  readonly cursor?: OmpSessionCursor;
  readonly resumePath?: string;
} {
  if (value === undefined) return {};
  const cursor = decodeOmpSessionCursor(value);
  if (!cursor) throw failValidation("startSession", "Invalid OMP resume cursor.");
  const candidate = NodePath.join(sessionRoot, cursor.sessionKey);
  try {
    return {
      cursor,
      resumePath: realRegularFileInside(sessionRoot, candidate, "startSession"),
    };
  } catch (cause) {
    // Lazy session files may not exist yet. Recover by starting without resume
    // rather than failing on an invalid resume path.
    if (isProviderAdapterValidationError(cause)) {
      try {
        containedSessionFileInside(sessionRoot, candidate, "startSession", {
          allowMissingFile: true,
        });
        return {};
      } catch {
        throw cause;
      }
    }
    throw cause;
  }
}

/**
 * Soft resume-cursor resolution for notification paths where a missing or
 * invalid sessionFile must not defect the event fiber (session_changed /
 * plan-review promotion). Returns undefined when identity/file is absent or
 * not yet materialised; still throws for path-escape / hard validation errors
 * only after both fields are present strings.
 */
function softCursorFromState(
  sessionRoot: string,
  state: { readonly sessionId?: unknown; readonly sessionFile?: unknown },
): OmpSessionCursor | undefined {
  if (typeof state.sessionId !== "string" || state.sessionId.length === 0) {
    return undefined;
  }
  if (typeof state.sessionFile !== "string" || state.sessionFile.length === 0) {
    return undefined;
  }
  try {
    return cursorFromState(sessionRoot, {
      sessionId: state.sessionId,
      sessionFile: state.sessionFile,
    } as OmpStateResponse);
  } catch (cause) {
    if (isProviderAdapterValidationError(cause)) return undefined;
    throw cause;
  }
}

function cursorFromState(
  sessionRoot: string,
  state: OmpStateResponse,
): OmpSessionCursor | undefined {
  if (typeof state.sessionId !== "string" || state.sessionId.length === 0) {
    throw failValidation("get_state", "OMP did not return a session identity.");
  }
  if (typeof state.sessionFile !== "string" || state.sessionFile.length === 0) {
    throw failValidation("get_state", "OMP did not return a session file.");
  }
  try {
    const sessionFile = containedSessionFileInside(sessionRoot, state.sessionFile, "get_state");
    const realRoot = NodeFS.realpathSync(sessionRoot);
    return {
      schemaVersion: 1,
      sessionKey: NodePath.relative(realRoot, sessionFile).split(NodePath.sep).join("/"),
      sessionId: state.sessionId,
    };
  } catch (cause) {
    // File is not yet materialised (lazy session). Validate containment only and
    // omit the resume cursor until a regular file exists.
    if (isProviderAdapterValidationError(cause)) {
      containedSessionFileInside(sessionRoot, state.sessionFile, "get_state", {
        allowMissingFile: true,
      });
      return undefined;
    }
    throw cause;
  }
}

function validateRuntimeMode(input: ProviderSessionStartInput): "always-ask" | "write" | "yolo" {
  if (input.sandboxMode !== undefined) {
    throw failValidation(
      "startSession",
      "OMP does not provide an OS sandbox; sandboxMode must be omitted.",
    );
  }
  switch (input.runtimeMode) {
    case "approval-required":
      if (input.approvalPolicy !== undefined && input.approvalPolicy !== "on-request") {
        throw failValidation(
          "startSession",
          "approval-required requires approvalPolicy on-request.",
        );
      }
      return "always-ask";
    case "auto-accept-edits":
      if (input.approvalPolicy !== undefined && input.approvalPolicy !== "on-failure") {
        throw failValidation(
          "startSession",
          "auto-accept-edits requires approvalPolicy on-failure.",
        );
      }
      return "write";
    case "full-access":
      if (input.approvalPolicy !== undefined && input.approvalPolicy !== "never") {
        throw failValidation("startSession", "full-access requires approvalPolicy never.");
      }
      return "yolo";
    case "auto":
      throw failValidation("startSession", "OMP does not support the auto-review runtime mode.");
  }
}

function approvalDecision(decision: ProviderApprovalDecision): string {
  switch (decision) {
    case "accept":
      return "approve_once";
    case "acceptForSession":
      return "approve_session";
    case "decline":
      return "deny";
    case "cancel":
      return "cancel";
  }
}

function loadImages(input: {
  readonly attachmentsDir?: string | undefined;
  readonly attachments: ProviderSendTurnInput["attachments"];
}): Effect.Effect<
  ReadonlyArray<{ readonly type: "image"; readonly data: string; readonly mimeType: string }>,
  ProviderAdapterValidationError
> {
  if (!input.attachments || input.attachments.length === 0) return Effect.succeed([]);
  if (!input.attachmentsDir) {
    return Effect.fail(
      failValidation(
        "sendTurn",
        "OMP attachment delivery requires a configured attachment directory.",
      ),
    );
  }
  const attachmentsDir = input.attachmentsDir;
  return Effect.forEach(
    input.attachments,
    (attachment) => {
      const path = resolveAttachmentPath({ attachmentsDir, attachment });
      if (!path) {
        return Effect.fail(
          failValidation("sendTurn", `Attachment '${attachment.id}' is not available.`),
        );
      }
      return Effect.tryPromise({
        try: () => NodeFS.promises.readFile(path, "base64"),
        catch: (cause) =>
          failValidation("sendTurn", `Attachment '${attachment.id}' could not be read.`, cause),
      }).pipe(
        Effect.map((data) => ({
          type: "image" as const,
          data,
          mimeType: attachment.mimeType,
        })),
      );
    },
    { concurrency: "unbounded" },
  );
}

function planResponseFrame(response: ProviderUserInputResponse): Record<string, unknown> {
  switch (response.kind) {
    case "submit":
      return {
        result: {
          kind: "submit",
          results: Object.entries(response.answers).map(([id, answer]) => ({ id, ...answer })),
        },
      };
    case "chat":
      return { result: { kind: "chat" } };
    case "cancel":
      return { cancelled: true };
  }
}

function readTurns(
  response: OmpTurnsResponse,
  messages: ReadonlyArray<unknown> = [],
): ReadonlyArray<ProviderThreadTurnSnapshot> {
  if (!Array.isArray(response.turns)) return [];
  const durableTurns = response.turns.flatMap((value) => {
    if (
      !isRecord(value) ||
      typeof value.clientTurnId !== "string" ||
      value.clientTurnId.length === 0
    ) {
      return [];
    }
    return [
      {
        id: TurnId.make(value.clientTurnId),
        nativeItems: Array.isArray(value.items) ? value.items : [],
      },
    ];
  });
  const itemsByTurn = new Map<TurnId, Array<unknown>>(
    durableTurns.map((turn) => [turn.id, [...turn.nativeItems]]),
  );
  let sequentialTurnIndex = -1;
  for (const message of messages) {
    const record = isRecord(message) ? message : undefined;
    const explicitTurnId =
      typeof record?.clientTurnId === "string" && record.clientTurnId.length > 0
        ? TurnId.make(record.clientTurnId)
        : undefined;
    if (!explicitTurnId && record?.role === "user") {
      sequentialTurnIndex = Math.min(sequentialTurnIndex + 1, durableTurns.length - 1);
    }
    const turnId = explicitTurnId ?? durableTurns[Math.max(sequentialTurnIndex, 0)]?.id;
    if (turnId && itemsByTurn.has(turnId)) {
      itemsByTurn.get(turnId)?.push(redactOmpRpcPayload(message));
    }
  }
  return durableTurns.map((turn) => ({ id: turn.id, items: itemsByTurn.get(turn.id) ?? [] }));
}

function messagesFromResponse(response: OmpMessagesResponse): ReadonlyArray<unknown> {
  return Array.isArray(response.messages) ? response.messages : [];
}

export const makeOmpAdapter = Effect.fn("makeOmpAdapter")(function* (
  settings: OmpSettings,
  options: MakeOmpAdapterOptions,
) {
  NodeFS.mkdirSync(options.sessionRoot, { recursive: true });
  const runtimeEvents = yield* Effect.acquireRelease(
    PubSub.unbounded<ProviderRuntimeEvent>(),
    PubSub.shutdown,
  );
  const adapterScope = yield* Effect.scope;
  const sessions = new Map<ThreadId, OmpSessionContext>();
  const makeRuntime = options.makeRuntime ?? makeOmpRpcRuntime;
  const now = options.now ?? (() => DateTime.formatIso(DateTime.nowUnsafe()));
  const interactionResolutionTimeout =
    options.interactionResolutionTimeout ?? ("30 seconds" as const);

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<OmpSessionContext, ProviderAdapterError> => {
    const context = sessions.get(threadId);
    return context
      ? Effect.succeed(context)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  /**
   * Enrich bare model/thinking notices with live state. Kept interruptible so
   * stopContext can Fiber.interrupt the event fiber without waiting on the full
   * get_state timeout (publishFrames' mutation/publish path stays uninterruptible).
   */
  const enrichNativeModelFrame = (
    context: OmpSessionContext,
    frame: OmpRpcFrame,
  ): Effect.Effect<{
    readonly frame: OmpRpcFrame;
    readonly selection?: NonNullable<ProviderSessionStartInput["modelSelection"]>;
    readonly modelSlug?: string;
  }> =>
    Effect.gen(function* () {
      if (context.stopped) return { frame };
      const state = yield* context.runtime
        .request<OmpStateResponse>({ type: "get_state" })
        .pipe(Effect.catch(() => Effect.succeed(null)));
      // Prefer live get_state, then model carried on the native notice, then
      // the last known session selection (stale only as last resort).
      const modelSlug =
        modelSlugFromOmpState(state?.model) ??
        modelSlugFromOmpState(frame.model) ??
        context.modelSelection?.model ??
        context.session.model;
      const thinkingLevel =
        typeof frame.thinkingLevel === "string"
          ? frame.thinkingLevel
          : typeof state?.thinkingLevel === "string"
            ? state.thinkingLevel
            : optionValue(context.modelSelection, [...OMP_THINKING_OPTION_IDS]);
      if (typeof modelSlug !== "string" || modelSlug.length === 0) return { frame };
      const nextOptions = mergeNativeThinkingOptions(
        context.modelSelection?.options,
        typeof thinkingLevel === "string" ? thinkingLevel : undefined,
      );
      const nextSelection = {
        instanceId: options.instanceId,
        model: modelSlug,
        ...(nextOptions.length > 0 ? { options: [...nextOptions] } : {}),
      };
      return {
        frame: {
          ...frame,
          model: modelSlug,
          ...(typeof thinkingLevel === "string" ? { thinkingLevel } : {}),
          modelSelection: nextSelection,
        },
        selection: nextSelection,
        modelSlug,
      };
    });

  const publishFrames = (context: OmpSessionContext, frame: OmpRpcFrame) =>
    Effect.gen(function* () {
      // Interruptible enrichment: do not hold Fiber.interrupt behind get_state.
      const enriched =
        frame.type === "model_changed" || frame.type === "thinking_level_changed"
          ? yield* enrichNativeModelFrame(context, frame)
          : { frame };

      yield* Effect.gen(function* () {
        if (enriched.frame.type === "t3_runtime_process_exited") {
          if (context.exitPublished) return;
          context.exitPublished = true;
        }
        let canonicalFrame = enriched.frame;
        if (enriched.frame.type === "approval_request" && typeof enriched.frame.id === "string") {
          if (context.stopped) return;
          const nativeId = enriched.frame.id;
          const scopedId = scopedOmpApprovalRequestId(context.threadId, nativeId);
          context.pendingApprovals.set(scopedId, {
            nativeId,
            allowedDecisions: new Set(
              Array.isArray(enriched.frame.allowedDecisions)
                ? enriched.frame.allowedDecisions.filter(
                    (value): value is string => typeof value === "string",
                  )
                : [],
            ),
          });
        } else if (
          enriched.frame.type === "approval_resolved" &&
          typeof enriched.frame.id === "string"
        ) {
          const scopedId = scopedOmpApprovalRequestId(context.threadId, enriched.frame.id);
          if (!context.pendingApprovals.delete(scopedId)) return;
        } else if (
          enriched.frame.type === "extension_ui_request" &&
          enriched.frame.method === "ask" &&
          typeof enriched.frame.id === "string"
        ) {
          if (context.stopped) return;
          context.pendingAsks.add(enriched.frame.id);
        } else if (
          enriched.frame.type === "extension_ui_resolved" &&
          enriched.frame.method === "ask" &&
          typeof enriched.frame.id === "string"
        ) {
          if (!context.pendingAsks.delete(enriched.frame.id)) return;
        } else if (enriched.frame.type === "plan_review_request") {
          if (context.stopped) return;
          const id =
            typeof enriched.frame.id === "string" ? enriched.frame.id : enriched.frame.requestId;
          if (typeof id === "string") context.pendingPlanReviews.add(id);
        } else if (
          enriched.frame.type === "plan_review_resolved" &&
          typeof enriched.frame.id === "string"
        ) {
          if (!context.pendingPlanReviews.delete(enriched.frame.id)) return;
        } else if (
          enriched.frame.type === "t3_runtime_interaction_resolved" &&
          typeof enriched.frame.id === "string"
        ) {
          const claimed =
            enriched.frame.interactionType === "approval"
              ? (() => {
                  const id = enriched.frame.id as string;
                  const scoped = id.startsWith(`${context.threadId}:`)
                    ? id
                    : scopedOmpApprovalRequestId(context.threadId, id);
                  return context.pendingApprovals.delete(scoped);
                })()
              : enriched.frame.interactionType === "ask"
                ? context.pendingAsks.delete(enriched.frame.id)
                : enriched.frame.interactionType === "plan_review"
                  ? context.pendingPlanReviews.delete(enriched.frame.id)
                  : false;
          if (!claimed) return;
        }

        if (enriched.frame.type === "agent_start" || enriched.frame.type === "host_turn_promoted") {
          if (typeof enriched.frame.clientTurnId === "string") {
            const turnId = TurnId.make(enriched.frame.clientTurnId);
            const queuedSelection = context.queuedModelSelections.get(turnId);
            context.queuedTurnIds.delete(turnId);
            if (queuedSelection) {
              context.queuedModelSelections.delete(turnId);
              context.modelSelection = queuedSelection;
            }
            context.session = {
              ...context.session,
              status: "running",
              activeTurnId: turnId,
              ...(queuedSelection ? { model: queuedSelection.model } : {}),
              updatedAt: DateTime.formatIso(yield* DateTime.now),
            };
          }
        } else if (
          enriched.frame.type === "host_turn_cancelled" &&
          typeof enriched.frame.clientTurnId === "string"
        ) {
          const turnId = TurnId.make(enriched.frame.clientTurnId);
          context.queuedTurnIds.delete(turnId);
          context.queuedModelSelections.delete(turnId);
        } else if (enriched.frame.type === "agent_end") {
          context.session = {
            ...context.session,
            status: "ready",
            activeTurnId: undefined,
            updatedAt: DateTime.formatIso(yield* DateTime.now),
          };
        } else if (enriched.frame.type === "session_changed") {
          if (typeof enriched.frame.sessionId === "string" && enriched.frame.sessionId.length > 0) {
            // Soft: missing/invalid sessionFile is a no-op, not a fiber defect.
            const cursor = softCursorFromState(options.sessionRoot, {
              sessionId: enriched.frame.sessionId,
              sessionFile: enriched.frame.sessionFile,
            });
            if (cursor) {
              context.session = {
                ...context.session,
                resumeCursor: cursor,
                updatedAt: DateTime.formatIso(yield* DateTime.now),
              };
              canonicalFrame = { ...enriched.frame, resumeCursor: cursor };
            }
          }
        } else if (
          enriched.frame.type === "model_changed" ||
          enriched.frame.type === "thinking_level_changed"
        ) {
          // Apply interruptible enrichment results under the uninterruptible
          // publish region so session/modelSelection updates stay atomic with
          // the projected runtime event.
          if (enriched.selection && enriched.modelSlug) {
            context.modelSelection = enriched.selection;
            context.session = {
              ...context.session,
              model: enriched.modelSlug,
              updatedAt: DateTime.formatIso(yield* DateTime.now),
            };
          }
        } else if (enriched.frame.type === "t3_runtime_process_exited") {
          context.session = {
            ...context.session,
            status: "closed",
            activeTurnId: undefined,
            updatedAt: DateTime.formatIso(yield* DateTime.now),
          };
        }

        for (const event of context.normalizer.map(canonicalFrame)) {
          yield* PubSub.publish(runtimeEvents, event);
        }
      }).pipe(Effect.uninterruptible);
    });

  const applyModelSelection = (
    context: OmpSessionContext,
    selection: ProviderSessionStartInput["modelSelection"],
  ): Effect.Effect<void, ProviderAdapterError> =>
    Effect.gen(function* () {
      if (!selection) return;
      const model = modelParts(selection.model);
      yield* context.runtime
        .request({
          type: "set_model",
          ...(model.provider ? { provider: model.provider } : {}),
          modelId: model.modelId,
        })
        .pipe(Effect.mapError((error) => mapRuntimeError("set_model", error)));
      const thinking = optionValue(selection, ["reasoning", "effort", "thinking", "thinkingLevel"]);
      if (typeof thinking === "string") {
        yield* context.runtime
          .request({ type: "set_thinking_level", level: thinking })
          .pipe(Effect.mapError((error) => mapRuntimeError("set_thinking_level", error)));
      }
      const fast = optionValue(selection, ["fastMode", "fast"]);
      if (typeof fast === "boolean") {
        yield* context.runtime
          .request({ type: "set_fast_mode", enabled: fast })
          .pipe(Effect.mapError((error) => mapRuntimeError("set_fast_mode", error)));
      }
      context.modelSelection = selection;
      context.session = { ...context.session, model: selection.model };
    });

  const applyInteractionMode = (
    context: OmpSessionContext,
    input: Pick<ProviderSetInteractionModeInput, "interactionMode" | "workflow">,
  ): Effect.Effect<void, ProviderAdapterError> => {
    const status =
      input.interactionMode === "default"
        ? "off"
        : input.interactionMode === "plan-paused"
          ? "paused"
          : "active";
    return context.runtime
      .request({
        type: "set_plan_mode",
        status,
        ...(input.workflow ? { workflow: input.workflow } : {}),
      })
      .pipe(Effect.mapError((error) => mapRuntimeError("set_plan_mode", error)));
  };
  const withExpectedTurn = <A, E, R>(
    context: OmpSessionContext,
    turnId: TurnId,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> => {
    context.normalizer.expectTurn(turnId);
    return effect.pipe(
      Effect.onError(() =>
        Effect.sync(() => {
          context.normalizer.cancelExpectedTurn(turnId);
          context.queuedTurnIds.delete(turnId);
          context.queuedModelSelections.delete(turnId);
        }),
      ),
    );
  };

  const readMessages = (
    context: OmpSessionContext,
  ): Effect.Effect<ReadonlyArray<unknown>, ProviderAdapterError> => {
    const paged = Effect.gen(function* () {
      const messages: Array<unknown> = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      let expectedTotal: number | undefined;
      do {
        const page = yield* context.runtime
          .request<OmpMessagesResponse>({
            type: "get_messages_page",
            ...(cursor ? { cursor } : {}),
            limit: 256,
          })
          .pipe(Effect.mapError((error) => mapRuntimeError("get_messages_page", error)));
        const pageMessages = messagesFromResponse(page);
        messages.push(...pageMessages);
        if (typeof page.totalMessages === "number" && Number.isSafeInteger(page.totalMessages)) {
          if (expectedTotal !== undefined && expectedTotal !== page.totalMessages) {
            return yield* failValidation(
              "readThread",
              "OMP message pagination changed while reading history.",
            );
          }
          expectedTotal = page.totalMessages;
        }
        cursor =
          typeof page.nextCursor === "string" && page.nextCursor.length > 0
            ? page.nextCursor
            : undefined;
        if (cursor && seenCursors.has(cursor)) {
          return yield* failValidation("readThread", "OMP message pagination repeated a cursor.");
        }
        if (cursor) seenCursors.add(cursor);
      } while (cursor);
      if (expectedTotal !== undefined && expectedTotal !== messages.length) {
        return yield* failValidation(
          "readThread",
          "OMP message pagination ended before the advertised total.",
        );
      }
      return messages;
    });
    return paged.pipe(
      Effect.catchCause(() =>
        context.runtime.request<OmpMessagesResponse>({ type: "get_messages" }).pipe(
          Effect.map(messagesFromResponse),
          Effect.mapError((error) => mapRuntimeError("get_messages", error)),
        ),
      ),
    );
  };

  const readThread = (
    threadId: ThreadId,
  ): Effect.Effect<ProviderThreadSnapshot, ProviderAdapterError> =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const [response, messages] = yield* Effect.all([
        context.runtime
          .request<OmpTurnsResponse>({ type: "get_turns" })
          .pipe(Effect.mapError((error) => mapRuntimeError("get_turns", error))),
        readMessages(context),
      ]);
      const turns = readTurns(response, messages);
      context.nativeTurns.splice(0, context.nativeTurns.length, ...turns.map((turn) => turn.id));
      return { threadId, turns };
    });

  const resolvePendingInteractions = (context: OmpSessionContext) =>
    Effect.gen(function* () {
      for (const id of context.pendingApprovals.keys()) {
        yield* publishFrames(context, {
          type: "t3_runtime_interaction_resolved",
          interactionType: "approval",
          id,
          outcome: "aborted",
        });
      }
      for (const id of context.pendingAsks) {
        yield* publishFrames(context, {
          type: "t3_runtime_interaction_resolved",
          interactionType: "ask",
          id,
          outcome: "aborted",
        });
      }
      for (const id of context.pendingPlanReviews) {
        yield* publishFrames(context, {
          type: "t3_runtime_interaction_resolved",
          interactionType: "plan_review",
          id,
          outcome: "aborted",
        });
      }
    });

  const stopContext = (
    context: OmpSessionContext,
    stopOptions?: {
      readonly emitExitEvent?: boolean;
      readonly exitFrame?: OmpRpcFrame;
      readonly interruptEventFiber?: boolean;
    },
  ) =>
    Effect.gen(function* () {
      if (context.stopped) return;
      context.stopped = true;
      yield* resolvePendingInteractions(context);
      if (stopOptions?.interruptEventFiber !== false && context.eventFiber) {
        yield* Fiber.interrupt(context.eventFiber);
      }
      yield* Scope.close(context.scope, Exit.void);
      if (sessions.get(context.threadId) === context) sessions.delete(context.threadId);
      // session.exited is the cleanup receipt: consumers may treat it as proof
      // that the runtime scope is closed and the session is no longer live.
      if (stopOptions?.emitExitEvent !== false) {
        yield* publishFrames(
          context,
          stopOptions?.exitFrame ?? {
            type: "t3_runtime_process_exited",
            outcome: "aborted",
          },
        );
      }
    }).pipe(Effect.uninterruptible);

  yield* Scope.addFinalizer(
    adapterScope,
    Effect.suspend(() =>
      Effect.forEach(Array.from(sessions.values()), (context) => stopContext(context), {
        concurrency: "unbounded",
        discard: true,
      }),
    ).pipe(Effect.ignore),
  );

  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
      supportedInteractionModes: ["default", "plan", "plan-paused"],
      supportedTurnDeliveryModes: ["steer", "follow-up"],
      planReviewContextStrategies: ["fresh", "preserve", "compact"],
      supportsPlanExecutionModelSelection: true,
    },

    startSession: (input) =>
      Effect.gen(function* () {
        if (sessions.has(input.threadId)) {
          return yield* failValidation(
            "startSession",
            `OMP session already exists for thread '${input.threadId}'.`,
          );
        }
        if (
          input.providerInstanceId !== undefined &&
          input.providerInstanceId !== options.instanceId
        ) {
          return yield* failValidation(
            "startSession",
            "Provider instance does not match this OMP adapter.",
          );
        }
        // Sync validators throw YieldableErrors; lift them into the Effect channel.
        const approvalMode = yield* Effect.try({
          try: () => validateRuntimeMode(input),
          catch: (cause) =>
            isProviderAdapterValidationError(cause)
              ? cause
              : failValidation("startSession", "Invalid OMP runtime mode.", cause),
        });
        const resume = yield* Effect.try({
          try: () => resolveResumePath(options.sessionRoot, input.resumeCursor),
          catch: (cause) =>
            isProviderAdapterValidationError(cause)
              ? cause
              : failValidation("startSession", "Invalid OMP resume cursor.", cause),
        });
        const cwd = input.cwd ?? DEFAULT_CWD;
        const sessionScope = yield* Scope.make("sequential");
        let sessionScopeTransferred = false;
        yield* Effect.addFinalizer(() =>
          sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
        );
        const runtime = yield* makeRuntime({
          binaryPath: settings.binaryPath,
          args: buildOmpInteractiveArgs({
            launchArgs: settings.launchArgs,
            sessionDir: options.sessionRoot,
            ...(settings.profile ? { profile: settings.profile } : {}),
            ...(resume.resumePath ? { resumePath: resume.resumePath } : {}),
          }),
          cwd,
          ...(options.environment ? { env: options.environment } : {}),
          capabilities: OMP_REQUIRED_SEMANTIC_CAPABILITIES,
        }).pipe(
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.mapError(
            (error) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: error.message,
                cause: error,
              }),
          ),
        );
        if (runtime.protocolVersion !== 2 || !isFullOmpCapabilityProfile(runtime.capabilities)) {
          return yield* failValidation(
            "startSession",
            "Installed OMP is incompatible: transport v2 and every semantic capability revision 1 are required.",
          );
        }

        yield* runtime
          .request({ type: "set_runtime_policy", approvalMode })
          .pipe(Effect.mapError((error) => mapRuntimeError("set_runtime_policy", error)));
        const state = yield* runtime
          .request<OmpStateResponse>({ type: "get_state" })
          .pipe(Effect.mapError((error) => mapRuntimeError("get_state", error)));
        const cursor = yield* Effect.try({
          try: () => cursorFromState(options.sessionRoot, state),
          catch: (cause) =>
            isProviderAdapterValidationError(cause)
              ? cause
              : failValidation("get_state", "Invalid OMP session state.", cause),
        });
        if (resume.cursor && cursor && resume.cursor.sessionId !== cursor.sessionId) {
          return yield* failValidation(
            "startSession",
            "OMP resumed a different native session identity.",
          );
        }
        if (resume.resumePath && typeof state.sessionFile === "string") {
          const stateFile = yield* Effect.try({
            try: () =>
              realRegularFileInside(
                options.sessionRoot,
                state.sessionFile as string,
                "startSession",
              ),
            catch: (cause) =>
              isProviderAdapterValidationError(cause)
                ? cause
                : failValidation("startSession", "Invalid OMP session file.", cause),
          });
          if (stateFile !== resume.resumePath) {
            return yield* failValidation("startSession", "OMP resumed a different session file.");
          }
        }
        if (resume.cursor) {
          yield* runtime
            .request({ type: "get_turns" })
            .pipe(Effect.mapError((error) => mapRuntimeError("get_turns", error)));
        }
        yield* runtime
          .request({ type: "set_subagent_subscription", level: "events" })
          .pipe(Effect.mapError((error) => mapRuntimeError("set_subagent_subscription", error)));

        const startedAt = now();
        const normalizer = makeOmpRuntimeEventNormalizer({
          threadId: input.threadId,
          providerInstanceId: options.instanceId,
          now,
          nextEventId: () => EventId.make(NodeCrypto.randomUUID()),
          planArtifactUrl: (artifactId) => `local://omp-plans/${encodeURIComponent(artifactId)}`,
        });
        const sendTurnLock = yield* Semaphore.make(1);
        const context: OmpSessionContext = {
          scope: sessionScope,
          threadId: input.threadId,
          runtime,
          normalizer,
          sendTurnLock,
          pendingApprovals: new Map(),
          pendingAsks: new Set(),
          pendingPlanReviews: new Set(),
          nativeTurns: [],
          queuedTurnIds: new Set(),
          queuedModelSelections: new Map(),
          cwd,
          modelSelection: undefined,
          stopped: false,
          exitPublished: false,
          session: {
            provider: PROVIDER,
            providerInstanceId: options.instanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
            threadId: input.threadId,
            ...(cursor ? { resumeCursor: cursor } : {}),
            createdAt: startedAt,
            updatedAt: startedAt,
          },
        };
        sessions.set(input.threadId, context);
        sessionScopeTransferred = true;
        // Attach the notification subscription on the session scope (not the
        // short-lived startSession scope) before any publish so session-started
        // / model frames cannot race Stream.fromPubSub start.
        const notificationSub = yield* runtime.subscribeNotifications.pipe(
          Effect.provideService(Scope.Scope, sessionScope),
        );
        context.eventFiber = yield* Stream.runForEach(
          Stream.fromSubscription(notificationSub),
          (frame) =>
            frame.type === "t3_runtime_process_exited"
              ? stopContext(context, { exitFrame: frame, interruptEventFiber: false })
              : publishFrames(context, frame),
        ).pipe(Effect.provideService(Scope.Scope, sessionScope), Effect.forkChild);
        yield* applyModelSelection(context, input.modelSelection);
        yield* publishFrames(context, {
          type: "t3_session_started",
          ...(cursor ? { resumeCursor: cursor } : {}),
        });
        return context.session;
      }).pipe(
        Effect.catchCause((cause) => {
          const context = sessions.get(input.threadId);
          return context
            ? stopContext(context, { emitExitEvent: false }).pipe(
                Effect.andThen(Effect.failCause(cause)),
              )
            : Effect.failCause(cause);
        }),
        Effect.scoped,
      ),

    sendTurn: (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        // Entire admission path under the per-session lock so concurrent idle
        // sends cannot both observe isStreaming:false and open two turns.
        return yield* context.sendTurnLock.withPermit(
          Effect.gen(function* () {
            const state = yield* context.runtime
              .request<OmpStateResponse>({ type: "get_state" })
              .pipe(Effect.mapError((error) => mapRuntimeError("get_state", error)));
            const running = state.isStreaming === true;
            const deliveryMode = input.deliveryMode ?? "steer";
            if (running && deliveryMode === "steer") {
              if (
                input.modelSelection !== undefined &&
                selectionFingerprint(input.modelSelection) !==
                  selectionFingerprint(context.modelSelection)
              ) {
                return yield* failValidation(
                  "sendTurn",
                  "A steering message cannot change model options for the running turn.",
                );
              }
              const activeTurnId = context.session.activeTurnId;
              if (!activeTurnId)
                return yield* failValidation(
                  "sendTurn",
                  "OMP reports a running turn without a T3 turn identity.",
                );
              const images = yield* loadImages({
                attachmentsDir: options.attachmentsDir,
                attachments: input.attachments,
              });
              yield* context.runtime
                .request({
                  type: "steer",
                  message: input.input ?? "",
                  images,
                })
                .pipe(Effect.mapError((error) => mapRuntimeError("steer", error)));
              // Re-ack turn.started so projection settles the steer message's
              // pending turn-start even though the turn is already active.
              yield* publishFrames(context, {
                type: "t3_steer_applied",
                clientTurnId: activeTurnId,
              });
              return {
                threadId: input.threadId,
                turnId: activeTurnId,
                resumeCursor: context.session.resumeCursor,
                queued: false,
              };
            }

            const turnId = TurnId.make(NodeCrypto.randomUUID());
            if (running && deliveryMode === "follow-up") {
              const queuedSelection = input.modelSelection ?? context.modelSelection;
              const turnOptions = nativeTurnOptions(queuedSelection);
              const images = yield* loadImages({
                attachmentsDir: options.attachmentsDir,
                attachments: input.attachments,
              });
              context.queuedTurnIds.add(turnId);
              if (queuedSelection) context.queuedModelSelections.set(turnId, queuedSelection);
              return yield* withExpectedTurn(
                context,
                turnId,
                context.runtime
                  .request({
                    type: "follow_up",
                    clientTurnId: turnId,
                    message: input.input ?? "",
                    images,
                    optionFingerprint: selectionFingerprint(queuedSelection),
                    ...(turnOptions ? { turnOptions } : {}),
                  })
                  .pipe(
                    Effect.mapError((error) => mapRuntimeError("follow_up", error)),
                    Effect.as({
                      threadId: input.threadId,
                      turnId,
                      resumeCursor: context.session.resumeCursor,
                      queued: true,
                    }),
                  ),
              );
            }

            return yield* withExpectedTurn(
              context,
              turnId,
              Effect.gen(function* () {
                if (input.interactionMode !== undefined) {
                  yield* applyInteractionMode(context, {
                    interactionMode: input.interactionMode,
                    ...(input.workflow ? { workflow: input.workflow } : {}),
                  });
                }
                yield* applyModelSelection(context, input.modelSelection);
                const message =
                  input.input ??
                  (input.attachments?.length ? "Please review the attached image(s)." : "");
                const images = yield* loadImages({
                  attachmentsDir: options.attachmentsDir,
                  attachments: input.attachments,
                });
                context.session = {
                  ...context.session,
                  status: "running",
                  activeTurnId: turnId,
                  updatedAt: DateTime.formatIso(yield* DateTime.now),
                };
                yield* context.runtime
                  .request({
                    type: "prompt",
                    clientTurnId: turnId,
                    message,
                    images,
                  })
                  .pipe(Effect.mapError((error) => mapRuntimeError("prompt", error)));
                context.nativeTurns.push(turnId);
                return {
                  threadId: input.threadId,
                  turnId,
                  resumeCursor: context.session.resumeCursor,
                  queued: false,
                };
              }).pipe(
                Effect.onError(() =>
                  Effect.sync(() => {
                    context.session = {
                      ...context.session,
                      status: "ready",
                      activeTurnId: undefined,
                    };
                  }),
                ),
              ),
            );
          }),
        );
      }),

    interruptTurn: (threadId, turnId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        // Concrete turn ids are host-turn clientTurnIds for OMP. A non-active
        // id that is still queued cancels only that follow-up; otherwise abort
        // the active turn (session-level stop).
        if (turnId && turnId !== context.session.activeTurnId) {
          if (!context.queuedTurnIds.has(turnId)) {
            return yield* failValidation(
              "interruptTurn",
              "Requested turn is neither active nor a queued OMP follow-up.",
            );
          }
          yield* context.runtime
            .request({ type: "cancel_follow_up", clientTurnId: turnId })
            .pipe(Effect.mapError((error) => mapRuntimeError("cancel_follow_up", error)));
          context.queuedTurnIds.delete(turnId);
          context.queuedModelSelections.delete(turnId);
          return;
        }
        yield* context.runtime
          .request({ type: "abort" })
          .pipe(Effect.mapError((error) => mapRuntimeError("abort", error)));
      }),

    respondToRequest: (threadId, requestId, decision) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const nativeDecision = approvalDecision(decision);
        const pending = context.pendingApprovals.get(requestId);
        if (!pending)
          throw failValidation("respondToRequest", "OMP approval request is stale or unknown.");
        if (!pending.allowedDecisions.has(nativeDecision)) {
          throw failValidation(
            "respondToRequest",
            `Decision '${decision}' is not allowed for this request.`,
          );
        }
        const nativeId = pending.nativeId;
        const waiter = yield* context.runtime.awaitInteractionResolution("approval", nativeId).pipe(
          Effect.timeout(interactionResolutionTimeout),
          Effect.catchTag("TimeoutError", () =>
            Effect.fail(
              new OmpRpcRuntimeError({
                operation: "interaction",
                detail: `Timed out waiting for approval_resolved after ${interactionResolutionTimeout}.`,
              }),
            ),
          ),
          Effect.mapError((error) => mapRuntimeError("approval_resolved", error)),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        const responseResult = yield* Effect.result(
          context.runtime.notify({
            type: "approval_response",
            id: nativeId,
            decision: nativeDecision,
          }),
        );
        if (responseResult._tag === "Failure" && responseResult.failure.operation !== "process") {
          yield* Fiber.interrupt(waiter);
          return yield* mapRuntimeError("approval_response", responseResult.failure);
        }
        yield* Fiber.join(waiter);
      }),

    respondToUserInput: (threadId, requestId, response) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        if (!context.pendingAsks.has(requestId)) {
          throw failValidation("respondToUserInput", "OMP ask request is stale or unknown.");
        }
        const waiter = yield* context.runtime.awaitInteractionResolution("ask", requestId).pipe(
          Effect.timeout(interactionResolutionTimeout),
          Effect.catchTag("TimeoutError", () =>
            Effect.fail(
              new OmpRpcRuntimeError({
                operation: "interaction",
                detail: `Timed out waiting for extension_ui_resolved after ${interactionResolutionTimeout}.`,
              }),
            ),
          ),
          Effect.mapError((error) => mapRuntimeError("extension_ui_resolved", error)),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        const responseResult = yield* Effect.result(
          context.runtime.notify({
            type: "extension_ui_response",
            id: requestId,
            ...planResponseFrame(response),
          }),
        );
        if (responseResult._tag === "Failure" && responseResult.failure.operation !== "process") {
          yield* Fiber.interrupt(waiter);
          return yield* mapRuntimeError("extension_ui_response", responseResult.failure);
        }
        yield* Fiber.join(waiter);
      }),

    respondToPlanReview: (input: ProviderRespondToPlanReviewInput) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        if (!context.pendingPlanReviews.has(input.requestId)) {
          throw failValidation("respondToPlanReview", "OMP plan review is stale or unknown.");
        }
        const turnId = input.decision.action === "cancel" ? undefined : input.decision.clientTurnId;
        const waiter = yield* context.runtime
          .awaitInteractionResolution("plan_review", input.requestId)
          .pipe(
            Effect.timeout(interactionResolutionTimeout),
            Effect.catchTag("TimeoutError", () =>
              Effect.fail(
                new OmpRpcRuntimeError({
                  operation: "interaction",
                  detail: `Timed out waiting for plan_review_resolved after ${interactionResolutionTimeout}.`,
                }),
              ),
            ),
            Effect.mapError((error) => mapRuntimeError("plan_review_resolved", error)),
            Effect.forkChild,
          );
        yield* Effect.yieldNow;
        if (turnId) context.normalizer.expectTurn(turnId);
        const responseResult = yield* Effect.result(
          context.runtime.request<Record<string, unknown>>({
            type: "respond_to_plan_review",
            requestId: input.requestId,
            decision: input.decision,
          }),
        );
        if (responseResult._tag === "Failure") {
          if (turnId) context.normalizer.cancelExpectedTurn(turnId);
          if (responseResult.failure.operation !== "process") {
            yield* Fiber.interrupt(waiter);
            return yield* mapRuntimeError("respond_to_plan_review", responseResult.failure);
          }
          yield* Fiber.join(waiter);
          return undefined;
        }
        const resolution = yield* Fiber.join(waiter).pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              if (turnId) context.normalizer.cancelExpectedTurn(turnId);
            }),
          ),
        );
        const isPromotingOutcome =
          resolution.outcome === "executing" || resolution.outcome === "refining";
        if (!turnId || !isPromotingOutcome) {
          if (turnId) context.normalizer.cancelExpectedTurn(turnId);
          return undefined;
        }
        const state = yield* context.runtime.request<OmpStateResponse>({ type: "get_state" }).pipe(
          Effect.mapError((error) => mapRuntimeError("get_state", error)),
          Effect.onError(() => Effect.sync(() => context.normalizer.cancelExpectedTurn(turnId))),
        );
        if (state.isStreaming !== true) {
          context.normalizer.cancelExpectedTurn(turnId);
          return undefined;
        }
        context.nativeTurns.push(turnId);
        // Soft: plan-review promotion must not defect when sessionFile is absent.
        const resumeCursor = softCursorFromState(options.sessionRoot, state);
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          ...(resumeCursor ? { resumeCursor } : {}),
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        };
        return {
          threadId: input.threadId,
          turnId,
          ...(resumeCursor !== undefined ? { resumeCursor } : {}),
        };
      }),

    setInteractionMode: (input: ProviderSetInteractionModeInput) =>
      requireSession(input.threadId).pipe(
        Effect.flatMap((context) => applyInteractionMode(context, input)),
      ),

    stopSession: (threadId) => requireSession(threadId).pipe(Effect.flatMap(stopContext)),
    listSessions: () =>
      Effect.sync(() => Array.from(sessions.values(), (context) => context.session)),
    hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
    readThread,
    rollbackThread: (threadId, count) =>
      Effect.gen(function* () {
        if (!Number.isInteger(count) || count < 0) {
          throw failValidation("rollbackThread", "Rollback count must be a non-negative integer.");
        }
        const current = yield* readThread(threadId);
        if (count === 0) return current;
        if (count > current.turns.length) {
          throw failValidation(
            "rollbackThread",
            "Rollback count exceeds the native host-turn history.",
          );
        }
        const context = yield* requireSession(threadId);
        if (context.session.activeTurnId) {
          throw failValidation("rollbackThread", "OMP rollback is only valid while idle.");
        }
        const expectedClientTurnIds = current.turns.slice(-count).map((turn) => turn.id);
        yield* context.runtime
          .request({ type: "rollback_turns", count, expectedClientTurnIds })
          .pipe(Effect.mapError((error) => mapRuntimeError("rollback_turns", error)));
        return yield* readThread(threadId);
      }),
    stopAll: () =>
      Effect.forEach(Array.from(sessions.values()), (context) => stopContext(context), {
        concurrency: "unbounded",
        discard: true,
      }),
    streamEvents: Stream.fromPubSub(runtimeEvents),
  };

  return adapter;
});
