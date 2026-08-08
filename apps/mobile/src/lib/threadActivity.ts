import {
  ApprovalRequestId,
  isToolLifecycleItemType,
  ProviderApprovalOption,
  ProviderRequestKind,
  type OrchestrationLatestTurn,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type PlanReviewRequestedPayload,
  type ProviderApprovalDecision,
  type ProviderPlanExecutionModel,
  type ProviderPlanReviewContextStrategy,
  type ProviderUserInputAction,
  type ProviderUserInputAnswer,
  type ToolLifecycleItemType,
  type TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";

import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";

export interface PendingApproval {
  readonly requestId: ApprovalRequestId;
  readonly requestKind: ProviderRequestKind | "tool";
  readonly createdAt: string;
  readonly detail?: string;
  readonly appName?: string;
  readonly options?: ReadonlyArray<ProviderApprovalOption>;
  readonly toolName?: string;
  readonly approvalMode?: string;
  readonly tier?: string;
  readonly args?: unknown;
  readonly reason?: string;
  readonly details?: ReadonlyArray<string>;
  readonly providerSafetyChecks?: ReadonlyArray<string>;
  readonly allowedDecisions?: ReadonlyArray<ProviderApprovalDecision>;
}

const isProviderRequestKind = Schema.is(ProviderRequestKind);
const isProviderApprovalOption = Schema.is(ProviderApprovalOption);

export interface PendingUserInput {
  readonly requestId: ApprovalRequestId;
  readonly createdAt: string;
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly allowedActions?: ReadonlyArray<ProviderUserInputAction>;
  readonly timeout?: number;
  readonly supportsNote?: boolean;
}
export interface PendingUserInputDraftAnswer {
  readonly selectedOptionLabels?: ReadonlyArray<string>;
  readonly customAnswer?: string;
  readonly note?: string;
}

export interface PendingPlanReview extends PlanReviewRequestedPayload {
  readonly requestId: ApprovalRequestId;
  readonly createdAt: string;
}

export interface ThreadFeedActivity {
  readonly id: string;
  readonly createdAt: string;
  readonly turnId: TurnId | null;
  readonly summary: string;
  readonly detail: string | null;
  readonly canExpand: boolean;
  readonly getFullDetail: () => string | null;
  readonly getCopyText: () => string;
  readonly icon:
    | "agent"
    | "alert"
    | "check"
    | "command"
    | "edit"
    | "eye"
    | "globe"
    | "hammer"
    | "message"
    | "warning"
    | "wrench"
    | "zap";
  readonly toolLike: boolean;
  readonly status: "success" | "failure" | "neutral" | null;
}

const MAX_VISIBLE_WORK_LOG_ENTRIES = 1;

type WorkLogToolLifecycleStatus = "inProgress" | "completed" | "failed" | "declined" | "stopped";

interface WorkLogEntry {
  id: string;
  createdAt: string;
  turnId: TurnId | null;
  label: string;
  detail?: string;
  command?: string;
  rawCommand?: string;
  changedFiles?: ReadonlyArray<string>;
  tone: "thinking" | "tool" | "info" | "error";
  toolTitle?: string;
  itemType?: ToolLifecycleItemType;
  requestKind?: PendingApproval["requestKind"];
  toolLifecycleStatus?: WorkLogToolLifecycleStatus;
  toolData?: unknown;
}

interface DerivedWorkLogEntry extends WorkLogEntry {
  activityKind: OrchestrationThreadActivity["kind"];
  collapseKey?: string;
  /** Grouping key for subagent lifecycle rows (one row per agent). */
  taskId?: string;
}

type RawThreadFeedEntry =
  | {
      readonly type: "message";
      readonly id: string;
      readonly createdAt: string;
      readonly message: OrchestrationThread["messages"][number];
      readonly checkpointTurnCount?: number;
    }
  | {
      readonly type: "activity";
      readonly id: string;
      readonly createdAt: string;
      readonly turnId: TurnId | null;
      readonly activity: ThreadFeedActivity;
    };

export type ThreadFeedEntry =
  | Extract<RawThreadFeedEntry, { type: "message" }>
  | {
      readonly type: "working";
      readonly id: string;
      readonly createdAt: string;
    }
  | {
      readonly type: "activity-group";
      readonly id: string;
      readonly createdAt: string;
      readonly turnId: TurnId | null;
      readonly activities: ReadonlyArray<ThreadFeedActivity>;
    }
  | {
      readonly type: "work-toggle";
      readonly id: string;
      readonly createdAt: string;
      readonly turnId: TurnId | null;
      readonly groupId: string;
      readonly hiddenCount: number;
      readonly expanded: boolean;
      readonly onlyToolActivities: boolean;
    }
  | {
      readonly type: "turn-fold";
      readonly id: string;
      readonly createdAt: string;
      readonly turnId: TurnId;
      readonly label: string;
      readonly expanded: boolean;
    };

export type ThreadFeedLatestTurn = Pick<
  OrchestrationLatestTurn,
  "turnId" | "state" | "startedAt" | "completedAt"
>;

function requestKindFromRequestType(requestType: unknown): PendingApproval["requestKind"] | null {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    case "mcp_elicitation_approval":
      return "mcp-elicitation";
    case "tool_approval":
      return "tool";
    default:
      return null;
  }
}

function isStalePendingRequestFailureDetail(detail: string | undefined): boolean {
  const normalized = detail?.toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("stale pending approval request") ||
    normalized.includes("stale pending user-input request") ||
    normalized.includes("unknown pending approval request") ||
    normalized.includes("unknown pending permission request") ||
    normalized.includes("unknown pending user-input request")
  );
}

function parseApprovalRequestId(value: unknown): ApprovalRequestId | null {
  return typeof value === "string" && value.length > 0 ? ApprovalRequestId.make(value) : null;
}

function parseUserInputQuestions(
  payload: Record<string, unknown> | null,
): ReadonlyArray<UserInputQuestion> | null {
  const questions = payload?.questions;
  if (!Array.isArray(questions)) {
    return null;
  }

  const parsed = questions
    .map<UserInputQuestion | null>((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const question = entry as Record<string, unknown>;
      if (
        typeof question.id !== "string" ||
        typeof question.question !== "string" ||
        !Array.isArray(question.options)
      ) {
        return null;
      }
      const options = question.options
        .map<UserInputQuestion["options"][number] | null>((option) => {
          if (!option || typeof option !== "object") return null;
          const record = option as Record<string, unknown>;
          if (typeof record.label !== "string") return null;
          return {
            label: record.label,
            ...(typeof record.description === "string" ? { description: record.description } : {}),
            ...(typeof record.preview === "string" ? { preview: record.preview } : {}),
          };
        })
        .filter((option): option is UserInputQuestion["options"][number] => option !== null);
      if (options.length === 0 && question.allowCustom !== true) {
        return null;
      }
      return {
        id: question.id,
        ...(typeof question.header === "string" ? { header: question.header } : {}),
        question: question.question,
        options,
        multiSelect: question.multiSelect === true,
        ...(typeof question.recommended === "number" &&
        Number.isInteger(question.recommended) &&
        question.recommended >= 0
          ? { recommended: question.recommended }
          : {}),
        ...(typeof question.allowCustom === "boolean" ? { allowCustom: question.allowCustom } : {}),
      };
    })
    .filter((question): question is UserInputQuestion => question !== null);

  return parsed.length > 0 ? parsed : null;
}

