import * as NodeBuffer from "node:buffer";
import * as NodeFS from "node:fs";

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_LOGICAL_BYTES = 128 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;
const capabilities = {
  structuredApprovals: 1,
  runtimePolicy: 1,
  authStatus: 1,
  richUserInput: 1,
  planControl: 1,
  planReview: 1,
  hostTurns: 1,
  modelCatalog: 1,
  slashCommands: 1,
  skills: 1,
  tasks: 1,
  subagents: 1,
};

let protocolVersion = 1;
let selectedCapabilities = {};
let inputBuffer = NodeBuffer.Buffer.alloc(0);
let pendingChunks;
let sessionId = process.env.T3_OMP_FIXTURE_SESSION_ID ?? "omp-session-1";
let sessionFile =
  process.env.T3_OMP_FIXTURE_SESSION_FILE ?? "/private/tmp/omp-secret/sessions/session.jsonl";
let approvalMode = "always-ask";
let planMode = { status: "off", reentry: false };
let turnCounter = 0;
let activeTurnId;
const turns = [];
const messages = [];
const queuedFollowUps = [];

if (process.env.T3_OMP_FIXTURE_ARGV_LOG) {
  NodeFS.appendFileSync(
    process.env.T3_OMP_FIXTURE_ARGV_LOG,
    `${JSON.stringify(process.argv.slice(2))}\n`,
  );
}

if (process.env.T3_OMP_FIXTURE_LIFECYCLE_LOG) {
  NodeFS.appendFileSync(process.env.T3_OMP_FIXTURE_LIFECYCLE_LOG, "started\n");
}

if (process.env.T3_OMP_FIXTURE_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => {
    // Stay alive so the host must escalate to SIGKILL after the grace window.
  });
}

function finishActiveTurn() {
  if (!activeTurnId) return;
  const turnId = activeTurnId;
  activeTurnId = undefined;
  emit({ type: "agent_end", clientTurnId: turnId, messages: [] });
  promoteNextFollowUp();
}

function promoteNextFollowUp() {
  const queued = queuedFollowUps.shift();
  if (!queued) return;
  turnCounter += 1;
  activeTurnId = queued.turnId;
  turns.push({
    clientTurnId: queued.turnId,
    sessionId,
    sessionFile,
    entryId: `entry-${turnCounter}`,
    turnOptions: queued.turnOptions,
  });
  messages.push({
    role: "user",
    content: [{ type: "text", text: queued.message }],
    clientTurnId: queued.turnId,
  });
  emit({
    type: "host_turn_promoted",
    clientTurnId: queued.turnId,
    optionFingerprint: queued.optionFingerprint,
    ...(queued.turnOptions?.provider && queued.turnOptions?.modelId
      ? { model: `${queued.turnOptions.provider}/${queued.turnOptions.modelId}` }
      : {}),
    ...(queued.turnOptions?.thinkingLevel
      ? { thinkingLevel: queued.turnOptions.thinkingLevel }
      : {}),
    ...(typeof queued.turnOptions?.fastMode === "boolean"
      ? { fastMode: queued.turnOptions.fastMode }
      : {}),
  });
  emit({ type: "agent_start", clientTurnId: queued.turnId });
  const assistantText = fixtureAssistantText(queued.message);
  emit({ type: "message_start", message: { role: "assistant" } });
  emit({
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent: { type: "text_delta", delta: assistantText },
  });
  const assistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: assistantText }],
    clientTurnId: queued.turnId,
  };
  messages.push(assistantMessage);
  emit({ type: "message_end", message: assistantMessage });
  activeTurnId = undefined;
  emit({ type: "agent_end", clientTurnId: queued.turnId, messages: [] });
  promoteNextFollowUp();
}

function fixtureAssistantText(prompt) {
  if (process.env.T3_OMP_FIXTURE_STRUCTURED_TEXT !== "1") return prompt;
  if (prompt.includes("concise git commit messages")) {
    return JSON.stringify({
      subject: "Update OMP integration",
      body: "",
      branch: "omp-integration",
    });
  }
  if (prompt.includes("source control change request content")) {
    return JSON.stringify({ title: "Add OMP integration", body: "## Summary\n- Native RPC" });
  }
  if (prompt.includes("concise git branch names")) {
    return JSON.stringify({ branch: "omp-integration" });
  }
  return JSON.stringify({ title: "Native OMP Integration" });
}

