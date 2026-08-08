// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { it } from "@effect/vitest";
import { OmpSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

import { checkOmpProviderStatus } from "./OmpProvider.ts";

const fixture = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../omp/testFixtures/ompRpcConformanceAgent.mjs",
);
const decodeSettings = Schema.decodeSync(OmpSettings);
const decodeArgv = Schema.decodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

it.effect(
  "probes native rpc-ui metadata with the complete capability profile and no ACP mode",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-omp-provider-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
        );
        const argvLog = NodePath.join(tempDir, "argv.ndjson");
        const executable = NodePath.join(tempDir, "omp-fixture");
        NodeFS.writeFileSync(
          executable,
          `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "omp 9.8.7"; exit 0; fi\nexec ${shellQuote(process.execPath)} ${shellQuote(fixture)} "$@"\n`,
          { mode: 0o755 },
        );
        const snapshot = yield* checkOmpProviderStatus(
          decodeSettings({ binaryPath: executable, profile: "work", launchArgs: "--no-title" }),
          {
            instanceId: ProviderInstanceId.make("omp_work"),
            environment: { ...process.env, T3_OMP_FIXTURE_ARGV_LOG: argvLog },
            sessionRoot: NodePath.join(tempDir, "probe-sessions"),
          },
        );

        expect(snapshot).toMatchObject({
          driver: "omp",
          installed: true,
          version: "9.8.7",
          status: "ready",
          auth: { status: "authenticated" },
          supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
          supportedInteractionModes: ["default", "plan", "plan-paused"],
          supportedPlanWorkflows: ["parallel", "iterative"],
          supportedTurnDeliveryModes: ["steer", "follow-up"],
        });
        expect(snapshot.models[0]).toMatchObject({
          slug: "fixture/fixture-model",
          name: "Fixture model",
        });
        expect(snapshot.slashCommands).toEqual([expect.objectContaining({ name: "plan" })]);
        expect(snapshot.skills).toEqual([expect.objectContaining({ name: "fixture-skill" })]);
        const argv = NodeFS.readFileSync(argvLog, "utf8")
          .trim()
          .split("\n")
          .map((line) => decodeArgv(line));
        expect(argv[0]).toEqual([
          "--mode",
          "rpc-ui",
          "--no-session",
          "--no-title",
          "--profile",
          "work",
        ]);
        expect(argv.flat()).not.toContain("acp");
      }),
    ),
);

it.effect("reports a missing binary as installed false without fabricating authentication", () =>
  Effect.scoped(
    checkOmpProviderStatus(decodeSettings({ binaryPath: "/definitely/missing/omp" }), {
      instanceId: ProviderInstanceId.make("omp_missing"),
      sessionRoot: NodePath.join(NodeOS.tmpdir(), "t3-omp-missing"),
    }).pipe(
      Effect.map((snapshot) => {
        expect(snapshot.installed).toBe(false);
        expect(snapshot.status).toBe("error");
        expect(snapshot.auth.status).toBe("unknown");
      }),
    ),
  ),
);

it.effect("keeps raw probe failures out of provider status and logs a sanitized diagnostic", () => {
  const messages: Array<unknown> = [];
  const logCapture = Logger.make<unknown, void>(({ message }) => {
    if (Array.isArray(message)) {
      messages.push(...message);
    } else {
      messages.push(message);
    }
  });

  return Effect.scoped(
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-omp-probe-error-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
      );
      const secret = "omp-probe-secret-sentinel";
      const privatePath = NodePath.join(tempDir, "private", "credentials.json");
      const executable = NodePath.join(tempDir, "omp-failing-fixture");
      NodeFS.writeFileSync(
        executable,
        `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "omp 9.8.7"; exit 0; fi\necho ${shellQuote(`${secret} ${privatePath} configured profile not found`)} >&2\nexit 17\n`,
        { mode: 0o755 },
      );

      const snapshot = yield* checkOmpProviderStatus(decodeSettings({ binaryPath: executable }), {
        instanceId: ProviderInstanceId.make("omp_probe_error"),
        sessionRoot: NodePath.join(tempDir, "probe-sessions"),
      });
      const serializedSnapshot = encodeJson(snapshot);
      const serializedLogs = encodeJson(messages);

      expect(snapshot).toMatchObject({
        installed: true,
        version: "9.8.7",
        status: "error",
        auth: { status: "unknown" },
        message: "OMP RPC probe failed.",
      });
      expect(serializedSnapshot).not.toContain(secret);
      expect(serializedSnapshot).not.toContain(privatePath);
      expect(serializedLogs).not.toContain(secret);
      expect(serializedLogs).not.toContain(privatePath);
      expect(serializedLogs).toContain("OMP RPC provider probe failed.");
      expect(serializedLogs).toContain('"errorTag":"OmpRpcRuntimeError"');
      expect(serializedLogs).toContain('"operation":"process"');
      expect(serializedLogs).toContain('"exitCode":17');
      expect(serializedLogs).toMatch(/"detailLength":\d+/);
    }),
  ).pipe(Effect.provide(Logger.layer([logCapture], { mergeWithExisting: false })));
});