function normalizeDraftAnswer(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeSelectedOptionLabels(
  value: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(value.map((entry) => entry.trim()).filter((entry) => entry.length > 0)),
  );
}

function resolvePendingUserInputAnswer(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
): string | ReadonlyArray<string> | null {
  const customAnswer =
    question.allowCustom !== false ? normalizeDraftAnswer(draft?.customAnswer) : null;
  if (customAnswer) {
    return customAnswer;
  }

  const optionLabels = normalizeSelectedOptionLabels(draft?.selectedOptionLabels);
  if (question.multiSelect) {
    return optionLabels.length > 0 ? optionLabels : null;
  }
  return optionLabels[0] ?? null;
}

function selectedOptionLabels(
  draft: PendingUserInputDraftAnswer | undefined,
): ReadonlyArray<string> {
  return normalizeSelectedOptionLabels(draft?.selectedOptionLabels);
}

/** Codex children settle via task.updated (idle/failed/interrupted), never
 * task.completed — these rows are mobile's only terminal signal for them. */
const MOBILE_TERMINAL_UPDATE_STATUSES: ReadonlySet<string> = new Set([
  "idle",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

function isTerminalBypassUpdate(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "task.updated") {
    return false;
  }
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  return (
    payload?.timelineBypass === true &&
    typeof payload.status === "string" &&
    MOBILE_TERMINAL_UPDATE_STATUSES.has(payload.status)
  );
}

/** Agent-owned work belongs exclusively to the Agents sheet. Background
 * tasks remain in the ordinary work log. */
function isAgentInternalActivity(activity: OrchestrationThreadActivity): boolean {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  if (!payload) return false;
  return (
    payload.agentKind === "agent" ||
    payload.timelineBypass === true ||
    (typeof payload.agentId === "string" && payload.agentId.trim().length > 0)
  );
}

function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): DerivedWorkLogEntry[] {
  const ordered = Arr.sort(activities, activityOrder);
  const entries: DerivedWorkLogEntry[] = [];
  for (const activity of ordered) {
    if (activity.kind === "tool.started") continue;
    if (activity.kind === "task.started") continue;
    // Terminal bypassed updates pass: Codex children's only terminal signal.
    if (activity.kind === "task.updated" && !isTerminalBypassUpdate(activity)) continue;
    if (activity.kind === "tool.progress") continue;
    if (activity.kind === "context-window.updated") continue;
    if (activity.summary === "Checkpoint captured") continue;
    if (isPlanBoundaryToolActivity(activity)) continue;
    if (isAgentInternalActivity(activity)) continue;
    entries.push(toDerivedWorkLogEntry(activity));
  }
  return collapseDerivedWorkLogEntries(entries);
}

function isPlanBoundaryToolActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "tool.updated" && activity.kind !== "tool.completed") {
    return false;
  }

  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  return typeof payload?.detail === "string" && payload.detail.startsWith("ExitPlanMode:");
}

function toDerivedWorkLogEntry(activity: OrchestrationThreadActivity): DerivedWorkLogEntry {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  const commandPreview = extractToolCommand(payload);
  const changedFiles = extractChangedFiles(payload);
  const title = extractToolTitle(payload);
  // task.updated included: terminal bypassed updates (Codex children's only
  // terminal signal) must carry task identity so they collapse per child
  // instead of stacking anonymous "Task idle" rows.
  const isTaskActivity =
    activity.kind === "task.progress" ||
    activity.kind === "task.completed" ||
    activity.kind === "task.updated";
  const taskSummary =
    isTaskActivity && typeof payload?.summary === "string" && payload.summary.length > 0
      ? payload.summary
      : null;
  const taskDetailAsLabel =
    isTaskActivity &&
    !taskSummary &&
    typeof payload?.detail === "string" &&
    payload.detail.length > 0
      ? payload.detail
      : null;
  const taskLabel = taskSummary || taskDetailAsLabel;
  const taskId =
    isTaskActivity && typeof payload?.taskId === "string" && payload.taskId.length > 0
      ? payload.taskId
      : undefined;
  const entry: DerivedWorkLogEntry = {
    id: activity.id,
    createdAt: activity.createdAt,
    turnId: activity.turnId,
    ...(taskId ? { taskId } : {}),
    label: taskLabel || activity.summary,
    tone:
      activity.kind === "task.progress"
        ? "thinking"
        : activity.tone === "approval"
          ? "info"
          : activity.tone,
    activityKind: activity.kind,
  };
  const itemType = extractWorkLogItemType(payload);
  const requestKind = extractWorkLogRequestKind(payload);
  if (
    !taskDetailAsLabel &&
    payload &&
    typeof payload.detail === "string" &&
    payload.detail.length > 0
  ) {
    const detail = stripTrailingExitCode(payload.detail).output;
    if (detail) {
      entry.detail = detail;
    }
  }
  if (commandPreview.command) {
    entry.command = commandPreview.command;
  }
  if (commandPreview.rawCommand) {
    entry.rawCommand = commandPreview.rawCommand;
  }
  if (changedFiles.length > 0) {
    entry.changedFiles = changedFiles;
  }
  if (title) {
    entry.toolTitle = title;
  }
  if (itemType === "mcp_tool_call") {
    const data = asRecord(payload?.data);
    if (data?.item !== undefined) {
      entry.toolData = data.item;
    }
  }
  if (itemType) {
    entry.itemType = itemType;
  }
  if (requestKind) {
    entry.requestKind = requestKind;
  }
  let toolLifecycleStatus = extractWorkLogToolLifecycleStatus(payload);
  if (!toolLifecycleStatus && activity.kind === "tool.completed") {
    toolLifecycleStatus = "completed";
  }
  if (toolLifecycleStatus) {
    entry.toolLifecycleStatus = toolLifecycleStatus;
  }
  const collapseKey = deriveToolLifecycleCollapseKey(entry);
  if (collapseKey) {
    entry.collapseKey = collapseKey;
  }
  return entry;
}