function emit(frame) {
  const json = JSON.stringify(frame);
  if (protocolVersion !== 2 || NodeBuffer.Buffer.byteLength(json, "utf8") + 1 <= MAX_FRAME_BYTES) {
    process.stdout.write(`${json}\n`);
    return;
  }
  const bytes = NodeBuffer.Buffer.from(json, "utf8");
  if (bytes.byteLength > MAX_LOGICAL_BYTES) throw new Error("fixture frame too large");
  const count = Math.ceil(bytes.byteLength / CHUNK_BYTES);
  const chunkId = `fixture-${Date.now()}-${Math.random()}`;
  for (let index = 0; index < count; index += 1) {
    process.stdout.write(
      `${JSON.stringify({
        type: "rpc_chunk",
        chunkId,
        index,
        count,
        byteLength: bytes.byteLength,
        data: bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString("base64"),
      })}\n`,
    );
  }
}

function respond(command, data) {
  emit({
    id: command.id,
    type: "response",
    command: command.type,
    success: true,
    ...(data === undefined ? {} : { data }),
  });
}

function fail(command, error, code) {
  emit({
    id: command.id,
    type: "response",
    command: command.type,
    success: false,
    error,
    ...(code ? { code } : {}),
  });
}

function decodeChunk(frame) {
  if (!pendingChunks) {
    if (frame.index !== 0) throw new Error("chunk sequence must begin at zero");
    pendingChunks = {
      chunkId: frame.chunkId,
      count: frame.count,
      byteLength: frame.byteLength,
      next: 0,
      chunks: [],
      received: 0,
    };
  }
  if (
    pendingChunks.chunkId !== frame.chunkId ||
    pendingChunks.count !== frame.count ||
    pendingChunks.byteLength !== frame.byteLength ||
    pendingChunks.next !== frame.index
  )
    throw new Error("chunk sequence mismatch");
  const bytes = NodeBuffer.Buffer.from(frame.data, "base64");
  pendingChunks.chunks.push(bytes);
  pendingChunks.received += bytes.byteLength;
  pendingChunks.next += 1;
  if (pendingChunks.next !== pendingChunks.count) return undefined;
  const complete = pendingChunks;
  pendingChunks = undefined;
  if (complete.received !== complete.byteLength) throw new Error("chunk length mismatch");
  return JSON.parse(NodeBuffer.Buffer.concat(complete.chunks).toString("utf8"));
}

