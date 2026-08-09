// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import {
  ProviderDriverKind,
  type OmpSettings,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  buildBooleanOptionDescriptor,
  buildSelectOptionDescriptor,
  parseGenericCliVersion,
  providerModelsFromSettings,
} from "../providerSnapshot.ts";
import {
  buildOmpProbeArgs,
  isFullOmpCapabilityProfile,
  OMP_REQUIRED_SEMANTIC_CAPABILITIES,
  redactOmpRpcPayload,
  type OmpRpcSemanticCapabilities,
} from "../omp/OmpRpcProtocol.ts";
import { makeOmpRpcRuntime, OmpRpcRuntimeError } from "../omp/OmpRpcRuntime.ts";

const DRIVER = ProviderDriverKind.make("omp");
const PROBE_TIMEOUT_MS = 10_000;
const SYSTEM_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const isOmpRpcRuntimeError = Schema.is(OmpRpcRuntimeError);

export interface OmpProviderProbeOptions {
  readonly instanceId: ProviderInstanceId;
  readonly sessionRoot: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly displayName?: string;
  readonly accentColor?: string;
}

interface AuthStatusResponse {
  readonly providers?: unknown;
}

interface ModelsResponse {
  readonly models?: unknown;
}

interface CommandsResponse {
  readonly commands?: unknown;
}