function collapseDerivedWorkLogEntries(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
): DerivedWorkLogEntry[] {
  const collapsed: DerivedWorkLogEntry[] = [];
  // Subagent rows collapse by identity, not adjacency (quiet-timeline
  // guarantee; mirrors web's session-logic).
  const taskRowIndex = new Map<string, number>();
  for (const entry of entries) {
    const isTaskRow =
      entry.taskId !== undefined &&
      (entry.activityKind === "task.progress" ||
        entry.activityKind === "task.completed" ||
        entry.activityKind === "task.updated");
    if (isTaskRow && entry.taskId !== undefined) {
      const existingIndex = taskRowIndex.get(entry.taskId);
      if (existingIndex !== undefined) {
        collapsed[existingIndex] = mergeDerivedWorkLogEntries(collapsed[existingIndex]!, entry);
        continue;
      }
      taskRowIndex.set(entry.taskId, collapsed.length);
      collapsed.push(entry);
      continue;
    }
    const previous = collapsed.at(-1);
    if (previous && shouldCollapseToolLifecycleEntries(previous, entry)) {
      collapsed[collapsed.length - 1] = mergeDerivedWorkLogEntries(previous, entry);
      continue;
    }
    collapsed.push(entry);
  }
  return collapsed;
}

function shouldCollapseToolLifecycleEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): boolean {
  if (previous.activityKind !== "tool.updated" && previous.activityKind !== "tool.completed") {
    return false;
  }
  if (next.activityKind !== "tool.updated" && next.activityKind !== "tool.completed") {
    return false;
  }
  if (previous.activityKind === "tool.completed") {
    return false;
  }
  return previous.collapseKey !== undefined && previous.collapseKey === next.collapseKey;
}

function mergeDerivedWorkLogEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): DerivedWorkLogEntry {
  const changedFiles = mergeChangedFiles(previous.changedFiles, next.changedFiles);
  const detail = next.detail ?? previous.detail;
  const command = next.command ?? previous.command;
  const rawCommand = next.rawCommand ?? previous.rawCommand;
  const toolTitle = next.toolTitle ?? previous.toolTitle;
  const itemType = next.itemType ?? previous.itemType;
  const requestKind = next.requestKind ?? previous.requestKind;
  const collapseKey = next.collapseKey ?? previous.collapseKey;
  const toolLifecycleStatus = next.toolLifecycleStatus ?? previous.toolLifecycleStatus;
  const toolData = next.toolData ?? previous.toolData;
  return {
    ...previous,
    ...next,
    ...(detail ? { detail } : {}),
    ...(command ? { command } : {}),
    ...(rawCommand ? { rawCommand } : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(toolTitle ? { toolTitle } : {}),
    ...(itemType ? { itemType } : {}),
    ...(requestKind ? { requestKind } : {}),
    ...(collapseKey ? { collapseKey } : {}),
    ...(toolLifecycleStatus ? { toolLifecycleStatus } : {}),
    ...(toolData !== undefined ? { toolData } : {}),
  };
}

function mergeChangedFiles(
  previous: ReadonlyArray<string> | undefined,
  next: ReadonlyArray<string> | undefined,
): string[] {
  const merged = [...(previous ?? []), ...(next ?? [])];
  if (merged.length === 0) {
    return [];
  }
  return [...new Set(merged)];
}

function deriveToolLifecycleCollapseKey(entry: DerivedWorkLogEntry): string | undefined {
  if (entry.activityKind !== "tool.updated" && entry.activityKind !== "tool.completed") {
    return undefined;
  }
  const normalizedLabel = normalizeCompactToolLabel(entry.toolTitle ?? entry.label);
  const detail = entry.detail?.trim() ?? "";
  const itemType = entry.itemType ?? "";
  if (normalizedLabel.length === 0 && detail.length === 0 && itemType.length === 0) {
    return undefined;
  }
  return [itemType, normalizedLabel, detail].join("\u001f");
}

function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

function workLogEntryIsToolLike(entry: WorkLogEntry): boolean {
  if (entry.tone === "tool" || entry.tone === "thinking" || entry.tone === "error") {
    return true;
  }
  if (entry.command !== undefined && entry.command.trim().length > 0) {
    return true;
  }
  if (entry.requestKind !== undefined) {
    return true;
  }
  return entry.itemType !== undefined && isToolLifecycleItemType(entry.itemType);
}

function toolDetailTextLooksLikeFailure(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("file not found") ||
    normalized.includes("no files found") ||
    normalized.includes("enoent") ||
    normalized.includes("no such file or directory") ||
    normalized.includes("no such file") ||
    normalized.includes("commandnotfoundexception") ||
    normalized.includes("command not found") ||
    (normalized.includes("cannot find path") && normalized.includes("because it does not exist")) ||
    (normalized.includes("is not recognized") && normalized.includes("the term '")) ||
    normalized.includes("is not recognized as the name of a cmdlet") ||
    normalized.includes("a parameter cannot be found that matches parameter name") ||
    /<exited with exit code\s+[1-9]\d*\s*>/i.test(text) ||
    /exit(?:ed)? with exit code\s+[1-9]\d*/i.test(text) ||
    /exit code\s*[:\s]\s*[1-9]\d*\b/i.test(text)
  );
}

function workEntryIndicatesToolFailure(entry: WorkLogEntry): boolean {
  if (entry.tone === "error") {
    return true;
  }
  if (entry.toolLifecycleStatus === "failed" || entry.toolLifecycleStatus === "declined") {
    return true;
  }
  if (!workLogEntryIsToolLike(entry)) {
    return false;
  }
  return toolDetailTextLooksLikeFailure([entry.detail, entry.command].filter(Boolean).join("\n"));
}

function workEntryIndicatesToolSuccess(entry: WorkLogEntry): boolean {
  if (!workLogEntryIsToolLike(entry) || workEntryIndicatesToolFailure(entry)) {
    return false;
  }
  if (entry.tone === "thinking") {
    return false;
  }
  return (
    entry.toolLifecycleStatus !== "inProgress" &&
    entry.toolLifecycleStatus !== "stopped" &&
    entry.toolLifecycleStatus !== "failed" &&
    entry.toolLifecycleStatus !== "declined"
  );
}

function workEntryStatus(entry: WorkLogEntry): ThreadFeedActivity["status"] {
  if (!workLogEntryIsToolLike(entry)) {
    return null;
  }
  if (workEntryIndicatesToolFailure(entry)) {
    return "failure";
  }
  if (workEntryIndicatesToolSuccess(entry)) {
    return "success";
  }
  return "neutral";
}

