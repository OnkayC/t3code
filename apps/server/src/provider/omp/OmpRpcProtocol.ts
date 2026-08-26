// @effect-diagnostics nodeBuiltinImport:off

import * as NodePath from "node:path";

import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as Schema from "effect/Schema";

export const OMP_RPC_MAX_PHYSICAL_BYTES = 1024 * 1024;
export const OMP_RPC_MAX_LOGICAL_BYTES = 128 * 1024 * 1024;
export const OMP_RPC_CHUNK_PAYLOAD_BYTES = 256 * 1024;

export const OmpRpcSemanticCapabilityKey = Schema.Literals([
  "structuredApprovals",
  "runtimePolicy",
  "authStatus",
  "richUserInput",
  "planControl",
  "planReview",
  "hostTurns",
  "modelCatalog",
  "slashCommands",
  "skills",
  "tasks",
  "subagents",
]);
export type OmpRpcSemanticCapabilityKey = typeof OmpRpcSemanticCapabilityKey.Type;
export type OmpRpcSemanticCapabilities = Partial<
  Readonly<Record<OmpRpcSemanticCapabilityKey, number>>
>;

export const OMP_REQUIRED_SEMANTIC_CAPABILITIES = {
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
} as const satisfies Readonly<Record<OmpRpcSemanticCapabilityKey, number>>;

export interface OmpRpcReadyFrame {
  readonly type: "ready";
  readonly protocolVersion: number;
  readonly supportedProtocolVersions?: ReadonlyArray<number>;
  readonly maxFrameBytes?: number;
  readonly maxReassembledFrameBytes?: number;
  readonly capabilities?: OmpRpcSemanticCapabilities;
}

export interface OmpRpcResponseFrame {
  readonly id?: string;
  readonly type: "response";
  readonly command: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
  readonly code?: string;
}

export interface OmpRpcChunkFrame {
  readonly type: "rpc_chunk";
  readonly chunkId: string;
  readonly index: number;
  readonly count: number;
  readonly byteLength: number;
  readonly data: string;
}

export type OmpRpcFrame = Readonly<Record<string, unknown>> & {
  readonly type: string;
};

export type OmpRpcCommand = Readonly<Record<string, unknown>> & {
  readonly type: string;
  readonly id?: string;
};

export interface OmpSessionCursor {
  readonly schemaVersion: 1;
  readonly sessionKey: string;
  readonly sessionId: string;
}

const RESERVED_LONG_FLAGS: Readonly<Record<string, true>> = {
  "--mode": true,
  "--cwd": true,
  "--session-dir": true,
  "--resume": true,
  "--continue": true,
  "--fork": true,
  "--no-session": true,
  "--profile": true,
  "--model": true,
  "--thinking": true,
  "--approval-mode": true,
};

const RESERVED_SHORT_FLAGS: Readonly<Record<string, true>> = {
  "-C": true,
  "-r": true,
  "-c": true,
  "-f": true,
  "-p": true,
  "-m": true,
  "-t": true,
  "-a": true,
};
const PASSTHROUGH_BOOLEAN_FLAGS: Readonly<Record<string, true>> = {
  "--no-title": true,
};

export class OmpLaunchArgsError extends Error {
  readonly argument: string;

  constructor(argument: string, message: string) {
    super(message);
    this.name = "OmpLaunchArgsError";
    this.argument = argument;
  }
}

export function parseAndValidateOmpLaunchArgs(
  launchArgs: string | ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  const args =
    typeof launchArgs === "string" ? tokenizeCliArgs(launchArgs) : [...(launchArgs ?? [])];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (!argument.startsWith("-")) {
      throw new OmpLaunchArgsError(
        argument,
        `OMP launch arguments may not contain positional prompts: ${JSON.stringify(argument)}.`,
      );
    }
    const flag = argument.split("=", 1)[0] ?? argument;
    if (flag in RESERVED_LONG_FLAGS || flag in RESERVED_SHORT_FLAGS) {
      throw new OmpLaunchArgsError(
        argument,
        `OMP launch argument ${JSON.stringify(flag)} is owned by T3 Code.`,
      );
    }
    if (!argument.includes("=") && !(flag in PASSTHROUGH_BOOLEAN_FLAGS)) {
      const next = args[index + 1];
      if (next !== undefined && !next.startsWith("-")) index += 1;
    }
  }
  return args;
}

