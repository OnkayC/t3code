import {
  EventId,
  ProviderDriverKind,
  ProviderItemId,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ThreadId,
} from "@t3tools/contracts";

import {
  boundOmpActivityString,
  boundOmpActivityValue,
  redactOmpRpcPayload,
  type OmpRpcFrame,
} from "./OmpRpcProtocol.ts";

const OMP_DRIVER_KIND = ProviderDriverKind.make("omp");

type OmpToolItemType =
  | "command_execution"
  | "file_change"
  | "mcp_tool_call"
  | "dynamic_tool_call"
  | "collab_agent_tool_call"
  | "web_search"
  | "image_view";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Projection pending-approvals PK is global — scope native OMP ids by thread. */
export function scopedOmpApprovalRequestId(threadId: ThreadId, nativeId: string): string {
  return `${threadId}:${nativeId}`;
}

export interface OmpRuntimeEventNormalizerOptions {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly now: () => string;
  readonly nextEventId: () => EventId;
  readonly planArtifactUrl: (artifactId: string) => string;
}

export interface OmpRuntimeEventNormalizer {
  readonly expectTurn: (turnId: TurnId) => void;
  readonly cancelExpectedTurn: (turnId: TurnId) => void;
  readonly map: (frame: OmpRpcFrame) => ReadonlyArray<ProviderRuntimeEvent>;
}

interface OmpRuntimeEventState {
  activeTurnId: TurnId | undefined;
  activeMessageItemId: RuntimeItemId | undefined;
  activeMessageNativeId: string | undefined;
  readonly expectedTurns: Array<TurnId>;
  readonly nativeItemIds: Map<string, RuntimeItemId>;
  readonly nativeToolArgs: Map<string, unknown>;
  nextSyntheticItemId: number;
}

export function makeOmpRuntimeEventNormalizer(
  options: OmpRuntimeEventNormalizerOptions,
): OmpRuntimeEventNormalizer {
  const state: OmpRuntimeEventState = {
    activeMessageItemId: undefined,
    activeMessageNativeId: undefined,
    activeTurnId: undefined,
    expectedTurns: [],
    nativeItemIds: new Map(),
    nativeToolArgs: new Map(),
    nextSyntheticItemId: 0,
  };

  return {
    expectTurn: (turnId) => {
      state.expectedTurns.push(turnId);
    },
    cancelExpectedTurn: (turnId) => {
      const index = state.expectedTurns.indexOf(turnId);
      if (index >= 0) state.expectedTurns.splice(index, 1);
    },
    map: (frame) => normalizeOmpRpcFrame(options, state, frame),
  };
}

