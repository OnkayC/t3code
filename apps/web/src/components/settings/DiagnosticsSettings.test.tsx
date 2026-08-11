import type { ServerProcessDiagnosticsEntry } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ProcessDiagnosticsTable } from "./DiagnosticsSettings";

function processEntry(pid: number): ServerProcessDiagnosticsEntry {
  return {
    pid,
    startTimeMs: 1,
    ppid: 1,
    pgid: Option.none(),
    status: "running",
    cpuPercent: 0,
    rssBytes: 1024,
    elapsed: "1s",
    command: `sleep ${pid}`,
    depth: 0,
    childPids: [],
  };
}

describe("ProcessDiagnosticsTable", () => {
  it("disables every signal action while one signal request is pending", () => {
    const markup = renderToStaticMarkup(
      <ProcessDiagnosticsTable
        processes={[processEntry(101), processEntry(202)]}
        signalingPid={101}
        onSignal={vi.fn()}
      />,
    );

    expect(markup).toMatch(
      /<button(?=[^>]*aria-label="Send SIGINT to process 101")(?=[^>]*disabled="")[^>]*>/,
    );
    expect(markup).toMatch(
      /<button(?=[^>]*aria-label="Send SIGKILL to process 101")(?=[^>]*disabled="")[^>]*>/,
    );
    expect(markup).toMatch(
      /<button(?=[^>]*aria-label="Send SIGINT to process 202")(?=[^>]*disabled="")[^>]*>/,
    );
    expect(markup).toMatch(
      /<button(?=[^>]*aria-label="Send SIGKILL to process 202")(?=[^>]*disabled="")[^>]*>/,
    );
  });
});
