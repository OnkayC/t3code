import { describe, expect, it, vi } from "vite-plus/test";
import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";

vi.mock("expo-crypto", () => ({
  randomUUID: () => "00000000-0000-4000-8000-000000000000",
}));

import { buildProjectThreadStartTurnInput } from "./projectThreadStartTurn";

const BASE_SPEC = {
  projectId: ProjectId.make("project-1"),
  projectCwd: "/repo",
  threadId: "thread-1",
  commandId: "command-1",
  messageId: "message-1",
  createdAt: "2026-08-08T00:00:00.000Z",
  text: "Implement the feature",
  attachments: [],
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  },
  runtimeMode: "approval-required",
  interactionMode: "plan",
  workflow: "parallel",
  branch: "feature/mobile-workflow",
  worktreePath: "/repo",
  startFromOrigin: false,
  worktreeBranchName: "t3code/mobile-workflow",
} as const;

describe("project thread start turn", () => {
  it("carries the branch and plan workflow for local thread creation", () => {
    const input = buildProjectThreadStartTurnInput({
      ...BASE_SPEC,
      envMode: "local",
    });

    expect(input.workflow).toBe("parallel");
    expect(input.bootstrap.createThread).toMatchObject({
      branch: "feature/mobile-workflow",
      workflow: "parallel",
      worktreePath: "/repo",
    });
    expect(input.bootstrap.prepareWorktree).toBeUndefined();
  });

  it("keeps the creation branch null while preparing a new worktree", () => {
    const input = buildProjectThreadStartTurnInput({
      ...BASE_SPEC,
      envMode: "worktree",
    });

    expect(input.bootstrap.createThread.branch).toBeNull();
    expect(input.bootstrap.createThread.worktreePath).toBeNull();
    expect(input.bootstrap.prepareWorktree).toEqual({
      projectCwd: "/repo",
      baseBranch: "feature/mobile-workflow",
      branch: "t3code/mobile-workflow",
    });
    expect(input.bootstrap.runSetupScript).toBe(true);
  });
});