export function normalizeOmpRpcFrame(
  options: OmpRuntimeEventNormalizerOptions,
  state: OmpRuntimeEventState,
  frame: OmpRpcFrame,
): ReadonlyArray<ProviderRuntimeEvent> {
  const raw = {
    source: "omp.rpc" as const,
    method: frame.type,
    payload: boundOmpActivityValue(frame),
  };
  const base = {
    eventId: options.nextEventId(),
    provider: OMP_DRIVER_KIND,
    providerInstanceId: options.providerInstanceId,
    threadId: options.threadId,
    createdAt: options.now(),
    ...(state.activeTurnId ? { turnId: state.activeTurnId } : {}),
    raw,
  };

  switch (frame.type) {
    case "t3_session_started":
      return [
        {
          ...base,
          type: "session.started",
          payload: frame.resumeCursor !== undefined ? { resume: frame.resumeCursor } : {},
        } as ProviderRuntimeEvent,
      ];
    case "agent_start": {
      const explicitTurnId = readTurnId(frame.clientTurnId);
      if (explicitTurnId) {
        const expectedIndex = state.expectedTurns.indexOf(explicitTurnId);
        if (expectedIndex >= 0) state.expectedTurns.splice(expectedIndex, 1);
        if (explicitTurnId === state.activeTurnId) return [];
      }
      const turnId = explicitTurnId ?? state.expectedTurns.shift() ?? state.activeTurnId;
      if (!turnId) return [];
      state.activeTurnId = turnId;
      return [
        {
          ...base,
          turnId,
          type: "turn.started",
          payload: {
            ...(typeof frame.model === "string" ? { model: frame.model } : {}),
            ...(typeof frame.thinkingLevel === "string" ? { effort: frame.thinkingLevel } : {}),
          },
        } as ProviderRuntimeEvent,
      ];
    }
    // Explicit re-ack after steer so projection can settle a pending turn-start
    // row even when the turn is already active (agent_start would no-op).
    case "t3_steer_applied": {
      const turnId = readTurnId(frame.clientTurnId) ?? state.activeTurnId;
      if (!turnId) return [];
      state.activeTurnId = turnId;
      return [
        {
          ...base,
          turnId,
          type: "turn.started",
          payload: {},
        } as ProviderRuntimeEvent,
      ];
    }
    case "host_turn_promoted": {
      const turnId = readTurnId(frame.clientTurnId);
      if (!turnId) return [];
      state.activeTurnId = turnId;
      const expectedIndex = state.expectedTurns.indexOf(turnId);
      if (expectedIndex >= 0) state.expectedTurns.splice(expectedIndex, 1);
      return [
        {
          ...base,
          turnId,
          type: "turn.started",
          payload: {
            ...(typeof frame.model === "string" ? { model: frame.model } : {}),
            ...(typeof frame.thinkingLevel === "string" ? { effort: frame.thinkingLevel } : {}),
          },
        } as ProviderRuntimeEvent,
      ];
    }
    case "follow_up_queued": {
      const turnId = readTurnId(frame.clientTurnId);
      if (!turnId) return [];
      return [
        {
          ...base,
          turnId,
          type: "turn.queued",
          payload: {
            deliveryMode: "follow-up",
            optionFingerprint:
              typeof frame.optionFingerprint === "string"
                ? frame.optionFingerprint
                : `omp:${turnId}`,
            queuePosition:
              typeof frame.queuePosition === "number" && frame.queuePosition > 0
                ? Math.floor(frame.queuePosition)
                : 1,
          },
        } as ProviderRuntimeEvent,
      ];
    }
    case "host_turn_cancelled": {
      const turnId = readTurnId(frame.clientTurnId);
      if (!turnId) return [];
      const expectedIndex = state.expectedTurns.indexOf(turnId);
      if (expectedIndex >= 0) state.expectedTurns.splice(expectedIndex, 1);
      if (state.activeTurnId === turnId) state.activeTurnId = undefined;
      return [
        {
          ...base,
          turnId,
          type: "turn.aborted",
          payload: {
            reason:
              readString(frame.reason) ?? "OMP queued follow-up was cancelled before promotion.",
          },
        } as ProviderRuntimeEvent,
      ];
    }
    case "agent_end": {
      const turnId = readTurnId(frame.clientTurnId) ?? state.activeTurnId;
      if (!turnId) return [];
      const aborted = frame.aborted === true;
      state.activeMessageItemId = undefined;
      state.activeMessageNativeId = undefined;
      state.nativeToolArgs.clear();
      state.nativeItemIds.clear();
      state.activeTurnId = undefined;
      return [
        aborted
          ? ({
              ...base,
              turnId,
              type: "turn.aborted",
              payload: { reason: "OMP turn was aborted." },
            } as ProviderRuntimeEvent)
          : ({
              ...base,
              turnId,
              type: "turn.completed",
              payload: {
                state: "completed",
                ...(frame.telemetry !== undefined ? { usage: frame.telemetry } : {}),
              },
            } as ProviderRuntimeEvent),
      ];
    }
    case "message_start": {
      const message = readNestedRecord(frame.message);
      const nativeId = readString(message?.id);
      const itemKey = nativeId ?? `${options.threadId}:message-${++state.nextSyntheticItemId}`;
      const itemId = RuntimeItemId.make(`omp-${itemKey}`);
      if (nativeId) state.nativeItemIds.set(nativeId, itemId);
      state.activeMessageItemId = itemId;
      state.activeMessageNativeId = nativeId;
      return [
        {
          ...base,
          itemId,
          ...(nativeId ? { providerRefs: { providerItemId: nativeId } } : {}),
          type: "item.started",
          payload: {
            itemType:
              message?.role === "assistant"
                ? "assistant_message"
                : message?.role === "user"
                  ? "user_message"
                  : "unknown",
            status: "inProgress",
          },
        } as ProviderRuntimeEvent,
      ];
    }
    case "message_update": {
      const message = readNestedRecord(frame.message);
      const event = readNestedRecord(frame.assistantMessageEvent);
      const nativeId = readString(message?.id);
      const providerNativeId = nativeId ?? state.activeMessageNativeId;
      const itemId = nativeId ? state.nativeItemIds.get(nativeId) : state.activeMessageItemId;
      const delta = readString(event?.delta);
      const eventType = readString(event?.type);
      const streamKind =
        eventType === "text_delta"
          ? "assistant_text"
          : eventType === "thinking_delta"
            ? "reasoning_text"
            : undefined;
      if (!itemId || delta === undefined || streamKind === undefined) return [];
      return [
        {
          ...base,
          itemId,
          ...(providerNativeId ? { providerRefs: { providerItemId: providerNativeId } } : {}),
          type: "content.delta",
          payload: {
            streamKind,
            delta,
            ...(typeof event?.contentIndex === "number"
              ? { contentIndex: event.contentIndex }
              : {}),
          },
        } as ProviderRuntimeEvent,
      ];
    }
    case "message_end": {
      const message = readNestedRecord(frame.message);
      const nativeId = readString(message?.id);
      const providerNativeId = nativeId ?? state.activeMessageNativeId;
      const itemId = nativeId ? state.nativeItemIds.get(nativeId) : state.activeMessageItemId;
      if (providerNativeId) state.nativeItemIds.delete(providerNativeId);
      if (!itemId) return [];
      if (itemId === state.activeMessageItemId) {
        state.activeMessageItemId = undefined;
        state.activeMessageNativeId = undefined;
      }
      return [
        {
          ...base,
          itemId,
          ...(providerNativeId ? { providerRefs: { providerItemId: providerNativeId } } : {}),
          type: "item.completed",
          payload: {
            itemType:
              message?.role === "assistant"
                ? "assistant_message"
                : message?.role === "user"
                  ? "user_message"
                  : "unknown",
            status: "completed",
          },
        } as ProviderRuntimeEvent,
      ];
    }
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end": {
      const nativeId = readString(frame.toolCallId);
      const toolName = readString(frame.toolName);
      if (!nativeId || !toolName) return [];
      const itemId = state.nativeItemIds.get(nativeId) ?? RuntimeItemId.make(`omp-${nativeId}`);
      state.nativeItemIds.set(nativeId, itemId);
      if (frame.args !== undefined) {
        state.nativeToolArgs.set(nativeId, frame.args);
      }
      const args = frame.args ?? state.nativeToolArgs.get(nativeId);
      const phase =
        frame.type === "tool_execution_start"
          ? "item.started"
          : frame.type === "tool_execution_update"
            ? "item.updated"
            : "item.completed";
      const isError = frame.isError === true;
      const itemType = classifyTool(toolName);
      const data = normalizeToolData({
        nativeId,
        toolName,
        itemType,
        ...(args !== undefined ? { args } : {}),
        ...(frame.intent !== undefined ? { intent: frame.intent } : {}),
        ...(frame.partialResult !== undefined ? { result: frame.partialResult } : {}),
        ...(frame.result !== undefined ? { result: frame.result } : {}),
      });
      if (frame.type === "tool_execution_end") {
        state.nativeItemIds.delete(nativeId);
        state.nativeToolArgs.delete(nativeId);
      }
      return [
        {
          ...base,
          itemId,
          providerRefs: { providerItemId: nativeId },
          type: phase,
          payload: {
            itemType,
            status:
              frame.type === "tool_execution_end"
                ? isError
                  ? "failed"
                  : "completed"
                : "inProgress",
            title: toolName,
            data,
          },
        } as ProviderRuntimeEvent,
      ];
    }
    case "approval_request": {
      const nativeId = readString(frame.id);
      if (!nativeId) return [];
      // Projection pending-approvals PK is global on request_id — scope by thread.
      const requestId = scopedOmpApprovalRequestId(options.threadId, nativeId);
      return [
        {
          ...base,
          requestId: RuntimeRequestId.make(requestId),
          providerRefs: {
            // Native id for respond mapping; canonical requestId is thread-scoped.
            providerRequestId: nativeId,
            ...(typeof frame.toolCallId === "string"
              ? { providerItemId: ProviderItemId.make(frame.toolCallId) }
              : {}),
          },
          type: "request.opened",
          payload: {
            requestType: "tool_approval",
            ...(typeof frame.toolName === "string" ? { toolName: frame.toolName } : {}),
            ...(typeof frame.approvalMode === "string" ? { approvalMode: frame.approvalMode } : {}),
            ...(typeof frame.tier === "string" ? { tier: frame.tier } : {}),
            // Bound like tool args so multi-MiB approval payloads cannot
            // inflate activity snapshots after redaction.
            ...(frame.arguments !== undefined
              ? { args: boundOmpActivityValue(frame.arguments) }
              : {}),
            ...(typeof frame.reason === "string" ? { reason: frame.reason } : {}),
            details: readStringArray(frame.details),
            providerSafetyChecks: readStringArray(frame.providerSafetyChecks),
            allowedDecisions: readStringArray(frame.allowedDecisions).flatMap((decision) => {
              const mapped = mapApprovalDecision(decision);
              return mapped ? [mapped] : [];
            }),
          },
        } as ProviderRuntimeEvent,
      ];
    }
    case "approval_resolved": {
      const nativeId = readString(frame.id);
      if (!nativeId) return [];
      const requestId = scopedOmpApprovalRequestId(options.threadId, nativeId);
      const decision =
        typeof frame.decision === "string" ? mapApprovalDecision(frame.decision) : undefined;
      return [
        {
          ...base,
          requestId: RuntimeRequestId.make(requestId),
          providerRefs: { providerRequestId: nativeId },
          type: "request.resolved",
          payload: {
            requestType: "tool_approval",
            outcome: frame.outcome,
            ...(decision ? { decision } : {}),
          },
        } as ProviderRuntimeEvent,
      ];
    }
    case "extension_ui_request": {
      if (frame.method !== "ask") return [];
      const id = readString(frame.id);
      if (!id || !Array.isArray(frame.questions)) return [];
      const questions = frame.questions.flatMap((questionValue) => {
        const question = isObject(questionValue) ? questionValue : undefined;
        if (!question) return [];
        const questionId = readString(question.id);
        const questionText = readString(question.question);
        if (!questionId || !questionText) return [];
        const header = readString(question.header);
        const multiSelect = question.multi === true;
        const recommended =
          typeof question.recommended === "number" ? question.recommended : undefined;
        const allowCustom =
          typeof question.allowCustom === "boolean" ? question.allowCustom : undefined;
        const options = Array.isArray(question.options)
          ? question.options.flatMap((optionValue: unknown) => {
              const option = isObject(optionValue) ? optionValue : undefined;
              if (!option) return [];
              const label = readString(option.label);
              const description = readString(option.description);
              const preview = readString(option.preview);
              return label
                ? [
                    {
                      label,
                      ...(description ? { description } : {}),
                      ...(preview ? { preview } : {}),
                    },
                  ]
                : [];
            })
          : [];
        return [
          {
            id: questionId,
            question: questionText,
            ...(header ? { header } : {}),
            options,
            multiSelect,
            ...(recommended !== undefined ? { recommended } : {}),
            ...(allowCustom !== undefined ? { allowCustom } : {}),
          },
        ];
      });
      return [
        {
          ...base,
          requestId: RuntimeRequestId.make(id),
          providerRefs: { providerRequestId: id },
          type: "user-input.requested",
          payload: {
            questions,
            allowedActions: ["submit", "chat", "cancel"],
            ...(typeof frame.timeout === "number" ? { timeout: frame.timeout } : {}),
          },
        } as ProviderRuntimeEvent,
      ];
    }
    case "extension_ui_resolved": {
      if (frame.method !== "ask") return [];
      const id = readString(frame.id);
      if (!id) return [];
      const result = readNestedRecord(frame.result);
      const results = Array.isArray(result?.results) ? result.results : [];
      const answers = Object.fromEntries(
        results.flatMap((resultValue) => {
          const item = readNestedRecord(resultValue);
          const questionId = readString(item?.id);
          if (!questionId) return [];
          return [
            [
              questionId,
              {
                selectedOptions: readStringArray(item?.selectedOptions),
                ...(typeof item?.customInput === "string" ? { customInput: item.customInput } : {}),
                ...(typeof item?.note === "string" ? { note: item.note } : {}),
              },
            ],
          ];
        }),
      );
      return [
        {
          ...base,
          requestId: RuntimeRequestId.make(id),
          providerRefs: { providerRequestId: id },
          type: "user-input.resolved",
          payload: {
            outcome: frame.outcome,
            ...(Object.keys(answers).length > 0 ? { answers } : {}),
          },
        } as ProviderRuntimeEvent,
      ];
    }
    case "plan_review_request": {
      const id = readString(frame.id) ?? readString(frame.requestId);
      const title = readString(frame.title);
      const markdown = readString(frame.markdown) ?? readString(frame.planMarkdown);
      if (!id || !title || !markdown) return [];
      const artifactId =
        readString(frame.planArtifactId) ?? `omp-plan-${id.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}`;
      const parseModel = (raw: unknown) => {
        if (!isObject(raw)) return undefined;
        const provider = readString(raw.provider);
        const modelId = readString(raw.modelId);
        if (!provider || !modelId) return undefined;
        const thinkingLevel = readString(raw.thinkingLevel);
        return { provider, modelId, ...(thinkingLevel ? { thinkingLevel } : {}) };
      };
      const executionModels = Array.isArray(frame.executionModels)
        ? frame.executionModels.flatMap((raw) => {
            const parsed = parseModel(raw);
            return parsed ? [parsed] : [];
          })
        : [];
      const defaultExecutionModel = parseModel(frame.defaultExecutionModel);
      return [
        {
          ...base,
          requestId: RuntimeRequestId.make(id),
          providerRefs: { providerRequestId: id },
          type: "plan.review.requested",
          payload: {
            title,
            planArtifactId: artifactId,
            planArtifactUrl: options.planArtifactUrl(artifactId),
            // Full plan lives at planArtifactUrl; keep only a bounded preview in
            // the activity so multi-MiB plans cannot inflate snapshots. Must stay
            // a string for PlanReviewRequestedPayload / derivePendingPlanReview.
            planMarkdown: boundOmpActivityString(markdown),
            allowedContextStrategies: readStringArray(frame.allowedContextStrategies),
            ...(frame.contextUsage !== undefined ? { contextUsage: frame.contextUsage } : {}),
            executionModels,
            ...(defaultExecutionModel ? { defaultExecutionModel } : {}),
          },
        } as ProviderRuntimeEvent,
      ];
    }
    case "plan_review_resolved": {
      const id = readString(frame.id);
      if (!id) return [];
      return [
        {
          ...base,
          requestId: RuntimeRequestId.make(id),
          providerRefs: { providerRequestId: id },
          type: "plan.review.resolved",
          payload: {
            outcome: frame.outcome,
            ...(frame.decision !== undefined ? { decision: frame.decision } : {}),
            ...(readTurnId(frame.clientTurnId)
              ? { clientTurnId: readTurnId(frame.clientTurnId) }
              : {}),
            ...(frame.resume !== undefined ? { resume: frame.resume } : {}),
            ...(typeof frame.planDigest === "string" ? { planDigest: frame.planDigest } : {}),
          },
        } as ProviderRuntimeEvent,
      ];
    }
    case "t3_runtime_interaction_resolved": {
      const id = readString(frame.id);
      if (!id) return [];
      if (frame.interactionType === "approval") {
        // stopContext may already pass a thread-scoped id; process-exit waiters
        // use the native id — normalize both to the projection key.
        const requestId = id.startsWith(`${options.threadId}:`)
          ? id
          : scopedOmpApprovalRequestId(options.threadId, id);
        return [
          {
            ...base,
            requestId: RuntimeRequestId.make(requestId),
            type: "request.resolved",
            payload: { requestType: "tool_approval", outcome: frame.outcome },
          } as ProviderRuntimeEvent,
        ];
      }
      if (frame.interactionType === "ask") {
        return [
          {
            ...base,
            requestId: RuntimeRequestId.make(id),
            type: "user-input.resolved",
            payload: { outcome: frame.outcome },
          } as ProviderRuntimeEvent,
        ];
      }
      return [
        {
          ...base,
          requestId: RuntimeRequestId.make(id),
          type: "plan.review.resolved",
          payload: { outcome: frame.outcome },
        } as ProviderRuntimeEvent,
      ];
    }
    case "subagent_lifecycle":
    case "subagent_progress":
    case "subagent_event": {
      const payload = readNestedRecord(frame.payload);
      const progress = readNestedRecord(payload?.progress);
      const childEvent = readNestedRecord(payload?.event);
      const nativeId =
        readString(payload?.id) ?? readString(payload?.subagentId) ?? readString(progress?.id);
      if (!nativeId) return [];
      const taskId = RuntimeTaskId.make(`omp-${nativeId}`);
      const status = readString(payload?.status) ?? readString(progress?.status);
      const description =
        readString(payload?.description) ??
        readString(progress?.description) ??
        readString(payload?.task) ??
        readString(payload?.assignment);
      const linkage = {
        taskId,
        taskType: "subagent",
        agentKind: "agent" as const,
        agentId: nativeId,
        ...(typeof payload?.agent === "string" ? { role: payload.agent } : {}),
        ...(description ? { title: description } : {}),
        ...(typeof payload?.parentToolCallId === "string"
          ? { toolUseId: payload.parentToolCallId }
          : {}),
      };
      if (
        frame.type === "subagent_lifecycle" &&
        (status === "completed" || status === "failed" || status === "aborted")
      ) {
        return [
          {
            ...base,
            type: "task.completed",
            payload: {
              ...linkage,
              status:
                status === "completed" ? "completed" : status === "failed" ? "failed" : "stopped",
              ...(typeof payload?.summary === "string" ? { summary: payload.summary } : {}),
              ...(payload?.usage !== undefined ? { usage: payload.usage } : {}),
            },
          } as ProviderRuntimeEvent,
        ];
      }
      if (frame.type === "subagent_progress" || frame.type === "subagent_event") {
        return [
          {
            ...base,
            type: "task.progress",
            payload: {
              ...linkage,
              description:
                description ??
                (readString(childEvent?.type)
                  ? `OMP subagent event: ${readString(childEvent?.type)}`
                  : "OMP subagent progress"),
              ...(typeof progress?.summary === "string" ? { summary: progress.summary } : {}),
              ...(progress?.usage !== undefined ? { usage: progress.usage } : {}),
              ...(typeof progress?.lastToolName === "string"
                ? { lastToolName: progress.lastToolName }
                : {}),
            },
          } as ProviderRuntimeEvent,
        ];
      }
      return [
        {
          ...base,
          type: "task.started",
          payload: {
            ...linkage,
            ...(description ? { description } : {}),
          },
        } as ProviderRuntimeEvent,
      ];
    }
    case "todo_reminder": {
      const todos = Array.isArray(frame.todos) ? frame.todos : [];
      return [
        {
          ...base,
          type: "turn.plan.updated",
          payload: {
            plan: todos.flatMap((value) => {
              const todo = readNestedRecord(value);
              const step = readString(todo?.content);
              if (!step) return [];
              const status =
                todo?.status === "in_progress"
                  ? "inProgress"
                  : todo?.status === "completed" || todo?.status === "abandoned"
                    ? "completed"
                    : "pending";
              return [{ step, status }];
            }),
          },
        } as ProviderRuntimeEvent,
      ];
    }
    case "todo_auto_clear":
      return [
        {
          ...base,
          type: "turn.plan.updated",
          payload: { plan: [] },
        } as ProviderRuntimeEvent,
      ];
    case "auto_compaction_start": {
      const itemId = RuntimeItemId.make(`omp-compaction-${++state.nextSyntheticItemId}`);
      state.nativeItemIds.set("active-compaction", itemId);
      return [
        {
          ...base,
          itemId,
          type: "item.started",
          payload: {
            itemType: "context_compaction",
            status: "inProgress",
            detail: typeof frame.reason === "string" ? frame.reason : undefined,
          },
        } as ProviderRuntimeEvent,
      ];
    }
    case "auto_compaction_end": {
      const itemId = state.nativeItemIds.get("active-compaction");
      state.nativeItemIds.delete("active-compaction");
      if (!itemId) return [];
      const result =
        frame.result !== undefined
          ? boundOmpActivityValue(redactOmpRpcPayload(frame.result))
          : undefined;
      return [
        {
          ...base,
          itemId,
          type: "item.completed",
          payload: {
            itemType: "context_compaction",
            status: frame.aborted === true ? "failed" : "completed",
            ...(result !== undefined ? { data: result } : {}),
          },
        } as ProviderRuntimeEvent,
      ];
    }
    case "notice":
      return [
        {
          ...base,
          type: frame.level === "error" ? "runtime.error" : "runtime.warning",
          payload:
            frame.level === "error"
              ? { message: readString(frame.message) ?? "OMP error", class: "provider_error" }
              : { message: readString(frame.message) ?? "OMP warning", detail: frame.source },
        } as ProviderRuntimeEvent,
      ];
    case "t3_runtime_error":
      return [
        {
          ...base,
          type: "runtime.error",
          payload: {
            message: readString(frame.error) ?? "OMP RPC transport error",
            class: "transport_error",
            detail: redactOmpRpcPayload(frame),
          },
        } as ProviderRuntimeEvent,
      ];
    case "t3_runtime_process_exited": {
      const pendingTurnIds = Array.from(
        new Set([...(state.activeTurnId ? [state.activeTurnId] : []), ...state.expectedTurns]),
      );
      state.activeMessageItemId = undefined;
      state.activeMessageNativeId = undefined;
      state.nativeItemIds.clear();
      state.nativeToolArgs.clear();
      state.activeTurnId = undefined;
      state.expectedTurns.splice(0, state.expectedTurns.length);
      return [
        ...pendingTurnIds.map(
          (turnId) =>
            ({
              ...base,
              // Each projected abort is keyed by eventId/activity_id; reuse would
              // collapse multiple cancelled turns into a single activity row.
              eventId: options.nextEventId(),
              turnId,
              type: "turn.aborted",
              payload: {
                reason:
                  frame.outcome === "aborted"
                    ? "OMP session stopped."
                    : "OMP process exited before the turn settled.",
              },
            }) as ProviderRuntimeEvent,
        ),
        {
          ...base,
          eventId: options.nextEventId(),
          type: "session.exited",
          payload: {
            reason:
              frame.outcome === "aborted"
                ? "OMP session stopped."
                : "OMP process exited unexpectedly.",
            recoverable: frame.outcome !== "aborted",
            exitKind: frame.outcome === "aborted" ? "graceful" : "error",
          },
        } as ProviderRuntimeEvent,
      ];
    }
    case "plan_mode_changed": {
      const interactionMode = mapPlanModeStatus(frame.status);
      const workflow =
        frame.workflow === "parallel" || frame.workflow === "iterative"
          ? frame.workflow
          : undefined;
      return [
        {
          ...base,
          type: "session.configured",
          payload: {
            config: redactOmpRpcPayload(frame) as Record<string, unknown>,
            ...(frame.resumeCursor !== undefined ? { resumeCursor: frame.resumeCursor } : {}),
            ...(interactionMode !== undefined ? { interactionMode } : {}),
            ...(workflow !== undefined ? { workflow } : {}),
          },
        } as ProviderRuntimeEvent,
      ];
    }
    case "model_changed":
    case "thinking_level_changed": {
      const modelSelection = modelSelectionFromOmpFrame(frame, options.providerInstanceId);
      return [
        {
          ...base,
          type: "session.configured",
          payload: {
            config: redactOmpRpcPayload(frame) as Record<string, unknown>,
            ...(frame.resumeCursor !== undefined ? { resumeCursor: frame.resumeCursor } : {}),
            ...(modelSelection !== undefined ? { modelSelection } : {}),
          },
        } as ProviderRuntimeEvent,
      ];
    }
    case "session_changed":
      return [
        {
          ...base,
          type: "session.configured",
          payload: {
            config: redactOmpRpcPayload(frame) as Record<string, unknown>,
            ...(frame.resumeCursor !== undefined ? { resumeCursor: frame.resumeCursor } : {}),
          },
        } as ProviderRuntimeEvent,
      ];
    default:
      return [];
  }
}

