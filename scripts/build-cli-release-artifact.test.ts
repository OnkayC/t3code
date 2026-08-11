import { assert, it } from "@effect/vitest";

import {
  cliReleaseArchiveName,
  cliStageInstallProcess,
  cliReleaseResourceKey,
  cliReleaseRootName,
  createCliStagePackageJson,
  parseCliReleaseOptions,
  renderUnixCliLauncher,
  renderWindowsCliLauncher,
  targetMatchesHost,
} from "./build-cli-release-artifact.ts";

it("names CLI archives for Mise platform autodetection", () => {
  assert.equal(
    cliReleaseArchiveName("0.0.33-omp", "mac", "arm64"),
    "t3-cli-0.0.33-omp-macos-arm64.tar.gz",
  );
  assert.equal(
    cliReleaseArchiveName("0.0.33-omp", "linux", "x64"),
    "t3-cli-0.0.33-omp-linux-x64.tar.gz",
  );
  assert.equal(
    cliReleaseArchiveName("0.0.33-omp", "win", "x64"),
    "t3-cli-0.0.33-omp-windows-x64.tar.gz",
  );
  assert.equal(cliReleaseRootName("0.0.33-omp", "linux", "x64"), "t3-cli-0.0.33-omp-linux-x64");
});

it("uses the server resource monitor target keys", () => {
  assert.equal(cliReleaseResourceKey("mac", "arm64"), "darwin-arm64");
  assert.equal(cliReleaseResourceKey("linux", "x64"), "linux-x64");
  assert.equal(cliReleaseResourceKey("win", "x64"), "win32-x64");
});

it("renders launchers that resolve the bundled runtime relative to bin", () => {
  const unixLauncher = renderUnixCliLauncher();
  assert.include(unixLauncher, '"$script_dir/../lib/node/node"');
  assert.include(unixLauncher, '"$script_dir/../lib/t3/apps/server/dist/bin.mjs"');
  assert.include(unixLauncher, '"$@"');

  const windowsLauncher = renderWindowsCliLauncher();
  assert.include(windowsLauncher, '"%script_dir%..\\lib\\node\\node.exe"');
  assert.include(windowsLauncher, '"%script_dir%..\\lib\\t3\\apps\\server\\dist\\bin.mjs"');
  assert.include(windowsLauncher, "%*");
});

it("creates a private production dependency stage", () => {
  const stagePackage = createCliStagePackageJson({
    version: "0.0.33-omp",
    dependencies: { effect: "4.0.0-beta.103" },
  });

  assert.equal(stagePackage.name, "t3code-cli-release");
  assert.equal(stagePackage.version, "0.0.33-omp");
  assert.equal(stagePackage.private, true);
  assert.deepStrictEqual(stagePackage.dependencies, { effect: "4.0.0-beta.103" });
});
it("runs the staged install through the Windows command shell", () => {
  assert.deepStrictEqual(cliStageInstallProcess("win32"), { command: "vp", shell: true });
  assert.deepStrictEqual(cliStageInstallProcess("darwin"), { command: "vp", shell: false });
});

it("parses the release workflow CLI contract", () => {
  assert.deepStrictEqual(
    parseCliReleaseOptions([
      "--version",
      "0.0.33-omp",
      "--platform",
      "linux",
      "--arch",
      "x64",
      "--resource-monitor",
      "native/resource-monitor/target/x86_64-unknown-linux-gnu/release/t3-resource-monitor",
      "--output-dir",
      "release-publish",
    ]),
    {
      version: "0.0.33-omp",
      platform: "linux",
      arch: "x64",
      resourceMonitorPath:
        "native/resource-monitor/target/x86_64-unknown-linux-gnu/release/t3-resource-monitor",
      outputDir: "release-publish",
    },
  );
  assert.throws(() => parseCliReleaseOptions([]), /--version is required/u);
  assert.throws(
    () =>
      parseCliReleaseOptions([
        "--version",
        "0.0.33-omp",
        "--platform",
        "freebsd",
        "--arch",
        "x64",
        "--resource-monitor",
        "resource-monitor",
      ]),
    /Unsupported CLI release platform/u,
  );
});

it("only packages the Node runtime for the current matrix host", () => {
  assert.equal(
    targetMatchesHost({
      platform: "mac",
      arch: "arm64",
      hostPlatform: "darwin",
      hostArch: "arm64",
    }),
    true,
  );
  assert.equal(
    targetMatchesHost({
      platform: "linux",
      arch: "x64",
      hostPlatform: "darwin",
      hostArch: "arm64",
    }),
    false,
  );
});