function workEntryIcon(entry: DerivedWorkLogEntry): ThreadFeedActivity["icon"] {
  if (
    entry.activityKind === "user-input.requested" ||
    entry.activityKind === "user-input.resolved"
  ) {
    return "message";
  }
  if (entry.activityKind === "runtime.warning") return "warning";
  if (entry.requestKind === "command") return "command";
  if (entry.requestKind === "file-read") return "eye";
  if (entry.requestKind === "file-change") return "edit";
  if (entry.itemType === "command_execution" || entry.command) return "command";
  if (entry.itemType === "file_change" || (entry.changedFiles?.length ?? 0) > 0) return "edit";
  if (entry.itemType === "web_search") return "globe";
  if (entry.itemType === "image_view") return "eye";
  if (entry.itemType === "mcp_tool_call") return "wrench";
  if (entry.itemType === "dynamic_tool_call" || entry.itemType === "collab_agent_tool_call") {
    return "hammer";
  }
  if (entry.tone === "error") return "alert";
  if (entry.tone === "thinking") return "agent";
  if (entry.tone === "info") return "check";
  return "zap";
}

function buildWorkEntryExpandedBody(entry: WorkLogEntry): string | null {
  const blocks: string[] = [];
  const appendUniqueBlock = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (trimmed && !blocks.includes(trimmed)) {
      blocks.push(trimmed);
    }
  };

  if (entry.itemType === "mcp_tool_call" && entry.toolData !== undefined) {
    appendUniqueBlock(`MCP call\n${JSON.stringify(entry.toolData, null, 2)}`);
  }
  appendUniqueBlock(entry.rawCommand ?? entry.command);
  appendUniqueBlock(entry.detail);
  if ((entry.changedFiles?.length ?? 0) > 0) {
    appendUniqueBlock(entry.changedFiles!.join("\n"));
  }

  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

function workEntryHasExpandedBody(entry: WorkLogEntry): boolean {
  return (
    (entry.itemType === "mcp_tool_call" && entry.toolData !== undefined) ||
    Boolean((entry.rawCommand ?? entry.command)?.trim()) ||
    Boolean(entry.detail?.trim()) ||
    (entry.changedFiles?.some((path) => path.trim().length > 0) ?? false)
  );
}

function memoizeValue<T>(build: () => T): () => T {
  let value: T;
  let initialized = false;
  return () => {
    if (!initialized) {
      value = build();
      initialized = true;
    }
    return value;
  };
}

function workEntryPreview(
  workEntry: Pick<WorkLogEntry, "detail" | "command" | "changedFiles">,
): string | null {
  if (workEntry.command) return workEntry.command;
  if (workEntry.detail) return workEntry.detail;
  if ((workEntry.changedFiles?.length ?? 0) === 0) return null;
  const [firstPath] = workEntry.changedFiles ?? [];
  if (!firstPath) return null;
  return workEntry.changedFiles!.length === 1
    ? firstPath
    : `${firstPath} +${workEntry.changedFiles!.length - 1} more`;
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function workEntryHeading(workEntry: WorkLogEntry): string {
  if (!workEntry.toolTitle) {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.label));
  }
  return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function trimMatchingOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    const unquoted = trimmed.slice(1, -1).trim();
    return unquoted.length > 0 ? unquoted : trimmed;
  }
  return trimmed;
}

function executableBasename(value: string): string | null {
  const trimmed = trimMatchingOuterQuotes(value);
  if (trimmed.length === 0) {
    return null;
  }
  const normalized = trimmed.replace(/\\/g, "/");
  const segments = normalized.split("/");
  const last = segments.at(-1)?.trim() ?? "";
  return last.length > 0 ? last.toLowerCase() : null;
}

function splitExecutableAndRest(value: string): { executable: string; rest: string } | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed.charAt(0);
    const closeIndex = trimmed.indexOf(quote, 1);
    if (closeIndex <= 0) {
      return null;
    }
    return {
      executable: trimmed.slice(0, closeIndex + 1),
      rest: trimmed.slice(closeIndex + 1).trim(),
    };
  }

  const firstWhitespace = trimmed.search(/\s/);
  if (firstWhitespace < 0) {
    return {
      executable: trimmed,
      rest: "",
    };
  }

  return {
    executable: trimmed.slice(0, firstWhitespace),
    rest: trimmed.slice(firstWhitespace).trim(),
  };
}

const SHELL_WRAPPER_SPECS = [
  {
    executables: ["pwsh", "pwsh.exe", "powershell", "powershell.exe"],
    wrapperFlagPattern: /(?:^|\s)-command\s+/i,
  },
  {
    executables: ["cmd", "cmd.exe"],
    wrapperFlagPattern: /(?:^|\s)\/c\s+/i,
  },
  {
    executables: ["bash", "sh", "zsh"],
    wrapperFlagPattern: /(?:^|\s)-(?:l)?c\s+/i,
  },
] as const;

function findShellWrapperSpec(shell: string) {
  return SHELL_WRAPPER_SPECS.find((spec) =>
    (spec.executables as ReadonlyArray<string>).includes(shell),
  );
}

function unwrapCommandRemainder(value: string, wrapperFlagPattern: RegExp): string | null {
  const match = wrapperFlagPattern.exec(value);
  if (!match) {
    return null;
  }

  const command = value.slice(match.index + match[0].length).trim();
  if (command.length === 0) {
    return null;
  }

  const unwrapped = trimMatchingOuterQuotes(command);
  return unwrapped.length > 0 ? unwrapped : null;
}

function unwrapKnownShellCommandWrapper(value: string): string {
  const split = splitExecutableAndRest(value);
  if (!split || split.rest.length === 0) {
    return value;
  }

  const shell = executableBasename(split.executable);
  if (!shell) {
    return value;
  }

  const spec = findShellWrapperSpec(shell);
  if (!spec) {
    return value;
  }

  return unwrapCommandRemainder(split.rest, spec.wrapperFlagPattern) ?? value;
}

