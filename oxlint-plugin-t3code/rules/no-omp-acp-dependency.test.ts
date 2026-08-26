import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const ompRuntimeRule = createOxlintRuleHarness("t3code/no-omp-acp-dependency", {
  filename: "OmpRpcRuntime.ts",
});
const ompAdapterRule = createOxlintRuleHarness("t3code/no-omp-acp-dependency", {
  filename: "OmpAdapter.ts",
});
const unrelatedRule = createOxlintRuleHarness("t3code/no-omp-acp-dependency");

describe("t3code/no-omp-acp-dependency", () => {
  ompRuntimeRule.valid(
    "allows native OMP RPC imports",
    `
      import { OmpRpcProtocol } from "./OmpRpcProtocol.ts";
      import { ProviderRuntimeEvent } from "@t3tools/contracts";
    `,
  );

  unrelatedRule.valid(
    "allows ACP imports outside the OMP boundary",
    `
      import { AcpRuntime } from "./apps/server/src/provider/acp/AcpRuntime.ts";
    `,
  );

  ompRuntimeRule.invalid(
    "rejects ACP imports below the OMP runtime directory",
    `
      import { AcpRuntime } from "../acp/AcpRuntime.ts";
    `,
    (output) => {
      assert.match(output, /native OMP RPC/);
    },
  );

  ompAdapterRule.invalid(
    "rejects effect-acp imports from the OMP adapter boundary",
    `
      import * as Acp from "effect-acp";
    `,
  );

  ompAdapterRule.invalid(
    "rejects ACP re-exports from the OMP adapter boundary",
    `
      export { AcpRuntime } from "../acp/AcpRuntime.ts";
    `,
  );
});
