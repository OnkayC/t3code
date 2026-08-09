import type { ProviderInteractionMode } from "@t3tools/contracts";

export interface InteractionModePresentation {
  readonly label: string;
  readonly description: string;
}

const INTERACTION_MODE_PRESENTATION: Record<ProviderInteractionMode, InteractionModePresentation> =
  {
    default: {
      label: "Build",
      description: "Build normally with the selected provider.",
    },
    plan: {
      label: "Plan",
      description: "Plan the work before execution.",
    },
    "plan-paused": {
      label: "Plan paused",
      description: "Plan execution is paused. Resume planning or return to build mode.",
    },
  };

export function getInteractionModePresentation(
  mode: ProviderInteractionMode,
): InteractionModePresentation {
  return INTERACTION_MODE_PRESENTATION[mode];
}

export function buildInteractionModeOptions(
  supportedModes: ReadonlyArray<ProviderInteractionMode>,
): ReadonlyArray<InteractionModePresentation & { readonly value: ProviderInteractionMode }> {
  return supportedModes.map((value) => ({
    value,
    ...getInteractionModePresentation(value),
  }));
}

export function nextInteractionMode(
  currentMode: ProviderInteractionMode,
  supportedModes: ReadonlyArray<ProviderInteractionMode>,
): ProviderInteractionMode {
  if (supportedModes.length === 0) return currentMode;
  const currentIndex = supportedModes.indexOf(currentMode);
  return supportedModes[(currentIndex + 1) % supportedModes.length] ?? currentMode;
}
