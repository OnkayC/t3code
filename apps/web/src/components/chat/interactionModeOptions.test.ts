import { describe, expect, it } from "vite-plus/test";

import {
  buildInteractionModeOptions,
  getInteractionModePresentation,
  nextInteractionMode,
} from "./interactionModeOptions";

describe("interaction mode options", () => {
  it("renders every advertised canonical mode in provider order", () => {
    expect(buildInteractionModeOptions(["default", "plan", "plan-paused"])).toEqual([
      expect.objectContaining({ value: "default", label: "Build" }),
      expect.objectContaining({ value: "plan", label: "Plan" }),
      expect.objectContaining({ value: "plan-paused", label: "Plan paused" }),
    ]);
  });

  it("cycles through build, plan, and paused plan modes", () => {
    const supported = ["default", "plan", "plan-paused"] as const;

    expect(nextInteractionMode("default", supported)).toBe("plan");
    expect(nextInteractionMode("plan", supported)).toBe("plan-paused");
    expect(nextInteractionMode("plan-paused", supported)).toBe("default");
  });

  it("presents a cross-device paused thread as paused rather than build mode", () => {
    expect(getInteractionModePresentation("plan-paused")).toMatchObject({
      label: "Plan paused",
      description: "Plan execution is paused. Resume planning or return to build mode.",
    });
  });
});
