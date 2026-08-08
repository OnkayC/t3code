import { describe, expect, it } from "vite-plus/test";

import {
  decodeOmpSessionCursor,
  OmpLaunchArgsError,
  parseAndValidateOmpLaunchArgs,
} from "./OmpRpcProtocol.ts";

describe("OmpRpcProtocol", () => {
  it("rejects positional prompts after standalone launch flags", () => {
    expect(() => parseAndValidateOmpLaunchArgs(["--no-title", "unexpected prompt"])).toThrow(
      OmpLaunchArgsError,
    );
    expect(parseAndValidateOmpLaunchArgs(["--no-title", "--theme", "dark"])).toEqual([
      "--no-title",
      "--theme",
      "dark",
    ]);
  });

  it("rejects session cursors that normalize to absolute paths", () => {
    expect(
      decodeOmpSessionCursor({ schemaVersion: 1, sessionKey: "\\etc\\passwd", sessionId: "one" }),
    ).toBeUndefined();
    expect(
      decodeOmpSessionCursor({
        schemaVersion: 1,
        sessionKey: "C:\\sessions\\outside.jsonl",
        sessionId: "two",
      }),
    ).toBeUndefined();
    expect(
      decodeOmpSessionCursor({
        schemaVersion: 1,
        sessionKey: "C:..\\outside.jsonl",
        sessionId: "drive-relative",
      }),
    ).toBeUndefined();
    expect(
      decodeOmpSessionCursor({
        schemaVersion: 1,
        sessionKey: "nested\\session.jsonl",
        sessionId: "three",
      }),
    ).toEqual({ schemaVersion: 1, sessionKey: "nested/session.jsonl", sessionId: "three" });
  });
});
