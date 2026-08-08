// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import { TextGenerationError, type ModelSelection, type OmpSettings } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../attachmentStore.ts";

import {
  buildOmpTextGenerationArgs,
  isFullOmpCapabilityProfile,
  OMP_REQUIRED_SEMANTIC_CAPABILITIES,
} from "../provider/omp/OmpRpcProtocol.ts";
import { makeOmpRpcRuntime } from "../provider/omp/OmpRpcRuntime.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const OMP_TEXT_TIMEOUT_MS = 180_000;
const isTextGenerationError = Schema.is(TextGenerationError);

type OmpTextGenerationTerminal =
  | { readonly _tag: "Success" }
  | { readonly _tag: "Failure"; readonly detail: string };

const OMP_TEXT_GENERATION_SUCCESS = {
  _tag: "Success",
} satisfies OmpTextGenerationTerminal;

function ompTextGenerationFailure(detail: string): OmpTextGenerationTerminal {
  return { _tag: "Failure", detail };
}

function modelParts(model: string): { readonly provider?: string; readonly modelId: string } {
  const separator = model.indexOf("/");
  return separator > 0
    ? { provider: model.slice(0, separator), modelId: model.slice(separator + 1) }
    : { modelId: model };
}

function optionValue(
  selection: ModelSelection,
  ids: ReadonlyArray<string>,
): string | boolean | undefined {
  for (const option of selection.options ?? []) {
    if (ids.includes(option.id)) return option.value;
  }
  return undefined;
}