export function buildOmpInteractiveArgs(input: {
  readonly launchArgs?: string | ReadonlyArray<string>;
  readonly sessionDir: string;
  readonly profile?: string;
  readonly resumePath?: string;
}): ReadonlyArray<string> {
  return [
    ...parseAndValidateOmpLaunchArgs(input.launchArgs),
    "--mode",
    "rpc-ui",
    "--session-dir",
    input.sessionDir,
    ...(input.profile ? ["--profile", input.profile] : []),
    ...(input.resumePath ? ["--resume", input.resumePath] : []),
  ];
}

export function buildOmpProbeArgs(input: {
  readonly launchArgs?: string | ReadonlyArray<string>;
  readonly profile?: string;
}): ReadonlyArray<string> {
  const neutral = parseAndValidateOmpLaunchArgs(input.launchArgs).filter(
    (argument) => argument !== "--no-title",
  );
  return [
    ...neutral,
    "--mode",
    "rpc-ui",
    "--no-session",
    "--no-title",
    ...(input.profile ? ["--profile", input.profile] : []),
  ];
}

const TEXT_GENERATION_STRIPPED_FLAGS: Readonly<Record<string, true>> = {
  "--tools": true,
  "--tool": true,
  "--extensions": true,
  "--extension": true,
  "--skills": true,
  "--skill": true,
  "--rules": true,
  "--rule": true,
  "--hooks": true,
  "--hook": true,
};

export function buildOmpTextGenerationArgs(input: {
  readonly launchArgs?: string | ReadonlyArray<string>;
  readonly profile?: string;
}): ReadonlyArray<string> {
  const neutral = parseAndValidateOmpLaunchArgs(input.launchArgs);
  for (const argument of neutral) {
    const flag = argument.split("=", 1)[0] ?? argument;
    if (flag in TEXT_GENERATION_STRIPPED_FLAGS) {
      throw new OmpLaunchArgsError(
        argument,
        `OMP text generation cannot inherit capability-altering argument ${JSON.stringify(flag)}.`,
      );
    }
  }
  return [
    ...neutral,
    "--mode",
    "rpc",
    "--no-session",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-rules",
    "--approval-mode",
    "yolo",
    ...(input.profile ? ["--profile", input.profile] : []),
  ];
}

export function isFullOmpCapabilityProfile(
  capabilities: OmpRpcSemanticCapabilities | undefined,
): boolean {
  if (!capabilities) return false;
  return Object.entries(OMP_REQUIRED_SEMANTIC_CAPABILITIES).every(
    ([key, revision]) => (capabilities[key as OmpRpcSemanticCapabilityKey] ?? 0) >= revision,
  );
}

export function decodeOmpSessionCursor(value: unknown): OmpSessionCursor | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.sessionKey !== "string" ||
    record.sessionKey.length === 0 ||
    NodePath.isAbsolute(record.sessionKey) ||
    record.sessionKey.includes("\0") ||
    /^[A-Za-z]:/.test(record.sessionKey) ||
    typeof record.sessionId !== "string" ||
    record.sessionId.length === 0
  ) {
    return undefined;
  }
  const normalized = NodePath.posix.normalize(record.sessionKey.replaceAll("\\", "/"));
  if (
    NodePath.posix.isAbsolute(normalized) ||
    NodePath.win32.isAbsolute(record.sessionKey) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    return undefined;
  }
  return { schemaVersion: 1, sessionKey: normalized, sessionId: record.sessionId };
}

export function redactOmpRpcPayload(value: unknown): unknown {
  return redactValue(value, undefined, 0);
}

/** Cap persisted tool activity result payloads well below the 128MiB logical frame ceiling. */
export const OMP_ACTIVITY_RESULT_MAX_CHARS = 32 * 1024;
export const OMP_ACTIVITY_RESULT_TAIL_CHARS = 8 * 1024;

