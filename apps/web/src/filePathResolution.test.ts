import { describe, expect, it } from "vite-plus/test";

import { pickUniqueWorkspacePathSuffixMatch } from "./filePathResolution";

describe("pickUniqueWorkspacePathSuffixMatch", () => {
  it("returns the unique nested path when a project-root-relative open missed", () => {
    expect(
      pickUniqueWorkspacePathSuffixMatch("tools/oke-stg/deployment-image-patch.yaml", [
        { path: "flux/oke-flux/tools/oke-stg/deployment-image-patch.yaml", kind: "file" },
        { path: "flux/oke-flux/tools/oke-prod/deployment-image-patch.yaml", kind: "file" },
        { path: "flux/oke-flux/tools/oke-stg", kind: "directory" },
      ]),
    ).toBe("flux/oke-flux/tools/oke-stg/deployment-image-patch.yaml");
  });

  it("does not guess when multiple files share the same suffix", () => {
    expect(
      pickUniqueWorkspacePathSuffixMatch("deployment-image-patch.yaml", [
        { path: "flux/oke-flux/tools/oke-stg/deployment-image-patch.yaml", kind: "file" },
        { path: "flux/oke-flux/tools/oke-prod/deployment-image-patch.yaml", kind: "file" },
      ]),
    ).toBeNull();
  });

  it("returns null when the requested path already matches a candidate", () => {
    expect(
      pickUniqueWorkspacePathSuffixMatch(
        "flux/oke-flux/tools/oke-stg/deployment-image-patch.yaml",
        [{ path: "flux/oke-flux/tools/oke-stg/deployment-image-patch.yaml", kind: "file" }],
      ),
    ).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(
      pickUniqueWorkspacePathSuffixMatch("tools/missing.yaml", [
        { path: "flux/oke-flux/tools/oke-stg/deployment-image-patch.yaml", kind: "file" },
      ]),
    ).toBeNull();
  });

  it("normalizes windows separators and leading dots", () => {
    expect(
      pickUniqueWorkspacePathSuffixMatch(".\\tools\\oke-stg\\deployment-image-patch.yaml", [
        { path: "flux\\oke-flux\\tools\\oke-stg\\deployment-image-patch.yaml", kind: "file" },
      ]),
    ).toBe("flux/oke-flux/tools/oke-stg/deployment-image-patch.yaml");
  });
});