function formatCommandArrayPart(value: string): string {
  return /[\s"'`]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function formatCommandValue(value: unknown): string | null {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const parts: Array<string> = [];
  for (const entry of value) {
    const part = asTrimmedString(entry);
    if (part !== null) {
      parts.push(part);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.map((part) => formatCommandArrayPart(part)).join(" ");
}

function normalizeCommandValue(value: unknown): string | null {
  const formatted = formatCommandValue(value);
  return formatted ? unwrapKnownShellCommandWrapper(formatted) : null;
}

function toRawToolCommand(value: unknown, normalizedCommand: string | null): string | null {
  const formatted = formatCommandValue(value);
  if (!formatted || normalizedCommand === null) {
    return null;
  }
  return formatted === normalizedCommand ? null : formatted;
}

function extractToolCommand(payload: Record<string, unknown> | null): {
  command: string | null;
  rawCommand: string | null;
} {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const itemInput = asRecord(item?.input);
  const itemType = asTrimmedString(payload?.itemType);
  const detail = asTrimmedString(payload?.detail);
  const candidates: unknown[] = [
    item?.command,
    itemInput?.command,
    itemResult?.command,
    data?.command,
    itemType === "command_execution" && detail ? stripTrailingExitCode(detail).output : null,
  ];

  for (const candidate of candidates) {
    const command = normalizeCommandValue(candidate);
    if (!command) {
      continue;
    }
    return {
      command,
      rawCommand: toRawToolCommand(candidate, command),
    };
  }

  return {
    command: null,
    rawCommand: null,
  };
}

function extractToolTitle(payload: Record<string, unknown> | null): string | null {
  return asTrimmedString(payload?.title);
}

function extractWorkLogToolLifecycleStatus(
  payload: Record<string, unknown> | null,
): WorkLogToolLifecycleStatus | undefined {
  const status = payload?.status;
  if (
    status === "inProgress" ||
    status === "completed" ||
    status === "failed" ||
    status === "declined" ||
    status === "stopped"
  ) {
    return status;
  }
  return undefined;
}

function stripTrailingExitCode(value: string): {
  output: string | null;
  exitCode?: number | undefined;
} {
  const trimmed = value.trim();
  const match = /^(?<output>[\s\S]*?)(?:\s*<exited with exit code (?<code>\d+)>)\s*$/i.exec(
    trimmed,
  );
  if (!match?.groups) {
    return {
      output: trimmed.length > 0 ? trimmed : null,
    };
  }
  const exitCode = Number.parseInt(match.groups.code ?? "", 10);
  const normalizedOutput = match.groups.output?.trim() ?? "";
  return {
    output: normalizedOutput.length > 0 ? normalizedOutput : null,
    ...(Number.isInteger(exitCode) ? { exitCode } : {}),
  };
}

function extractWorkLogItemType(
  payload: Record<string, unknown> | null,
): WorkLogEntry["itemType"] | undefined {
  if (typeof payload?.itemType === "string" && isToolLifecycleItemType(payload.itemType)) {
    return payload.itemType;
  }
  return undefined;
}

function extractWorkLogRequestKind(
  payload: Record<string, unknown> | null,
): WorkLogEntry["requestKind"] | undefined {
  if (
    payload?.requestKind === "command" ||
    payload?.requestKind === "file-read" ||
    payload?.requestKind === "file-change"
  ) {
    return payload.requestKind;
  }
  return requestKindFromRequestType(payload?.requestType) ?? undefined;
}

function pushChangedFile(target: string[], seen: Set<string>, value: unknown) {
  const normalized = asTrimmedString(value);
  if (!normalized || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  target.push(normalized);
}

function collectChangedFiles(value: unknown, target: string[], seen: Set<string>, depth: number) {
  if (depth > 4 || target.length >= 12) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFiles(entry, target, seen, depth + 1);
      if (target.length >= 12) {
        return;
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  pushChangedFile(target, seen, record.path);
  pushChangedFile(target, seen, record.filePath);
  pushChangedFile(target, seen, record.relativePath);
  pushChangedFile(target, seen, record.filename);
  pushChangedFile(target, seen, record.newPath);
  pushChangedFile(target, seen, record.oldPath);

  for (const nestedKey of [
    "item",
    "result",
    "input",
    "data",
    "changes",
    "files",
    "edits",
    "patch",
    "patches",
    "operations",
  ]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectChangedFiles(record[nestedKey], target, seen, depth + 1);
    if (target.length >= 12) {
      return;
    }
  }
}

function extractChangedFiles(payload: Record<string, unknown> | null): string[] {
  const changedFiles: string[] = [];
  const seen = new Set<string>();
  collectChangedFiles(asRecord(payload?.data), changedFiles, seen, 0);
  return changedFiles;
}

function compareActivityLifecycleRank(kind: string): number {
  if (kind.endsWith(".started") || kind === "tool.started") {
    return 0;
  }
  if (kind.endsWith(".progress") || kind.endsWith(".updated")) {
    return 1;
  }
  if (kind.endsWith(".completed") || kind.endsWith(".resolved")) {
    return 2;
  }
  return 1;
}

const activityOrder = Order.combineAll<OrchestrationThreadActivity>([
  Order.mapInput(Order.Number, (activity) => activity.sequence ?? Number.MAX_SAFE_INTEGER),
  Order.mapInput(Order.String, (activity) => activity.createdAt),
  Order.mapInput(Order.Number, (activity) => compareActivityLifecycleRank(activity.kind)),
  Order.mapInput(Order.String, (activity) => activity.id),
]);

function isEmptyMessage(entry: RawThreadFeedEntry): boolean {
  if (entry.type !== "message") {
    return false;
  }
  const hasText = entry.message.text.trim().length > 0;
  const hasAttachments = (entry.message.attachments ?? []).length > 0;
  return !hasText && !hasAttachments;
}

function groupAdjacentActivities(entries: ReadonlyArray<RawThreadFeedEntry>): ThreadFeedEntry[] {
  const grouped: ThreadFeedEntry[] = [];
  // Mutable backing array for the trailing group so appending an activity is
  // O(1) instead of re-copying the group (which made this loop quadratic on
  // long tool runs). The array is only mutated while it is the trailing group.
  let openGroupActivities: ThreadFeedActivity[] | null = null;
  let openGroupTurnId: TurnId | null = null;

  for (const entry of entries) {
    // Skip empty messages so they don't break activity grouping.
    if (isEmptyMessage(entry)) {
      continue;
    }

    if (entry.type !== "activity") {
      grouped.push(entry);
      openGroupActivities = null;
      continue;
    }

    if (openGroupActivities !== null && openGroupTurnId === entry.turnId) {
      openGroupActivities.push(entry.activity);
      continue;
    }

    openGroupActivities = [entry.activity];
    openGroupTurnId = entry.turnId;
    grouped.push({
      type: "activity-group",
      id: entry.id,
      createdAt: entry.createdAt,
      turnId: entry.turnId,
      activities: openGroupActivities,
    });
  }

  return grouped;
}

function computeElapsedMs(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }
  return Math.max(0, end - start);
}

function maxIsoTimestamp(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (!Number.isFinite(aMs)) return b;
  if (!Number.isFinite(bMs)) return a;
  return bMs > aMs ? b : a;
}

function deriveUnsettledTurnId(latestTurn: ThreadFeedLatestTurn | null): TurnId | null {
  if (!latestTurn) {
    return null;
  }
  const settled = latestTurn.completedAt !== null && latestTurn.state !== "running";
  return settled ? null : latestTurn.turnId;
}

interface ThreadFeedTurnFold {
  readonly turnId: TurnId;
  readonly createdAt: string;
  readonly hiddenEntryIds: ReadonlySet<string>;
  readonly label: string;
}

function deriveThreadFeedTurnFolds(
  feed: ReadonlyArray<ThreadFeedEntry>,
  latestTurn: ThreadFeedLatestTurn | null,
): ReadonlyMap<string, ThreadFeedTurnFold> {
  const firstAssistantMessageIdByTurn = new Map<TurnId, string>();
  const terminalAssistantMessageIdByTurn = new Map<TurnId, string>();
  for (const entry of feed) {
    if (entry.type === "message" && entry.message.role === "assistant" && entry.message.turnId) {
      if (!firstAssistantMessageIdByTurn.has(entry.message.turnId)) {
        firstAssistantMessageIdByTurn.set(entry.message.turnId, entry.id);
      }
      terminalAssistantMessageIdByTurn.set(entry.message.turnId, entry.id);
    }
  }

  interface TurnGroup {
    readonly entries: ThreadFeedEntry[];
    readonly startBoundary: string | null;
  }
  const groupsByTurnId = new Map<TurnId, TurnGroup>();
  let pendingUserBoundary: string | null = null;
  for (const entry of feed) {
    if (entry.type === "message" && entry.message.role === "user") {
      pendingUserBoundary = entry.message.createdAt;
      continue;
    }
    const turnId =
      entry.type === "message" && entry.message.role === "assistant"
        ? entry.message.turnId
        : entry.type === "activity-group"
          ? entry.turnId
          : null;
    if (!turnId) {
      continue;
    }
    let group = groupsByTurnId.get(turnId);
    if (!group) {
      group = {
        entries: [],
        startBoundary: pendingUserBoundary,
      };
      pendingUserBoundary = null;
      groupsByTurnId.set(turnId, group);
    }
    group.entries.push(entry);
  }

  const unsettledTurnId = deriveUnsettledTurnId(latestTurn);
  const foldsByAnchorId = new Map<string, ThreadFeedTurnFold>();
  for (const [turnId, group] of groupsByTurnId) {
    const { entries } = group;
    if (turnId === unsettledTurnId) {
      continue;
    }
    if (entries.some((entry) => entry.type === "message" && entry.message.streaming)) {
      continue;
    }

    const firstAssistantMessageId = firstAssistantMessageIdByTurn.get(turnId);
    const terminalAssistantMessageId = terminalAssistantMessageIdByTurn.get(turnId);
    const hiddenEntryIds = new Set(
      entries
        .filter(
          (entry) =>
            entry.id !== firstAssistantMessageId && entry.id !== terminalAssistantMessageId,
        )
        .map((entry) => entry.id),
    );
    if (hiddenEntryIds.size === 0) {
      continue;
    }

    const firstEntry = entries[0];
    const firstHiddenEntry = entries.find((entry) => hiddenEntryIds.has(entry.id));
    const lastEntry = entries.at(-1);
    if (!firstEntry || !firstHiddenEntry || !lastEntry) {
      continue;
    }
    const terminalEntry = terminalAssistantMessageId
      ? entries.find((entry) => entry.id === terminalAssistantMessageId)
      : null;
    const latestTurnMatches = latestTurn?.turnId === turnId;
    const lastEntryEnd =
      lastEntry.type === "message" ? lastEntry.message.updatedAt : lastEntry.createdAt;
    const elapsedMs =
      latestTurnMatches && latestTurn.startedAt && latestTurn.completedAt
        ? computeElapsedMs(latestTurn.startedAt, latestTurn.completedAt)
        : computeElapsedMs(
            group.startBoundary ?? firstEntry.createdAt,
            maxIsoTimestamp(
              terminalEntry?.type === "message" ? terminalEntry.message.updatedAt : null,
              lastEntryEnd,
            ) ?? lastEntryEnd,
          );
    const duration = elapsedMs === null ? null : formatDuration(elapsedMs);
    const interrupted = latestTurnMatches && latestTurn.state === "interrupted";
    const label = interrupted
      ? duration
        ? `You stopped after ${duration}`
        : "You stopped this response"
      : duration
        ? `Worked for ${duration}`
        : "Worked";

    foldsByAnchorId.set(firstHiddenEntry.id, {
      turnId,
      createdAt: firstHiddenEntry.createdAt,
      hiddenEntryIds,
      label,
    });
  }
  return foldsByAnchorId;
}

export function deriveThreadFeedPresentation(
  feed: ReadonlyArray<ThreadFeedEntry>,
  latestTurn: ThreadFeedLatestTurn | null,
  expandedTurnIds: ReadonlySet<TurnId>,
  expandedWorkGroupIds: ReadonlySet<string> = new Set(),
  activeWorkStartedAt: string | null = null,
): ThreadFeedEntry[] {
  const sourceFeed = feed.filter(
    (entry) =>
      entry.type !== "turn-fold" && entry.type !== "work-toggle" && entry.type !== "working",
  );
  const foldsByAnchorId = deriveThreadFeedTurnFolds(sourceFeed, latestTurn);
  const collapsedEntryIds = new Set<string>();
  for (const fold of foldsByAnchorId.values()) {
    if (!expandedTurnIds.has(fold.turnId)) {
      for (const entryId of fold.hiddenEntryIds) {
        collapsedEntryIds.add(entryId);
      }
    }
  }

  const result: ThreadFeedEntry[] = [];
  for (const entry of sourceFeed) {
    const fold = foldsByAnchorId.get(entry.id);
    if (fold) {
      result.push({
        type: "turn-fold",
        id: `turn-fold:${fold.turnId}`,
        createdAt: fold.createdAt,
        turnId: fold.turnId,
        label: fold.label,
        expanded: expandedTurnIds.has(fold.turnId),
      });
    }
    if (!collapsedEntryIds.has(entry.id)) {
      appendPresentedFeedEntry(result, entry, expandedWorkGroupIds);
    }
  }
  if (activeWorkStartedAt !== null) {
    result.push({
      type: "working",
      id: "working-indicator-row",
      createdAt: activeWorkStartedAt,
    });
  }
  return result;
}

function appendPresentedFeedEntry(
  result: ThreadFeedEntry[],
  entry: Exclude<ThreadFeedEntry, { readonly type: "turn-fold" | "work-toggle" | "working" }>,
  expandedWorkGroupIds: ReadonlySet<string>,
): void {
  if (entry.type !== "activity-group") {
    result.push(entry);
    return;
  }

  const activities = entry.activities.filter(
    (activity) => !(activity.toolLike && activity.status === "neutral"),
  );
  if (activities.length === 0) {
    return;
  }
  if (activities.length <= MAX_VISIBLE_WORK_LOG_ENTRIES) {
    result.push({
      ...entry,
      activities,
    });
    return;
  }

  const groupId = entry.id;
  const expanded = expandedWorkGroupIds.has(groupId);
  const hiddenCount = activities.length - MAX_VISIBLE_WORK_LOG_ENTRIES;
  const visibleActivities = expanded ? activities : activities.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES);

  for (const activity of visibleActivities) {
    result.push({
      type: "activity-group",
      id: activity.id,
      createdAt: activity.createdAt,
      turnId: activity.turnId,
      activities: [activity],
    });
  }
  result.push({
    type: "work-toggle",
    id: `work-toggle:${groupId}`,
    createdAt: entry.createdAt,
    turnId: entry.turnId,
    groupId,
    hiddenCount,
    expanded,
    onlyToolActivities: activities.every((activity) => activity.toolLike),
  });
}

/**
 * Sorts activities into lifecycle order. `derivePendingApprovals` and
 * `derivePendingUserInputs` both expect this ordering; sorting once and
 * passing the result to both avoids re-sorting the full activity history
 * per derivation.
 */
export function sortThreadActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  return Arr.sort(activities, activityOrder);
}

export function derivePendingApprovals(
  sortedActivities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingApproval[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingApproval>();

  for (const activity of sortedActivities) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId = parseApprovalRequestId(payload?.requestId);
    const requestKind = isProviderRequestKind(payload?.requestKind)
      ? payload.requestKind
      : requestKindFromRequestType(payload?.requestType);
    const detail = typeof payload?.detail === "string" ? payload.detail : undefined;
    const appName = typeof payload?.appName === "string" ? payload.appName : undefined;
    const options = Array.isArray(payload?.options)
      ? payload.options.filter(isProviderApprovalOption)
      : undefined;

    if (activity.kind === "approval.requested" && requestId && requestKind) {
      const allowedDecisions: ProviderApprovalDecision[] | undefined = Array.isArray(
        payload?.allowedDecisions,
      )
        ? payload.allowedDecisions.filter(
            (decision): decision is ProviderApprovalDecision =>
              decision === "accept" ||
              decision === "acceptForSession" ||
              decision === "acceptAlways" ||
              decision === "decline" ||
              decision === "cancel",
          )
        : undefined;
      openByRequestId.set(requestId, {
        requestId,
        requestKind,
        createdAt: activity.createdAt,
        ...(detail ? { detail } : {}),
        ...(appName ? { appName } : {}),
        ...(options && options.length > 0 ? { options } : {}),
        ...(typeof payload?.toolName === "string" ? { toolName: payload.toolName } : {}),
        ...(typeof payload?.approvalMode === "string"
          ? { approvalMode: payload.approvalMode }
          : {}),
        ...(typeof payload?.tier === "string" ? { tier: payload.tier } : {}),
        ...(payload && "args" in payload ? { args: payload.args } : {}),
        ...(typeof payload?.reason === "string" ? { reason: payload.reason } : {}),
        ...(Array.isArray(payload?.details)
          ? {
              details: payload.details.filter(
                (value): value is string => typeof value === "string",
              ),
            }
          : {}),
        ...(Array.isArray(payload?.providerSafetyChecks)
          ? {
              providerSafetyChecks: payload.providerSafetyChecks.filter(
                (value): value is string => typeof value === "string",
              ),
            }
          : {}),
        ...(allowedDecisions ? { allowedDecisions } : {}),
      });
      continue;
    }

    if (activity.kind === "approval.resolved" && requestId) {
      openByRequestId.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.approval.respond.failed" &&
      requestId &&
      isStalePendingRequestFailureDetail(detail)
    ) {
      openByRequestId.delete(requestId);
    }
  }

  return Arr.sortWith([...openByRequestId.values()], (s) => new Date(s.createdAt), Order.Date);
}

export function derivePendingUserInputs(
  sortedActivities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingUserInput[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingUserInput>();

  for (const activity of sortedActivities) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId = parseApprovalRequestId(payload?.requestId);
    const detail = typeof payload?.detail === "string" ? payload.detail : undefined;

    if (activity.kind === "user-input.requested" && requestId) {
      const questions = parseUserInputQuestions(payload);
      if (!questions) {
        continue;
      }
      const allowedActions = Array.isArray(payload?.allowedActions)
        ? payload.allowedActions.filter(
            (action): action is ProviderUserInputAction =>
              action === "submit" || action === "chat" || action === "cancel",
          )
        : undefined;
      const supportsNote =
        ("provider" in activity && (activity as { provider?: string }).provider === "omp") ||
        payload?.supportsNote === true ||
        payload?.provider === "omp";
      openByRequestId.set(requestId, {
        requestId,
        createdAt: activity.createdAt,
        questions,
        ...(allowedActions ? { allowedActions } : {}),
        ...(typeof payload?.timeout === "number" ? { timeout: payload.timeout } : {}),
        ...(supportsNote ? { supportsNote: true } : {}),
      });
      continue;
    }

    if (activity.kind === "user-input.resolved" && requestId) {
      openByRequestId.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.user-input.respond.failed" &&
      requestId &&
      isStalePendingRequestFailureDetail(detail)
    ) {
      openByRequestId.delete(requestId);
    }
  }

  return Arr.sortWith([...openByRequestId.values()], (s) => new Date(s.createdAt), Order.Date);
}

function parsePlanExecutionModel(value: unknown): ProviderPlanExecutionModel | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.provider !== "string" || typeof record.modelId !== "string") return null;
  return {
    provider: record.provider,
    modelId: record.modelId,
    ...(typeof record.thinkingLevel === "string" ? { thinkingLevel: record.thinkingLevel } : {}),
  };
}

