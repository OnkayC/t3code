import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

interface TestComponentProps {
  children?: ReactNode;
  render?: ReactElement;
  value?: string;
}

vi.mock("../ui/button", () => ({
  Button: ({ children }: TestComponentProps) => <button type="button">{children}</button>,
}));

vi.mock("../ui/menu", () => ({
  Menu: ({ children }: TestComponentProps) => <div>{children}</div>,
  MenuPopup: ({ children }: TestComponentProps) => <div>{children}</div>,
  MenuRadioGroup: ({ children }: TestComponentProps) => <div>{children}</div>,
  MenuRadioItem: ({ children, value }: TestComponentProps) => (
    <div data-value={value}>{children}</div>
  ),
  MenuSeparator: () => <hr />,
  MenuTrigger: ({ children, render }: TestComponentProps) => (
    <div>
      {render}
      {children}
    </div>
  ),
}));

import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";

describe("CompactComposerControlsMenu", () => {
  it("only renders runtime modes supported by the selected provider", () => {
    const markup = renderToStaticMarkup(
      <CompactComposerControlsMenu
        interactionMode="default"
        runtimeMode="approval-required"
        supportedInteractionModes={["default"]}
        supportedPlanWorkflows={[]}
        supportedRuntimeModes={["approval-required", "auto-accept-edits", "full-access"]}
        onInteractionModeChange={() => {}}
        onRuntimeModeChange={() => {}}
      />,
    );

    expect(Array.from(markup.matchAll(/data-value="([^"]+)"/g), (match) => match[1])).toEqual([
      "approval-required",
      "auto-accept-edits",
      "full-access",
    ]);
    expect(markup).not.toContain('data-value="auto"');
  });

  it("renders plan workflows in compact mode", () => {
    const markup = renderToStaticMarkup(
      <CompactComposerControlsMenu
        interactionMode="plan"
        planWorkflow="parallel"
        defaultPlanWorkflow="iterative"
        runtimeMode="approval-required"
        supportedInteractionModes={["default", "plan"]}
        supportedPlanWorkflows={["parallel", "iterative"]}
        supportedRuntimeModes={["approval-required"]}
        onInteractionModeChange={() => {}}
        onRuntimeModeChange={() => {}}
      />,
    );

    expect(markup).toContain("Workflow");
    expect(markup).toContain('data-value="parallel"');
    expect(markup).toContain('data-value="iterative"');
  });
});