/**
 * Bound a value for activity persistence: keep small values intact, otherwise
 * replace with a compact summary + tail so snapshots cannot retain multi-MiB
 * tool partialResult/result payloads. Redact secrets/paths first so truncated
 * `tail` strings never retain credentials under non-secret keys.
 */
export function boundOmpActivityValue(
  value: unknown,
  maxChars = OMP_ACTIVITY_RESULT_MAX_CHARS,
): unknown {
  if (value === undefined) return undefined;
  const safe = redactOmpRpcPayload(value);
  if (typeof safe === "string") {
    if (safe.length <= maxChars) return safe;
    const tailChars = Math.min(OMP_ACTIVITY_RESULT_TAIL_CHARS, maxChars);
    return {
      truncated: true,
      originalLength: safe.length,
      summary: `truncated string (${safe.length} chars)`,
      tail: safe.slice(-tailChars),
    };
  }
  let json: string;
  try {
    json = JSON.stringify(safe);
  } catch {
    return { truncated: true, summary: "unserializable value" };
  }
  if (json === undefined) {
    return { truncated: true, summary: "unserializable value" };
  }
  if (json.length <= maxChars) return safe;
  const tailChars = Math.min(OMP_ACTIVITY_RESULT_TAIL_CHARS, maxChars);
  return {
    truncated: true,
    originalLength: json.length,
    summary: `truncated value (${json.length} chars)`,
    tail: json.slice(-tailChars),
  };
}

/**
 * Bound a string that must remain a string for schema-typed payloads (e.g.
 * planMarkdown). Unlike boundOmpActivityValue, never returns an object.
 */
export function boundOmpActivityString(
  value: string,
  maxChars = OMP_ACTIVITY_RESULT_MAX_CHARS,
): string {
  const safe = redactOmpRpcPayload(value);
  const text = typeof safe === "string" ? safe : String(safe);
  if (text.length <= maxChars) return text;
  const marker = `\n\n… truncated (${text.length} chars) …\n\n`;
  const tailBudget = Math.max(0, maxChars - marker.length);
  const tailChars = Math.min(OMP_ACTIVITY_RESULT_TAIL_CHARS, tailBudget);
  if (tailChars <= 0) return text.slice(0, maxChars);
  return `${marker}${text.slice(-tailChars)}`;
}

const SECRET_KEY = /(?:secret|token|password|credential|api[_-]?key|authorization|cookie)/i;
const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/;

function redactValue(value: unknown, key: string | undefined, depth: number): unknown {
  if (depth > 64) return "[redacted-depth]";
  if (key && SECRET_KEY.test(key)) return "[redacted-secret]";
  if (typeof value === "string") {
    // Absolute filesystem paths are redacted; relative workspace paths stay so
    // work-log clients can show the files a tool touched.
    if (NodePath.isAbsolute(value) || WINDOWS_ABSOLUTE_PATH.test(value)) {
      return "[redacted-path]";
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, key, depth + 1));
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(record).map(([childKey, childValue]) => [
      childKey,
      redactValue(childValue, childKey, depth + 1),
    ]),
  );
}

export function isOmpRpcFrame(value: unknown): value is OmpRpcFrame {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const type = (value as { readonly type?: unknown }).type;
  return typeof type === "string" && type.length > 0;
}

export function isOmpRpcReadyFrame(value: unknown): value is OmpRpcReadyFrame {
  return (
    isOmpRpcFrame(value) && value.type === "ready" && typeof value.protocolVersion === "number"
  );
}

export function isOmpRpcResponseFrame(value: unknown): value is OmpRpcResponseFrame {
  return (
    isOmpRpcFrame(value) &&
    value.type === "response" &&
    typeof value.command === "string" &&
    typeof value.success === "boolean"
  );
}

export function isOmpRpcChunkFrame(value: unknown): value is OmpRpcChunkFrame {
  return isOmpRpcFrame(value) && value.type === "rpc_chunk";
}