export function derivePendingPlanReview(
  sortedActivities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingPlanReview | null {
  let pending: PendingPlanReview | null = null;
  for (const activity of sortedActivities) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId = parseApprovalRequestId(payload?.requestId);
    if (!payload || !requestId) continue;
    if (activity.kind === "plan.review.resolved") {
      if (pending?.requestId === requestId) pending = null;
      continue;
    }
    if (
      activity.kind !== "plan.review.requested" ||
      typeof payload.title !== "string" ||
      typeof payload.planArtifactId !== "string" ||
      typeof payload.planArtifactUrl !== "string" ||
      typeof payload.planMarkdown !== "string" ||
      !Array.isArray(payload.allowedContextStrategies) ||
      !Array.isArray(payload.executionModels)
    ) {
      continue;
    }
    const allowedContextStrategies = payload.allowedContextStrategies.filter(
      (value): value is ProviderPlanReviewContextStrategy =>
        value === "fresh" || value === "preserve" || value === "compact",
    );
    const executionModels = payload.executionModels
      .map(parsePlanExecutionModel)
      .filter((model): model is ProviderPlanExecutionModel => model !== null);
    const defaultExecutionModel = parsePlanExecutionModel(payload.defaultExecutionModel);
    pending = {
      requestId,
      createdAt: activity.createdAt,
      title: payload.title,
      planArtifactId: payload.planArtifactId,
      planArtifactUrl: payload.planArtifactUrl,
      planMarkdown: payload.planMarkdown,
      allowedContextStrategies,
      executionModels,
      ...(defaultExecutionModel ? { defaultExecutionModel } : {}),
      ...(payload.contextUsage !== undefined ? { contextUsage: payload.contextUsage } : {}),
    };
  }
  return pending;
}

