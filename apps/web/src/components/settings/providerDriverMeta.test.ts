import { describe, expect, it } from "vite-plus/test";

import { ProviderDriverKind } from "@t3tools/contracts";
import { OmpIcon } from "../Icons";
import { getDriverOption, PROVIDER_CLIENT_DEFINITIONS } from "./providerDriverMeta";

describe("providerDriverMeta", () => {
  it("registers native OMP as a configurable provider", () => {
    const omp = getDriverOption(ProviderDriverKind.make("omp"));

    expect(omp).toMatchObject({
      value: ProviderDriverKind.make("omp"),
      label: "OMP",
      icon: OmpIcon,
    });
    expect(PROVIDER_CLIENT_DEFINITIONS.filter((entry) => entry.value === "omp")).toHaveLength(1);
  });
});
