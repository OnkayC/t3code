// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import { OMP_REQUIRED_SEMANTIC_CAPABILITIES, makeOmpRpcRuntime } from "./OmpRpcRuntime.ts";

const binaryPath = process.env.OMP_RPC_BINARY;

it.live.skipIf(!binaryPath)(
  "negotiates the full native OMP profile and exercises metadata, plan, and host-turn commands",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stateRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-omp-compat-"));
        const sessionDir = NodePath.join(stateRoot, "sessions");
        NodeFS.mkdirSync(sessionDir, { recursive: true });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(stateRoot, { recursive: true, force: true })),
        );

        const runtime = yield* makeOmpRpcRuntime({
          binaryPath: binaryPath!,
          args: ["--mode", "rpc-ui", "--session-dir", sessionDir, "--no-title"],
          cwd: stateRoot,
          env: { ...process.env, PI_NO_TITLE: "1" },
          capabilities: OMP_REQUIRED_SEMANTIC_CAPABILITIES,
          startupTimeoutMs: 30_000,
          requestTimeoutMs: 30_000,
        });

        expect(runtime.protocolVersion).toBe(2);
        expect(runtime.capabilities).toEqual(OMP_REQUIRED_SEMANTIC_CAPABILITIES);

        const oversizedState = yield* runtime.request<{ planMode?: { status?: string } }>({
          id: `oversized-${"δ".repeat(600_000)}`,
          type: "get_state",
        });
        expect(oversizedState.planMode?.status).toBe("off");

        const policy = yield* runtime.request<{ approvalMode: string }>({
          type: "set_runtime_policy",
          approvalMode: "always-ask",
        });
        expect(policy.approvalMode).toBe("always-ask");

        const auth = yield* runtime.request<{ providers: ReadonlyArray<unknown> }>({
          type: "get_auth_status",
        });
        expect(Array.isArray(auth.providers)).toBe(true);

        const models = yield* runtime.request<{ models: ReadonlyArray<unknown> }>({
          type: "get_available_models",
        });
        const skills = yield* runtime.request<{ skills: ReadonlyArray<unknown> }>({
          type: "get_available_skills",
        });
        const commands = yield* runtime.request<{ commands: ReadonlyArray<unknown> }>({
          type: "get_available_commands",
        });
        expect(Array.isArray(models.models)).toBe(true);
        expect(Array.isArray(skills.skills)).toBe(true);
        expect(Array.isArray(commands.commands)).toBe(true);

        const active = yield* runtime.request<{ status: string; workflow?: string }>({
          type: "set_plan_mode",
          status: "active",
          workflow: "parallel",
        });
        expect(active).toMatchObject({ status: "active", workflow: "parallel" });
        expect(yield* runtime.request({ type: "set_plan_mode", status: "paused" })).toMatchObject({
          status: "paused",
        });
        expect(yield* runtime.request({ type: "set_plan_mode", status: "off" })).toMatchObject({
          status: "off",
        });

        const turns = yield* runtime.request<{ turns: ReadonlyArray<unknown> }>({
          type: "get_turns",
        });
        expect(turns.turns).toEqual([]);

        const rollback = yield* Effect.exit(
          runtime.request({
            type: "rollback_turns",
            count: 1,
            expectedClientTurnIds: ["missing-turn"],
          }),
        );
        expect(rollback._tag).toBe("Failure");

        const state = yield* runtime.request<{ planMode?: { status?: string } }>({
          type: "get_state",
        });
        expect(state.planMode?.status).toBe("off");
      }),
    ),
);