export function setPendingUserInputCustomAnswer(
  draft: PendingUserInputDraftAnswer | undefined,
  customAnswer: string,
): PendingUserInputDraftAnswer {
  const selectedOptionLabels =
    customAnswer.trim().length > 0
      ? undefined
      : normalizeSelectedOptionLabels(draft?.selectedOptionLabels);
  const note = draft?.note;
  return {
    customAnswer,
    ...(selectedOptionLabels && selectedOptionLabels.length > 0 ? { selectedOptionLabels } : {}),
    ...(note !== undefined ? { note } : {}),
  };
}

export function setPendingUserInputNote(
  draft: PendingUserInputDraftAnswer | undefined,
  note: string,
): PendingUserInputDraftAnswer {
  return { ...draft, note };
}

export function isPendingUserInputOptionSelected(
  draft: PendingUserInputDraftAnswer | undefined,
  optionLabel: string,
): boolean {
  if (normalizeDraftAnswer(draft?.customAnswer)) {
    return false;
  }

  return normalizeSelectedOptionLabels(draft?.selectedOptionLabels).includes(optionLabel.trim());
}

export function togglePendingUserInputOptionSelection(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  optionLabel: string,
): PendingUserInputDraftAnswer {
  const normalizedOptionLabel = optionLabel.trim();
  const note = draft?.note;

  if (question.multiSelect) {
    const selectedOptionLabels = normalizeSelectedOptionLabels(draft?.selectedOptionLabels);
    const nextSelectedOptionLabels = selectedOptionLabels.includes(normalizedOptionLabel)
      ? selectedOptionLabels.filter((label) => label !== normalizedOptionLabel)
      : [...selectedOptionLabels, normalizedOptionLabel];

    return {
      customAnswer: "",
      ...(nextSelectedOptionLabels.length > 0
        ? { selectedOptionLabels: nextSelectedOptionLabels }
        : {}),
      ...(note !== undefined ? { note } : {}),
    };
  }

  return {
    customAnswer: "",
    selectedOptionLabels: [normalizedOptionLabel],
    ...(note !== undefined ? { note } : {}),
  };
}

