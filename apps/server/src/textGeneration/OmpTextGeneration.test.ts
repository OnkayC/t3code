// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { it } from "@effect/vitest";
import { OmpSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { expect, vi } from "vite-plus/test";

import { makeOmpTextGeneration } from "./OmpTextGeneration.ts";

const fixture = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../provider/omp/testFixtures/ompRpcConformanceAgent.mjs",
);
const decodeSettings = Schema.decodeSync(OmpSettings);
const decodeArgv = Schema.decodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeRequestLogEntry = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.String,
      images: Schema.optional(
        Schema.Array(
          Schema.Struct({
            type: Schema.Literal("image"),
            data: Schema.String,
            mimeType: Schema.String,
          }),
        ),
      ),
    }),
  ),
);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

it.effect("uses short-lived native rpc processes for all structured text operations", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-omp-text-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
      );
      const attachmentsDir = NodePath.join(tempDir, "attachments");
      NodeFS.mkdirSync(attachmentsDir, { recursive: true });
      const attachmentId = "thread-title-image";
      const attachmentPath = NodePath.join(attachmentsDir, `${attachmentId}.png`);
      NodeFS.writeFileSync(attachmentPath, "image-bytes");
      const readFile = vi.spyOn(NodeFS.promises, "readFile");
      yield* Effect.addFinalizer(() => Effect.sync(() => readFile.mockRestore()));
      const attachments = [
        {
          type: "image",
          id: attachmentId,
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 11,
        },
        {
          type: "image",
          id: "../unresolved",
          name: "unresolved.png",
          mimeType: "image/png",
          sizeBytes: 1,
        },
      ] as const;
      const executable = NodePath.join(tempDir, "omp-fixture");
      NodeFS.writeFileSync(
        executable,
        `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fixture)} "$@"\n`,
        { mode: 0o755 },
      );
      const argvLog = NodePath.join(tempDir, "argv.ndjson");
      const requestLog = NodePath.join(tempDir, "requests.ndjson");
      const modelSelection = {
        instanceId: ProviderInstanceId.make("omp_work"),
        model: "fixture/fixture-model",
        options: [
          { id: "reasoning", value: "high" },
          { id: "fastMode", value: true },
        ],
      } as const;
      const generation = yield* makeOmpTextGeneration(
        decodeSettings({ binaryPath: executable, profile: "work" }),
        {
          ...process.env,
          T3_OMP_FIXTURE_ARGV_LOG: argvLog,
          T3_OMP_FIXTURE_REQUEST_LOG: requestLog,
          T3_OMP_FIXTURE_STRUCTURED_TEXT: "1",
          T3_OMP_FIXTURE_THINKING_TEXT: '{"title":"reasoning must not become output"}',
        },
        attachmentsDir,
      );

      expect(
        yield* generation.generateCommitMessage({
          cwd: tempDir,
          branch: "main",
          stagedSummary: "a.ts",
          stagedPatch: "+change",
          includeBranch: true,
          modelSelection,
        }),
      ).toEqual({ subject: "Update OMP integration", body: "", branch: "feature/omp-integration" });
      expect(
        yield* generation.generatePrContent({
          cwd: tempDir,
          baseBranch: "main",
          headBranch: "omp",
          commitSummary: "change",
          diffSummary: "a.ts",
          diffPatch: "+change",
          modelSelection,
        }),
      ).toEqual({ title: "Add OMP integration", body: "## Summary\n- Native RPC" });
      expect(
        yield* generation.generateBranchName({
          cwd: tempDir,
          message: "Add OMP",
          modelSelection,
          attachments,
        }),
      ).toEqual({ branch: "omp-integration" });
      expect(
        yield* generation.generateThreadTitle({
          cwd: tempDir,
          message: "Add OMP",
          modelSelection,
          attachments,
        }),
      ).toEqual({ title: "Native OMP Integration" });
      expect(readFile).toHaveBeenCalledWith(attachmentPath, "base64");
      const missingAttachmentId = "missing-image";
      const missingAttachmentPath = NodePath.join(attachmentsDir, `${missingAttachmentId}.png`);
      const attachmentError = yield* generation
        .generateBranchName({
          cwd: tempDir,
          message: "Add OMP",
          modelSelection,
          attachments: [
            {
              type: "image",
              id: missingAttachmentId,
              name: "missing.png",
              mimeType: "image/png",
              sizeBytes: 1,
            },
          ],
        })
        .pipe(Effect.flip);
      expect(readFile).toHaveBeenCalledWith(missingAttachmentPath, "base64");
      expect(attachmentError).toMatchObject({
        _tag: "TextGenerationError",
        operation: "generateBranchName",
        detail: `Failed to read image attachment '${missingAttachmentId}'.`,
      });

      const argv = NodeFS.readFileSync(argvLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => decodeArgv(line));
      expect(argv).toHaveLength(4);
      for (const args of argv) {
        expect(args).toEqual([
          "--mode",
          "rpc",
          "--no-session",
          "--no-tools",
          "--no-extensions",
          "--no-skills",
          "--no-rules",
          "--approval-mode",
          "yolo",
          "--profile",
          "work",
        ]);
        expect(args).not.toContain("acp");
      }
      const requests = NodeFS.readFileSync(requestLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => decodeRequestLogEntry(line));
      expect(requests.some((request) => request.type === "set_model")).toBe(true);
      expect(requests.some((request) => request.type === "set_thinking_level")).toBe(true);
      expect(requests.some((request) => request.type === "set_fast_mode")).toBe(true);
      expect(requests.filter((request) => request.images).map((request) => request.images)).toEqual(
        [
          [
            {
              type: "image",
              data: Buffer.from("image-bytes").toString("base64"),
              mimeType: "image/png",
            },
          ],
          [
            {
              type: "image",
              data: Buffer.from("image-bytes").toString("base64"),
              mimeType: "image/png",
            },
          ],
        ],
      );
    }),
  ),
);

it.effect("rejects valid structured output when OMP aborts or crashes before completion", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-omp-text-terminal-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
      );
      const executable = NodePath.join(tempDir, "omp-fixture");
      NodeFS.writeFileSync(
        executable,
        `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fixture)} "$@"\n`,
        { mode: 0o755 },
      );
      const modelSelection = {
        instanceId: ProviderInstanceId.make("omp_work"),
        model: "fixture/fixture-model",
      } as const;

      for (const terminal of ["aborted", "crash"] as const) {
        const generation = yield* makeOmpTextGeneration(
          decodeSettings({ binaryPath: executable }),
          {
            ...process.env,
            T3_OMP_FIXTURE_STRUCTURED_TEXT: "1",
            T3_OMP_FIXTURE_TEXT_TERMINAL: terminal,
          },
        );
        const error = yield* generation
          .generateThreadTitle({ cwd: tempDir, message: "Add OMP", modelSelection })
          .pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "TextGenerationError",
          operation: "generateThreadTitle",
        });
        expect(error.detail).toContain(
          terminal === "aborted" ? "was aborted" : "exited before successful completion",
        );
      }
    }),
  ),
);