/**
 * Build a ModelSelection from an OMP model/thinking frame. Frames may carry a
 * prebuilt modelSelection (adapter enrichment), a string model slug, or
 * provider/modelId parts. Bare thinking maps under OMP's advertised `reasoning`
 * option id so the thread picker stays aligned with provider descriptors.
 */
function modelSelectionFromOmpFrame(
  frame: OmpRpcFrame,
  providerInstanceId: ProviderInstanceId,
):
  | {
      readonly instanceId: ProviderInstanceId;
      readonly model: string;
      readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
    }
  | undefined {
  const embedded = frame.modelSelection;
  if (isObject(embedded) && typeof embedded.model === "string" && embedded.model.length > 0) {
    // Adapter enrichment already merged thinking under the advertised option
    // id and retained unrelated options (e.g. fastMode) — pass through as-is.
    const options = Array.isArray(embedded.options)
      ? embedded.options.filter(
          (option): option is { readonly id: string; readonly value: string | boolean } =>
            isObject(option) &&
            typeof option.id === "string" &&
            (typeof option.value === "string" || typeof option.value === "boolean"),
        )
      : undefined;
    return {
      instanceId: providerInstanceId,
      model: embedded.model,
      ...(options && options.length > 0 ? { options } : {}),
    };
  }

  const modelFromString = typeof frame.model === "string" ? frame.model : undefined;
  const modelFromParts = (() => {
    if (isObject(frame.model)) {
      const id = readString(frame.model.id) ?? readString(frame.model.modelId);
      const provider = readString(frame.model.provider);
      if (id) return provider ? `${provider}/${id}` : id;
    }
    const modelId = readString(frame.modelId);
    const provider = readString(frame.provider);
    if (modelId) return provider ? `${provider}/${modelId}` : modelId;
    return undefined;
  })();
  const model = modelFromString ?? modelFromParts;
  const thinkingLevel =
    typeof frame.thinkingLevel === "string" && frame.thinkingLevel.length > 0
      ? frame.thinkingLevel
      : undefined;
  if (!model && !thinkingLevel) return undefined;
  if (!model) return undefined;
  return {
    instanceId: providerInstanceId,
    model,
    ...(thinkingLevel !== undefined
      ? { options: [{ id: "reasoning", value: thinkingLevel }] as const }
      : {}),
  };
}

function readNestedRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readStringArray(value: unknown): ReadonlyArray<string> {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function mapPlanModeStatus(value: unknown): "default" | "plan" | "plan-paused" | undefined {
  switch (value) {
    case "off":
      return "default";
    case "active":
      return "plan";
    case "paused":
      return "plan-paused";
    default:
      return undefined;
  }
}

function normalizeToolData(input: {
  readonly nativeId: string;
  readonly toolName: string;
  readonly itemType: OmpToolItemType;
  readonly args?: unknown;
  readonly intent?: unknown;
  readonly result?: unknown;
}): Record<string, unknown> {
  // Redact then bound every persisted tool payload. Args (patches/heredocs)
  // and results both go through the same secret-safe bounder so multi-MiB
  // inputs and secret-keyed result tails cannot inflate snapshots.
  const redactedArgs = input.args !== undefined ? redactOmpRpcPayload(input.args) : undefined;
  const argsRecord = readNestedRecord(redactedArgs);
  // Command summaries are also persisted at the top level and under item.command
  // for UI convenience — bound them the same way as item.input so multi-MiB
  // heredocs cannot bypass the activity payload cap via a duplicated field.
  const command =
    input.itemType === "command_execution" && argsRecord?.command !== undefined
      ? boundOmpActivityValue(argsRecord.command)
      : undefined;
  const boundedArgs = redactedArgs !== undefined ? boundOmpActivityValue(redactedArgs) : undefined;
  const boundedResult =
    input.result !== undefined ? boundOmpActivityValue(input.result) : undefined;
  return {
    toolCallId: input.nativeId,
    toolName: input.toolName,
    ...(command !== undefined ? { command } : {}),
    ...(input.intent !== undefined
      ? { intent: boundOmpActivityValue(redactOmpRpcPayload(input.intent)) }
      : {}),
    item: {
      ...(command !== undefined ? { command } : {}),
      ...(boundedArgs !== undefined ? { input: boundedArgs } : {}),
      ...(boundedResult !== undefined ? { result: boundedResult } : {}),
    },
  };
}

function readTurnId(value: unknown): TurnId | undefined {
  return typeof value === "string" && value.length > 0 ? TurnId.make(value) : undefined;
}

function mapApprovalDecision(value: string): ProviderApprovalDecision | undefined {
  switch (value) {
    case "approve_once":
      return "accept";
    case "approve_session":
      return "acceptForSession";
    case "deny":
      return "decline";
    case "cancel":
      return "cancel";
    default:
      return undefined;
  }
}

function classifyTool(toolName: string): OmpToolItemType {
  const normalized = toolName.toLowerCase();
  if (normalized === "bash" || normalized === "exec" || normalized.includes("command")) {
    return "command_execution";
  }
  if (["write", "edit", "patch", "apply_patch"].some((name) => normalized.includes(name))) {
    return "file_change";
  }
  if (normalized.startsWith("mcp") || normalized.includes("_mcp_")) return "mcp_tool_call";
  if (normalized.includes("subagent") || normalized === "task" || normalized === "agent") {
    return "collab_agent_tool_call";
  }
  if (normalized.includes("web_search") || normalized === "search_web") return "web_search";
  if (normalized.includes("image") || normalized === "view") return "image_view";
  return "dynamic_tool_call";
}