export function buildPendingUserInputAnswers(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
  supportsNote: boolean = true,
): Record<string, ProviderUserInputAnswer> | null {
  const answers: Record<string, ProviderUserInputAnswer> = {};

  for (const question of questions) {
    const draft = draftAnswers[question.id];
    // Custom free-text is only accepted when the question allows it (default true).
    const customInput =
      question.allowCustom !== false ? normalizeDraftAnswer(draft?.customAnswer) : null;
    const selectedOptions = customInput ? [] : [...selectedOptionLabels(draft)];
    if (selectedOptions.length === 0 && !customInput) return null;
    const note = supportsNote ? normalizeDraftAnswer(draft?.note) : null;
    answers[question.id] = {
      selectedOptions,
      ...(customInput ? { customInput } : {}),
      ...(note ? { note } : {}),
    };
  }

  return answers;
}

export function buildThreadFeed(
  thread: OrchestrationThread,
  options?: {
    readonly loadedMessages?: ReadonlyArray<OrchestrationThread["messages"][number]>;
    readonly localMessages?: ReadonlyArray<OrchestrationThread["messages"][number]>;
  },
): ThreadFeedEntry[] {
  const loadedMessages = options?.loadedMessages ?? thread.messages;
  const messages = options?.localMessages
    ? [...loadedMessages, ...options.localMessages]
    : loadedMessages;
  const oldestLoadedMessageCreatedAt =
    options?.loadedMessages !== undefined ? (loadedMessages[0]?.createdAt ?? null) : null;
  const checkpointTurnCountByAssistantMessageId = new Map(
    thread.checkpoints
      .filter(
        (checkpoint) => checkpoint.status === "ready" && checkpoint.assistantMessageId !== null,
      )
      .map(
        (checkpoint) => [checkpoint.assistantMessageId!, checkpoint.checkpointTurnCount] as const,
      ),
  );
  const checkpointTurnCountByUserMessageId = new Map<string, number>();
  for (let index = 0; index < loadedMessages.length; index += 1) {
    const message = loadedMessages[index];
    if (!message || message.role !== "user") continue;
    for (let nextIndex = index + 1; nextIndex < loadedMessages.length; nextIndex += 1) {
      const nextMessage = loadedMessages[nextIndex];
      if (!nextMessage || nextMessage.role === "user") break;
      const checkpointTurnCount = checkpointTurnCountByAssistantMessageId.get(nextMessage.id);
      if (checkpointTurnCount === undefined) continue;
      checkpointTurnCountByUserMessageId.set(message.id, Math.max(0, checkpointTurnCount - 1));
      break;
    }
  }
  const workLogEntries = deriveWorkLogEntries(thread.activities);
  const entries = Arr.sortWith(
    [
      ...messages.map<RawThreadFeedEntry>((message) => ({
        type: "message",
        id: message.id,
        createdAt: message.createdAt,
        message,
        ...(message.role === "user" && checkpointTurnCountByUserMessageId.has(message.id)
          ? { checkpointTurnCount: checkpointTurnCountByUserMessageId.get(message.id)! }
          : {}),
      })),
      ...workLogEntries
        .filter((entry) => {
          if (options?.loadedMessages === undefined) {
            return true;
          }
          return (
            oldestLoadedMessageCreatedAt === null || entry.createdAt >= oldestLoadedMessageCreatedAt
          );
        })
        .map<RawThreadFeedEntry>((entry) => {
          const summary = workEntryHeading(entry);
          const detail = workEntryPreview(entry);
          const getFullDetail = memoizeValue(() => buildWorkEntryExpandedBody(entry));
          const getCopyText = memoizeValue(() =>
            [summary, detail, getFullDetail()]
              .filter((value, index, values): value is string => {
                return Boolean(value) && values.indexOf(value) === index;
              })
              .join("\n"),
          );
          return {
            type: "activity",
            id: entry.id,
            createdAt: entry.createdAt,
            turnId: entry.turnId,
            activity: {
              id: entry.id,
              createdAt: entry.createdAt,
              turnId: entry.turnId,
              summary,
              detail,
              canExpand: workEntryHasExpandedBody(entry),
              getFullDetail,
              getCopyText,
              icon: workEntryIcon(entry),
              toolLike: workLogEntryIsToolLike(entry),
              status: workEntryStatus(entry),
            },
          };
        }),
    ],
    (s) => new Date(s.createdAt),
    Order.Date,
  );

  return groupAdjacentActivities(entries);
}