function makeOmpTextGenerationService(
  settings: OmpSettings,
  environment?: NodeJS.ProcessEnv,
  attachmentsDir?: string,
): TextGeneration.TextGeneration["Service"] {
  const materializeImageAttachments = Effect.fn("materializeOmpImageAttachments")(function* (
    operation: "generateBranchName" | "generateThreadTitle",
    attachments: TextGeneration.BranchNameGenerationInput["attachments"],
  ) {
    if (!attachmentsDir || !attachments || attachments.length === 0) return [];
    const images: Array<{
      readonly type: "image";
      readonly data: string;
      readonly mimeType: string;
    }> = [];
    for (const attachment of attachments) {
      if (attachment.type !== "image") continue;
      const path = resolveAttachmentPath({ attachmentsDir, attachment });
      if (!path) continue;
      const data = yield* Effect.tryPromise({
        try: () => NodeFS.promises.readFile(path, "base64"),
        catch: (cause) =>
          new TextGenerationError({
            operation,
            detail: `Failed to read image attachment '${attachment.id}'.`,
            cause,
          }),
      });
      images.push({ type: "image", data, mimeType: attachment.mimeType });
    }
    return images;
  });
  const runOmpJson = <S extends Schema.Top>(input: {
    readonly operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchema: S;
    readonly modelSelection: ModelSelection;
    readonly images?: ReadonlyArray<{
      readonly type: "image";
      readonly data: string;
      readonly mimeType: string;
    }>;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* makeOmpRpcRuntime({
          binaryPath: settings.binaryPath,
          args: buildOmpTextGenerationArgs({
            launchArgs: settings.launchArgs,
            ...(settings.profile ? { profile: settings.profile } : {}),
          }),
          cwd: input.cwd,
          ...(environment ? { env: environment } : {}),
          capabilities: OMP_REQUIRED_SEMANTIC_CAPABILITIES,
          requestTimeoutMs: OMP_TEXT_TIMEOUT_MS,
          startupTimeoutMs: 15_000,
        });
        if (runtime.protocolVersion !== 2 || !isFullOmpCapabilityProfile(runtime.capabilities)) {
          return yield* new TextGenerationError({
            operation: input.operation,
            detail: "Installed OMP does not support the required native RPC capability profile.",
          });
        }

        const model = modelParts(input.modelSelection.model);
        yield* runtime.request({
          type: "set_model",
          ...(model.provider ? { provider: model.provider } : {}),
          modelId: model.modelId,
        });
        const thinking = optionValue(input.modelSelection, [
          "reasoning",
          "effort",
          "thinking",
          "thinkingLevel",
        ]);
        if (typeof thinking === "string") {
          yield* runtime.request({ type: "set_thinking_level", level: thinking });
        }
        const fastMode = optionValue(input.modelSelection, ["fastMode", "fast"]);
        if (typeof fastMode === "boolean") {
          yield* runtime.request({ type: "set_fast_mode", enabled: fastMode });
        }

        const output = yield* Ref.make("");
        const completed = yield* Deferred.make<OmpTextGenerationTerminal>();
        // Subscribe before forking the consumer so prompt/agent_end cannot
        // publish into an empty PubSub (Stream.fromPubSub defers subscribe).
        const notificationSub = yield* runtime.subscribeNotifications;
        yield* Stream.runForEach(Stream.fromSubscription(notificationSub), (frame) => {
          if (frame.type === "message_update") {
            const event = frame.assistantMessageEvent;
            if (event && typeof event === "object" && !Array.isArray(event)) {
              const record = event as Record<string, unknown>;
              if (record.type === "text_delta" && typeof record.delta === "string") {
                return Ref.update(output, (current) => current + record.delta);
              }
            }
          }
          if (frame.type === "agent_end") {
            return Deferred.succeed(
              completed,
              frame.aborted === true
                ? ompTextGenerationFailure("OMP native RPC text generation was aborted.")
                : OMP_TEXT_GENERATION_SUCCESS,
            ).pipe(Effect.asVoid);
          }
          if (frame.type === "t3_runtime_process_exited") {
            return Deferred.succeed(
              completed,
              ompTextGenerationFailure(
                "OMP native RPC text generation process exited before successful completion.",
              ),
            ).pipe(Effect.asVoid);
          }
          if (frame.type === "t3_runtime_error") {
            return Deferred.succeed(
              completed,
              ompTextGenerationFailure(
                "OMP native RPC text generation failed before successful completion.",
              ),
            ).pipe(Effect.asVoid);
          }
          return Effect.void;
        }).pipe(Effect.forkScoped);
        yield* runtime.request({
          type: "prompt",
          message: input.prompt,
          ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
        });
        const completion = yield* Deferred.await(completed).pipe(
          Effect.timeoutOption(OMP_TEXT_TIMEOUT_MS),
        );
        if (Option.isNone(completion)) {
          return yield* new TextGenerationError({
            operation: input.operation,
            detail: "OMP native RPC text generation timed out.",
          });
        }
        if (completion.value._tag === "Failure") {
          return yield* new TextGenerationError({
            operation: input.operation,
            detail: completion.value.detail,
          });
        }
        const rawOutput = (yield* Ref.get(output)).trim();
        if (!rawOutput) {
          return yield* new TextGenerationError({
            operation: input.operation,
            detail: "OMP native RPC text generation returned empty output.",
          });
        }
        const decode = Schema.decodeEffect(Schema.fromJsonString(input.outputSchema));
        return yield* decode(extractJsonObject(rawOutput)).pipe(
          Effect.catchTags({
            SchemaError: (cause) =>
              Effect.fail(
                new TextGenerationError({
                  operation: input.operation,
                  detail: "OMP native RPC text generation returned invalid structured output.",
                  cause,
                }),
              ),
          }),
        );
      }).pipe(
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : normalizeCliError(
                settings.binaryPath,
                input.operation,
                cause,
                "OMP native RPC text generation failed.",
              ),
        ),
      ),
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("OmpTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runOmpJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("OmpTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        changeRequestTemplate: input.changeRequestTemplate,
        policy: input.policy,
      });
      const generated = yield* runOmpJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("OmpTextGeneration.generateBranchName")(function* (input) {
      const images = yield* materializeImageAttachments("generateBranchName", input.attachments);
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runOmpJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchema,
        images,
        modelSelection: input.modelSelection,
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("OmpTextGeneration.generateThreadTitle")(function* (input) {
      const images = yield* materializeImageAttachments("generateThreadTitle", input.attachments);
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });
      const generated = yield* runOmpJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchema,
        images,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizeThreadTitle(generated.title) };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
}

export const makeOmpTextGeneration = Effect.fn("makeOmpTextGeneration")(
  (settings: OmpSettings, environment?: NodeJS.ProcessEnv, attachmentsDir?: string) =>
    Effect.succeed(makeOmpTextGenerationService(settings, environment, attachmentsDir)),
);
