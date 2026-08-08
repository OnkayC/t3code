import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  useColorScheme: () => "light",
}));
vi.mock("react-native-svg", () => ({
  Path: "Path",
  Rect: "Rect",
  Svg: "Svg",
}));
vi.mock("../features/settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "light" }),
}));
vi.mock("./AppSymbol", () => ({
  SymbolView: "SymbolView",
}));

import { ProviderIcon } from "./ProviderIcon";

describe("ProviderIcon", () => {
  it("renders the OMP mark for the omp driver", () => {
    const icon = ProviderIcon({ provider: "omp", size: 20 });

    expect(icon.type).toBe("Svg");
    expect(icon.props.viewBox).toBe("0 0 800 800");
    expect(icon.props.children[0].type).toBe("Rect");
  });

  it("uses a neutral code icon for unknown providers", () => {
    const icon = ProviderIcon({ provider: "future-provider", size: 18 });

    expect(icon.type).toBe("SymbolView");
    expect(icon.props.name).toBe("chevron.left.forwardslash.chevron.right");
    expect(icon.props.size).toBe(18);
  });
});