function handle(command) {
  if (process.env.T3_OMP_FIXTURE_REQUEST_LOG) {
    NodeFS.appendFileSync(process.env.T3_OMP_FIXTURE_REQUEST_LOG, `${JSON.stringify(command)}\n`);
  }
  switch (command.type) {
    case "negotiate_protocol":
      if (command.protocolVersion !== 2)
        return fail(command, "unsupported protocol", "unsupported_protocol");
      respond(command, {
        protocolVersion: process.env.T3_OMP_FIXTURE_PROTOCOL_MISMATCH === "1" ? 1 : 2,
      });
      protocolVersion = 2;
      return;
    case "negotiate_capabilities": {
      selectedCapabilities = Object.fromEntries(
        Object.entries(command.capabilities ?? {}).filter(
          ([key, revision]) => capabilities[key] >= revision,
        ),
      );
      respond(command, { capabilities: selectedCapabilities });
      return;
    }
    case "echo":
      respond(command, { value: command.value, sequence: command.sequence });
      return;
    case "acknowledge_payload":
      respond(command, { byteLength: command.value.length });
      return;
    case "pause_stdin":
      respond(command, {});
      process.stdin.pause();
      setTimeout(() => process.stdin.resume(), command.durationMs ?? 100);
      return;
    case "accept_images":
      respond(command, { imageCount: Array.isArray(command.images) ? command.images.length : 0 });
      return;
    case "emit_oversized_logical_frame":
      process.stdout.write(
        `${JSON.stringify({
          type: "rpc_chunk",
          chunkId: "oversized-logical-frame",
          index: 0,
          count: 2,
          byteLength: MAX_LOGICAL_BYTES + 1,
          data: "AAAA",
        })}\n`,
      );
      return;
    case "emit_incomplete_chunk":
      process.stdout.write(
        `${JSON.stringify({
          type: "rpc_chunk",
          chunkId: "incomplete-logical-frame",
          index: 0,
          count: 4,
          byteLength: MAX_FRAME_BYTES,
          data: "AAAA",
        })}\n`,
      );
      return;
    case "emit_unknown":
      respond(command, {});
      emit({ type: "future_additive_notification", payload: command.payload ?? null });
      return;
    case "emit_large":
      respond(command, { value: "λ".repeat(command.characters ?? 600000) });
      return;
    case "respond_then_exit": {
      const response = `${JSON.stringify({
        id: command.id,
        type: "response",
        command: command.type,
        success: true,
        data: { value: "z".repeat(command.characters ?? 700_000) },
      })}\n`;
      process.stdout.end(response, () => process.exit(0));
      return;
    }
    case "get_state":
      respond(command, {
        sessionId,
        sessionFile,
        approvalMode,
        model: {
          provider: "fixture",
          id: "fixture-model",
          name: "Fixture model",
          contextWindow: 200000,
        },
        thinkingLevel: "high",
        isStreaming: Boolean(activeTurnId),
        isCompacting: false,
        steeringMode: "all",
        followUpMode: "all",
        interruptMode: "immediate",
        autoCompactionEnabled: true,
        fastModeEnabled: false,
        fastModeActive: false,
        tokensPerSecond: null,
        messageCount: turns.length,
        queuedMessageCount: queuedFollowUps.length,
        todoPhases: [],
        planMode,
        pendingInteractions: [],
      });
      return;
    case "set_runtime_policy":
      approvalMode = command.approvalMode;
      respond(command, { approvalMode });
      return;
    case "set_model":
      respond(command, {
        provider: command.provider,
        id: command.modelId,
        name: command.modelId,
        contextWindow: 200000,
      });
      return;
    case "set_thinking_level":
    case "set_fast_mode":
      respond(
        command,
        command.type === "set_fast_mode"
          ? { enabled: command.enabled, active: command.enabled }
          : undefined,
      );
      return;
    case "prompt": {
      if (command.message === "REJECT_PROMPT") {
        fail(command, "fixture prompt rejection", "fixture_rejected");
        return;
      }
      turnCounter += 1;
      const turnId = command.clientTurnId ?? `fixture-turn-${turnCounter}`;
      activeTurnId = turnId;
      turns.push({ clientTurnId: turnId, sessionId, sessionFile, entryId: `entry-${turnCounter}` });
      messages.push({
        role: "user",
        content: [{ type: "text", text: command.message }],
        clientTurnId: turnId,
      });
      respond(command, { agentInvoked: true, clientTurnId: turnId });
      emit(
        command.message === "IDLESS_START"
          ? { type: "agent_start" }
          : { type: "agent_start", clientTurnId: turnId },
      );
      emit({
        type: "message_start",
        message: { role: "assistant" },
      });
      const assistantText = fixtureAssistantText(command.message);
      if (process.env.T3_OMP_FIXTURE_THINKING_TEXT) {
        emit({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: {
            type: "thinking_delta",
            delta: process.env.T3_OMP_FIXTURE_THINKING_TEXT,
          },
        });
      }
      emit({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_delta", delta: assistantText },
      });
      const assistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: assistantText }],
        clientTurnId: turnId,
      };
      messages.push(assistantMessage);
      emit({ type: "message_end", message: assistantMessage });
      if (process.env.T3_OMP_FIXTURE_TEXT_TERMINAL === "aborted") {
        emit({ type: "agent_end", clientTurnId: turnId, aborted: true, messages: [] });
        activeTurnId = undefined;
        return;
      }
      if (process.env.T3_OMP_FIXTURE_TEXT_TERMINAL === "crash") {
        process.stdout.end(() => process.exit(17));
        return;
      }
      if (command.message === "TRIGGER_APPROVAL") {
        emit({
          type: "approval_request",
          id: "approval-1",
          sessionId,
          toolCallId: "tool-approval-1",
          toolName: "bash",
          approvalMode,
          tier: "exec",
          arguments: { command: "printf fixture" },
          reason: "Fixture approval",
          details: ["Executes a command"],
          providerSafetyChecks: [],
          allowedDecisions: ["approve_once", "approve_session", "deny", "cancel"],
        });
        return;
      }
      if (command.message === "TRIGGER_ASK") {
        emit({
          type: "extension_ui_request",
          id: "ask-1",
          method: "ask",
          timeout: 30000,
          questions: [
            {
              id: "target",
              header: "Targets",
              question: "Which targets?",
              options: [
                { label: "Web", preview: "apps/web" },
                { label: "Mobile", preview: "apps/mobile" },
              ],
              multi: true,
              recommended: 0,
              allowCustom: true,
            },
          ],
        });
        return;
      }
      if (command.message === "TRIGGER_PLAN_REVIEW") {
        finishActiveTurn();
        emit({
          type: "plan_review_request",
          id: "review-1",
          title: "Fixture plan",
          path: "/private/tmp/fixture-plan.md",
          planArtifactId: "fixture-plan",
          markdown: "# Fixture plan",
          allowedContextStrategies: ["fresh", "preserve", "compact"],
          contextUsage: { tokens: 1000, contextWindow: 200000 },
          executionModels: [
            { provider: "fixture", modelId: "fixture-model", thinkingLevel: "high" },
          ],
          defaultExecutionModel: {
            provider: "fixture",
            modelId: "fixture-model",
            thinkingLevel: "high",
          },
        });
        return;
      }
      finishActiveTurn();
      return;
    }
    case "follow_up": {
      if (command.message === "REJECT_FOLLOW_UP") {
        fail(command, "fixture follow-up rejection", "fixture_rejected");
        return;
      }
      const turnId =
        command.clientTurnId ?? `fixture-turn-${turnCounter + queuedFollowUps.length + 1}`;
      const optionFingerprint = command.optionFingerprint ?? `omp:${turnId}`;
      queuedFollowUps.push({
        turnId,
        message: command.message,
        optionFingerprint,
        turnOptions: command.turnOptions,
      });
      respond(command, { clientTurnId: turnId });
      emit({
        type: "follow_up_queued",
        clientTurnId: turnId,
        optionFingerprint,
        queuePosition: queuedFollowUps.length,
      });
      return;
    }
    case "cancel_follow_up": {
      const turnId = command.clientTurnId;
      if (typeof turnId !== "string" || turnId.length === 0) {
        fail(command, "cancel_follow_up requires clientTurnId", "invalid_request");
        return;
      }
      const index = queuedFollowUps.findIndex((entry) => entry.turnId === turnId);
      if (index < 0) {
        fail(command, "queued follow-up not found", "not_found");
        return;
      }
      queuedFollowUps.splice(index, 1);
      respond(command, { clientTurnId: turnId });
      emit({
        type: "host_turn_cancelled",
        clientTurnId: turnId,
        outcome: "cancelled",
        reason: "cancelled",
      });
      return;
    }
    case "abort":
      respond(command);
      if (activeTurnId)
        emit({ type: "agent_end", clientTurnId: activeTurnId, aborted: true, messages: [] });
      activeTurnId = undefined;
      return;
    case "approval_response":
      emit({
        type: "approval_resolved",
        id: command.id,
        outcome:
          command.decision === "deny"
            ? "denied"
            : command.decision === "cancel"
              ? "cancelled"
              : "accepted",
        decision: command.decision,
      });
      finishActiveTurn();
      return;
    case "extension_ui_response":
      emit({
        type: "extension_ui_resolved",
        id: command.id,
        method: "ask",
        outcome: command.cancelled
          ? "cancelled"
          : command.result?.kind === "chat"
            ? "chat"
            : "submitted",
        ...(command.result ? { result: command.result } : {}),
      });
      finishActiveTurn();
      return;
    case "set_plan_mode":
      planMode = {
        status: command.status,
        ...(command.workflow ? { workflow: command.workflow } : {}),
        ...(command.planFilePath ? { planFilePath: command.planFilePath } : {}),
        reentry: command.status !== "off",
      };
      respond(command, planMode);
      emit({ type: "plan_mode_changed", ...planMode });
      return;
    case "respond_to_plan_review":
      if (command.decision?.context === "preserve") {
        fail(command, "fixture plan response rejection", "fixture_rejected");
        return;
      }
      respond(
        command,
        command.decision.action === "cancel"
          ? {}
          : {
              threadId: "fixture-thread",
              turnId: command.decision.clientTurnId,
              resumeCursor: { schemaVersion: 1, sessionKey: "session.jsonl", sessionId },
            },
      );
      emit({
        type: "plan_review_resolved",
        id: command.requestId,
        outcome:
          command.decision.action === "execute"
            ? "executing"
            : command.decision.action === "refine"
              ? "refining"
              : "cancelled",
        ...(command.decision.clientTurnId ? { clientTurnId: command.decision.clientTurnId } : {}),
      });
      return;
    case "get_turns":
      respond(command, { turns });
      return;
    case "rollback_turns": {
      if (!Number.isInteger(command.count) || command.count <= 0 || command.count > turns.length)
        return fail(command, "invalid rollback count", "invalid_count");
      const suffix = turns.slice(-command.count).map((turn) => turn.clientTurnId);
      if (JSON.stringify(suffix) !== JSON.stringify(command.expectedClientTurnIds))
        return fail(command, "turn suffix diverged", "divergent_turns");
      turns.splice(turns.length - command.count, command.count);
      respond(command, { turns, state: { sessionId, sessionFile } });
      return;
    }
    case "get_messages_page": {
      const offset = command.cursor ? Number(command.cursor) : 0;
      const limit = Number.isInteger(command.limit) && command.limit > 0 ? command.limit : 256;
      const page = messages.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      respond(command, {
        messages: page,
        totalMessages: messages.length,
        ...(nextOffset < messages.length ? { nextCursor: String(nextOffset) } : {}),
      });
      return;
    }
    case "get_messages":
      respond(command, { messages });
      return;
    case "get_auth_status":
      respond(command, {
        providers: [
          {
            provider: "fixture",
            status: "authenticated",
            accounts: [{ type: "api_key", status: "authenticated", accountId: "redacted" }],
          },
        ],
      });
      return;
    case "get_available_models":
      respond(command, {
        models: [
          {
            provider: "fixture",
            id: "fixture-model",
            name: "Fixture model",
            contextWindow: 200000,
            input: ["text", "image"],
            reasoning: true,
            thinkingEfforts: ["low", "medium", "high"],
            fastModeSupported: true,
          },
        ],
      });
      return;
    case "get_available_commands":
      respond(command, {
        commands: [{ name: "plan", description: "Enter plan mode", source: "builtin" }],
      });
      return;
    case "get_available_skills":
      respond(command, {
        skills: [
          {
            name: "fixture-skill",
            description: "Fixture skill",
            source: "project",
            path: "/private/tmp/secret/skills/fixture/SKILL.md",
          },
        ],
      });
      return;
    case "set_subagent_subscription":
      respond(command, { level: command.level });
      return;
    case "get_subagents":
      respond(command, { subagents: [] });
      return;
    case "never_respond":
      return;
    case "crash":
      process.stderr.write("fixture-secret=/private/tmp/secret/token\n".repeat(2048));
      process.exit(command.code ?? 17);
      return;
    case "malformed":
      process.stdout.write("{not-json}\n");
      return;
    default:
      fail(command, `unknown command: ${command.type}`, "unknown_command");
  }
}

emit({
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: MAX_FRAME_BYTES,
  maxReassembledFrameBytes: MAX_LOGICAL_BYTES,
  capabilities,
});

process.stdin.on("data", (chunk) => {
  inputBuffer = NodeBuffer.Buffer.concat([inputBuffer, chunk]);
  for (;;) {
    const newline = inputBuffer.indexOf(10);
    if (newline < 0) break;
    const line = inputBuffer.subarray(0, newline);
    inputBuffer = inputBuffer.subarray(newline + 1);
    if (line.byteLength === 0) continue;
    try {
      let frame = JSON.parse(line.toString("utf8"));
      if (frame.type === "rpc_chunk") {
        frame = decodeChunk(frame);
        if (!frame) continue;
      } else if (pendingChunks) {
        throw new Error("chunk sequence interrupted");
      }
      handle(frame);
    } catch (error) {
      emit({
        type: "response",
        command: "parse",
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
});

process.stdin.on("end", () => {
  if (process.env.T3_OMP_FIXTURE_LIFECYCLE_LOG) {
    NodeFS.appendFileSync(process.env.T3_OMP_FIXTURE_LIFECYCLE_LOG, "closed\n");
  }
  process.exit(0);
});