interface SkillsResponse {
  readonly skills?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissingBinaryError(error: unknown, depth = 0): boolean {
  if (depth > 8 || error === null || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  return record.code === "ENOENT" || isMissingBinaryError(record.cause, depth + 1);
}

function probeFailureDiagnostic(error: unknown): Record<string, unknown> {
  if (!isOmpRpcRuntimeError(error)) {
    return { errorTag: "UnknownError", valueType: typeof error };
  }

  const rawCauseCode = isRecord(error.cause) ? readString(error.cause.code) : undefined;
  const causeCode = rawCauseCode && SYSTEM_ERROR_CODE.test(rawCauseCode) ? rawCauseCode : undefined;
  const diagnostic = redactOmpRpcPayload({
    errorTag: error._tag,
    operation: error.operation,
    ...(error.command ? { command: error.command } : {}),
    ...(error.exitCode !== undefined ? { exitCode: error.exitCode } : {}),
    detailLength: error.detail.length,
    ...(causeCode ? { causeCode } : {}),
  });
  return isRecord(diagnostic) ? diagnostic : { errorTag: error._tag };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringArray(value: unknown): ReadonlyArray<string> {
  return Array.isArray(value)
    ? value.flatMap((entry) => (typeof entry === "string" && entry.length > 0 ? [entry] : []))
    : [];
}

function authFromResponse(response: AuthStatusResponse): ServerProviderAuth {
  if (!Array.isArray(response.providers) || response.providers.length === 0) {
    return { status: "unauthenticated", type: "omp" };
  }
  const states = response.providers.flatMap((value) => {
    if (!isRecord(value)) return [];
    const provider = readString(value.provider);
    const status = readString(value.status);
    return status ? [{ provider, status }] : [];
  });
  const authenticated = states.find((entry) => entry.status === "authenticated");
  if (authenticated) {
    return {
      status: "authenticated",
      type: "omp",
      ...(authenticated.provider ? { label: authenticated.provider } : {}),
    };
  }
  if (states.length > 0 && states.every((entry) => entry.status === "unauthenticated")) {
    return { status: "unauthenticated", type: "omp" };
  }
  return { status: "unknown", type: "omp", label: "OMP provider authentication needs attention" };
}

function modelsFromResponse(response: ModelsResponse): ReadonlyArray<ServerProviderModel> {
  if (!Array.isArray(response.models)) return [];
  return response.models.flatMap((value) => {
    if (!isRecord(value)) return [];
    const provider = readString(value.provider);
    const id = readString(value.id);
    if (!provider || !id) return [];
    const thinkingEfforts = readStringArray(value.thinkingEfforts);
    const optionDescriptors = [
      ...(thinkingEfforts.length > 0
        ? [
            buildSelectOptionDescriptor({
              id: "reasoning",
              label: "Reasoning",
              options: thinkingEfforts.map((effort) => ({ value: effort, label: effort })),
            }),
          ]
        : []),
      ...(value.fastModeSupported === true
        ? [
            buildBooleanOptionDescriptor({
              id: "fastMode",
              label: "Fast mode",
              currentValue: false,
            }),
          ]
        : []),
    ];
    const slug = `${provider}/${id}`;
    return [
      {
        slug,
        name: readString(value.name) ?? id,
        subProvider: provider,
        isCustom: false,
        capabilities: optionDescriptors.length > 0 ? { optionDescriptors } : {},
      },
    ];
  });
}

function commandsFromResponse(
  response: CommandsResponse,
): ReadonlyArray<ServerProviderSlashCommand> {
  if (!Array.isArray(response.commands)) return [];
  return response.commands.flatMap((value) => {
    if (!isRecord(value)) return [];
    const name = readString(value.name);
    if (!name) return [];
    const description = readString(value.description);
    return [{ name, ...(description ? { description } : {}) }];
  });
}

function skillsFromResponse(response: SkillsResponse): ReadonlyArray<ServerProviderSkill> {
  if (!Array.isArray(response.skills)) return [];
  return response.skills.flatMap((value) => {
    if (!isRecord(value)) return [];
    const name = readString(value.name);
    if (!name) return [];
    const description = readString(value.description);
    const source = readString(value.source);
    return [
      {
        name,
        displayName: name,
        ...(description ? { description, shortDescription: description } : {}),
        ...(source ? { scope: source } : {}),
        path: `local://omp-skills/${encodeURIComponent(name)}`,
        enabled: true,
      },
    ];
  });
}

function getVersion(
  binaryPath: string,
  environment?: NodeJS.ProcessEnv,
): Effect.Effect<string | null> {
  return Effect.callback<string | null>((resume) => {
    NodeChildProcess.execFile(
      binaryPath,
      ["--version"],
      { env: environment ?? process.env, timeout: 4_000, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error) {
          resume(Effect.succeed(null));
          return;
        }
        resume(Effect.succeed(parseGenericCliVersion(stdout)));
      },
    );
  });
}

function baseSnapshot(input: {
  readonly options: OmpProviderProbeOptions;
  readonly enabled: boolean;
  readonly checkedAt: ServerProvider["checkedAt"];
  readonly installed: boolean;
  readonly version: string | null;
  readonly status: ServerProvider["status"];
  readonly auth: ServerProviderAuth;
  readonly message?: string;
  readonly models?: ReadonlyArray<ServerProviderModel>;
  readonly commands?: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills?: ReadonlyArray<ServerProviderSkill>;
}): ServerProvider {
  return {
    instanceId: input.options.instanceId,
    driver: DRIVER,
    displayName: input.options.displayName ?? "OMP",
    ...(input.options.accentColor ? { accentColor: input.options.accentColor } : {}),
    continuation: { groupKey: `${DRIVER}:instance:${input.options.instanceId}` },
    showInteractionModeToggle: true,
    requiresNewThreadForModelChange: false,
    enabled: input.enabled,
    installed: input.installed,
    version: input.version,
    status: input.enabled ? input.status : "disabled",
    auth: input.auth,
    checkedAt: input.checkedAt,
    ...(input.message ? { message: input.message } : {}),
    availability: "available",
    models: [...(input.models ?? [])],
    slashCommands: [...(input.commands ?? [])],
    skills: [...(input.skills ?? [])],
    supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    supportedInteractionModes: ["default", "plan", "plan-paused"],
    supportedPlanWorkflows: ["parallel", "iterative"],
    defaultPlanWorkflow: "parallel",
    supportedTurnDeliveryModes: ["steer", "follow-up"],
    planReviewContextStrategies: ["fresh", "preserve", "compact"],
    supportsPlanExecutionModelSelection: true,
  };
}

export const checkOmpProviderStatus = Effect.fn("checkOmpProviderStatus")(function* (
  settings: OmpSettings,
  options: OmpProviderProbeOptions,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) {
    return baseSnapshot({
      options,
      enabled: false,
      checkedAt,
      installed: false,
      version: null,
      status: "disabled",
      auth: { status: "unknown", type: "omp" },
    });
  }

  const version = yield* getVersion(settings.binaryPath, options.environment);
  const probed = yield* Effect.result(
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* makeOmpRpcRuntime({
          binaryPath: settings.binaryPath,
          args: buildOmpProbeArgs({
            launchArgs: settings.launchArgs,
            ...(settings.profile ? { profile: settings.profile } : {}),
          }),
          cwd: process.cwd(),
          ...(options.environment ? { env: options.environment } : {}),
          capabilities: OMP_REQUIRED_SEMANTIC_CAPABILITIES,
          startupTimeoutMs: PROBE_TIMEOUT_MS,
          requestTimeoutMs: PROBE_TIMEOUT_MS,
        });
        if (runtime.protocolVersion !== 2 || !isFullOmpCapabilityProfile(runtime.capabilities)) {
          return {
            compatible: false as const,
            capabilities: runtime.capabilities,
          };
        }
        const [auth, models, commands, skills] = yield* Effect.all(
          [
            runtime.request<AuthStatusResponse>({ type: "get_auth_status" }),
            runtime.request<ModelsResponse>({ type: "get_available_models" }),
            runtime.request<CommandsResponse>({ type: "get_available_commands" }),
            runtime.request<SkillsResponse>({ type: "get_available_skills" }),
          ],
          { concurrency: "unbounded" },
        );
        return { compatible: true as const, auth, models, commands, skills };
      }),
    ),
  );

  if (probed._tag === "Failure") {
    const missing = isMissingBinaryError(probed.failure);
    yield* Effect.logWarning("OMP RPC provider probe failed.", {
      instanceId: options.instanceId,
      ...probeFailureDiagnostic(probed.failure),
    });
    return baseSnapshot({
      options,
      enabled: true,
      checkedAt,
      installed: !missing,
      version,
      status: "error",
      auth: { status: "unknown", type: "omp" },
      message: missing ? "OMP executable was not found." : "OMP RPC probe failed.",
    });
  }
  if (!probed.success.compatible) {
    return baseSnapshot({
      options,
      enabled: true,
      checkedAt,
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown", type: "omp" },
      message:
        "Installed OMP is incompatible. Run `omp update` to install full native RPC capability profile revision 1.",
    });
  }
  const auth = authFromResponse(probed.success.auth);
  const discoveredModels = modelsFromResponse(probed.success.models);
  return baseSnapshot({
    options,
    enabled: true,
    checkedAt,
    installed: true,
    version,
    status: auth.status === "unknown" ? "warning" : "ready",
    auth,
    models: providerModelsFromSettings(discoveredModels, settings.customModels, {}),
    commands: commandsFromResponse(probed.success.commands),
    skills: skillsFromResponse(probed.success.skills),
  });
});

export function makePendingOmpProvider(
  settings: OmpSettings,
  options: OmpProviderProbeOptions,
  checkedAt: ServerProvider["checkedAt"],
): ServerProvider {
  return baseSnapshot({
    options,
    enabled: settings.enabled,
    checkedAt,
    installed: false,
    version: null,
    status: "warning",
    auth: { status: "unknown", type: "omp" },
    message: "Checking OMP native RPC capabilities…",
  });
}

export function isFullOmpProfile(capabilities: OmpRpcSemanticCapabilities): boolean {
  return isFullOmpCapabilityProfile(capabilities);
}
