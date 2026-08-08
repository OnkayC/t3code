import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { OmpDriver } from "./OmpDriver.ts";

const OMP = ProviderDriverKind.make("omp");

describe("OmpDriver", () => {
  it("is a first-party multi-instance driver with native defaults", () => {
    expect(OmpDriver.driverKind).toBe(OMP);
    expect(OmpDriver.metadata).toEqual({ displayName: "OMP", supportsMultipleInstances: true });
    expect(OmpDriver.defaultConfig()).toMatchObject({
      enabled: true,
      binaryPath: "omp",
      launchArgs: "",
    });
    expect(BUILT_IN_DRIVERS.filter((driver) => driver.driverKind === OMP)).toEqual([OmpDriver]);
  });
});
