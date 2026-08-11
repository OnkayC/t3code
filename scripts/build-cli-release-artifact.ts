#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { parse, stringify } from "yaml";

import rootPackageJson from "../package.json" with { type: "json" };
import serverPackageJson from "../apps/server/package.json" with { type: "json" };
import {
  createStagePatchedDependencies,
  createStageWorkspaceConfig,
  resolveFffNativeDependencies,
  resourceMonitorExecutableName,
  STAGE_INSTALL_ARGS,
} from "./build-desktop-artifact.ts";
import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";

export type CliReleasePlatform = "mac" | "linux" | "win";
export type CliReleaseArchitecture = "arm64" | "x64";

interface CliReleaseOptions {
  readonly version: string;
  readonly platform: CliReleasePlatform;
  readonly arch: CliReleaseArchitecture;
  readonly resourceMonitorPath: string;
  readonly outputDir: string;
}

const WorkspaceConfigSchema = Schema.Struct({
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  allowBuilds: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
});
interface WorkspaceConfig {
  readonly catalog: Record<string, string>;
  readonly overrides: Record<string, string>;
  readonly patchedDependencies: Record<string, string>;
  readonly allowBuilds: Record<string, boolean>;
}

interface CliStagePackageJson {
  readonly name: "t3code-cli-release";
  readonly version: string;
  readonly private: true;
  readonly packageManager: string;
  readonly engines: typeof serverPackageJson.engines;
  readonly dependencies: Record<string, string>;
}

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

function readWorkspaceConfig(): WorkspaceConfig {
  const workspacePath = NodePath.join(repoRoot, "pnpm-workspace.yaml");
  const decoded = Schema.decodeUnknownSync(WorkspaceConfigSchema)(
    parse(NodeFS.readFileSync(workspacePath, "utf8")),
  );

  return {
    catalog: decoded.catalog ?? {},
    overrides: decoded.overrides ?? {},
    patchedDependencies: decoded.patchedDependencies ?? {},
    allowBuilds: decoded.allowBuilds ?? {},
  };
}

export function cliReleaseOsName(platform: CliReleasePlatform): "linux" | "macos" | "windows" {
  if (platform === "mac") return "macos";
  if (platform === "win") return "windows";
  return "linux";
}

export function cliReleaseResourceKey(
  platform: CliReleasePlatform,
  arch: CliReleaseArchitecture,
): string {
  const runtimePlatform = platform === "mac" ? "darwin" : platform === "win" ? "win32" : "linux";
  return `${runtimePlatform}-${arch}`;
}

export function cliReleaseArchiveName(
  version: string,
  platform: CliReleasePlatform,
  arch: CliReleaseArchitecture,
): string {
  return `t3-cli-${version}-${cliReleaseOsName(platform)}-${arch}.tar.gz`;
}

export function cliReleaseRootName(
  version: string,
  platform: CliReleasePlatform,
  arch: CliReleaseArchitecture,
): string {
  return cliReleaseArchiveName(version, platform, arch).slice(0, -".tar.gz".length);
}

export function renderUnixCliLauncher(): string {
  return `#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$script_dir/../lib/node/node" "$script_dir/../lib/t3/apps/server/dist/bin.mjs" "$@"
`;
}

export function renderWindowsCliLauncher(): string {
  return `@echo off\r
setlocal\r
set "script_dir=%~dp0"\r
"%script_dir%..\\lib\\node\\node.exe" "%script_dir%..\\lib\\t3\\apps\\server\\dist\\bin.mjs" %*\r
`;
}

export function createCliStagePackageJson(input: {
  readonly version: string;
  readonly dependencies: Record<string, string>;
}): CliStagePackageJson {
  return {
    name: "t3code-cli-release",
    version: input.version,
    private: true,
    packageManager: rootPackageJson.packageManager,
    engines: serverPackageJson.engines,
    dependencies: input.dependencies,
  };
}

export function targetMatchesHost(input: {
  readonly platform: CliReleasePlatform;
  readonly arch: CliReleaseArchitecture;
  readonly hostPlatform: NodeJS.Platform;
  readonly hostArch: string;
}): boolean {
  const expectedPlatform =
    input.platform === "mac" ? "darwin" : input.platform === "win" ? "win32" : "linux";
  return input.hostPlatform === expectedPlatform && input.hostArch === input.arch;
}

function requireValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function parsePlatform(value: string): CliReleasePlatform {
  if (value === "mac" || value === "linux" || value === "win") return value;
  throw new Error(`Unsupported CLI release platform '${value}'.`);
}

function parseArchitecture(value: string): CliReleaseArchitecture {
  if (value === "arm64" || value === "x64") return value;
  throw new Error(`Unsupported CLI release architecture '${value}'.`);
}

export function parseCliReleaseOptions(args: readonly string[]): CliReleaseOptions {
  let version: string | undefined;
  let platform: CliReleasePlatform | undefined;
  let arch: CliReleaseArchitecture | undefined;
  let resourceMonitorPath: string | undefined;
  let outputDir = "release-publish";

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--version") version = requireValue(args, index++, flag);
    else if (flag === "--platform") platform = parsePlatform(requireValue(args, index++, flag));
    else if (flag === "--arch") arch = parseArchitecture(requireValue(args, index++, flag));
    else if (flag === "--resource-monitor") resourceMonitorPath = requireValue(args, index++, flag);
    else if (flag === "--output-dir") outputDir = requireValue(args, index++, flag);
    else throw new Error(`Unknown argument '${flag}'.`);
  }

  if (!version) throw new Error("--version is required.");
  if (!platform) throw new Error("--platform is required.");
  if (!arch) throw new Error("--arch is required.");
  if (!resourceMonitorPath) throw new Error("--resource-monitor is required.");

  return { version, platform, arch, resourceMonitorPath, outputDir };
}

function runChecked(
  command: string,
  args: readonly string[],
  options: NodeChildProcess.SpawnSyncOptionsWithStringEncoding,
): string {
  const result = NodeChildProcess.spawnSync(command, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${String(result.status)}.\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function resolveNodeLicensePath(nodeExecutablePath: string): string {
  const executableDirectory = NodePath.dirname(nodeExecutablePath);
  const candidates = [
    NodePath.join(executableDirectory, "LICENSE"),
    NodePath.resolve(executableDirectory, "..", "LICENSE"),
  ];
  const licensePath = candidates.find((candidate) => NodeFS.existsSync(candidate));
  if (!licensePath)
    throw new Error(`Could not find the Node.js LICENSE beside ${nodeExecutablePath}.`);
  return licensePath;
}

function pruneBundledClaudeExecutables(nodeModulesDir: string): void {
  const scopedDirectory = NodePath.join(nodeModulesDir, "@anthropic-ai");
  if (NodeFS.existsSync(scopedDirectory)) {
    for (const entry of NodeFS.readdirSync(scopedDirectory, { withFileTypes: true })) {
      if (entry.name.startsWith("claude-agent-sdk-") && entry.name !== "claude-agent-sdk") {
        NodeFS.rmSync(NodePath.join(scopedDirectory, entry.name), { recursive: true, force: true });
      }
    }
  }

  const pnpmDirectory = NodePath.join(nodeModulesDir, ".pnpm");
  if (NodeFS.existsSync(pnpmDirectory)) {
    for (const entry of NodeFS.readdirSync(pnpmDirectory, { withFileTypes: true })) {
      if (entry.name.startsWith("@anthropic-ai+claude-agent-sdk-")) {
        NodeFS.rmSync(NodePath.join(pnpmDirectory, entry.name), { recursive: true, force: true });
      }
    }
  }
}

function runPackagedCliVersion(releaseRoot: string, platform: CliReleasePlatform): string {
  const launcherPath = NodePath.join(releaseRoot, "bin", platform === "win" ? "t3.cmd" : "t3");
  if (platform === "win") {
    return runChecked("cmd.exe", ["/d", "/s", "/c", `"${launcherPath}" --version`], {
      cwd: releaseRoot,
      encoding: "utf8",
    });
  }
  return runChecked(launcherPath, ["--version"], { cwd: releaseRoot, encoding: "utf8" });
}

function verifyPackagedCliVersion(
  releaseRoot: string,
  platform: CliReleasePlatform,
  version: string,
): void {
  const output = runPackagedCliVersion(releaseRoot, platform).trim();
  if (output !== `t3 v${version}`) {
    throw new Error(`Packaged CLI reported '${output}' instead of 't3 v${version}'.`);
  }
}

function buildCliReleaseArtifact(options: CliReleaseOptions): string {
  if (
    !targetMatchesHost({
      platform: options.platform,
      arch: options.arch,
      hostPlatform: process.platform,
      hostArch: process.arch,
    })
  ) {
    throw new Error(
      `CLI release target ${options.platform}-${options.arch} does not match host ${process.platform}-${process.arch}.`,
    );
  }

  const serverDist = NodePath.join(repoRoot, "apps/server/dist");
  for (const requiredPath of [
    NodePath.join(serverDist, "bin.mjs"),
    NodePath.join(serverDist, "client/index.html"),
    NodePath.resolve(repoRoot, options.resourceMonitorPath),
  ]) {
    if (!NodeFS.existsSync(requiredPath))
      throw new Error(`Missing CLI release input '${requiredPath}'.`);
  }

  const workspaceConfig = readWorkspaceConfig();
  const resolvedServerDependencies = resolveCatalogDependencies(
    serverPackageJson.dependencies,
    workspaceConfig.catalog,
    "apps/server",
  );
  const dependencies = {
    ...resolvedServerDependencies,
    ...resolveFffNativeDependencies(
      options.platform,
      options.arch,
      serverPackageJson.dependencies["@ff-labs/fff-node"],
    ),
  };
  const resolvedOverrides = resolveCatalogDependencies(
    workspaceConfig.overrides,
    workspaceConfig.catalog,
    "pnpm-workspace.yaml#overrides",
  );
  const patchedDependencies = createStagePatchedDependencies(
    workspaceConfig.patchedDependencies,
    dependencies,
  );

  const temporaryRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-cli-release-"));
  const extractionRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-cli-verify-"));
  const rootName = cliReleaseRootName(options.version, options.platform, options.arch);
  const releaseRoot = NodePath.join(temporaryRoot, rootName);
  const appRoot = NodePath.join(releaseRoot, "lib/t3");
  const stagedServerDist = NodePath.join(appRoot, "apps/server/dist");
  const nodeRuntimeDir = NodePath.join(releaseRoot, "lib/node");
  const outputDir = NodePath.resolve(repoRoot, options.outputDir);
  const archivePath = NodePath.join(
    outputDir,
    cliReleaseArchiveName(options.version, options.platform, options.arch),
  );

  try {
    NodeFS.mkdirSync(NodePath.join(releaseRoot, "bin"), { recursive: true });
    NodeFS.mkdirSync(stagedServerDist, { recursive: true });
    NodeFS.mkdirSync(nodeRuntimeDir, { recursive: true });
    NodeFS.cpSync(serverDist, stagedServerDist, { recursive: true });
    NodeFS.copyFileSync(NodePath.join(repoRoot, "LICENSE"), NodePath.join(releaseRoot, "LICENSE"));

    const resourceMonitorName = resourceMonitorExecutableName(options.platform);
    const resourceMonitorDestination = NodePath.join(
      stagedServerDist,
      "resource-monitor",
      cliReleaseResourceKey(options.platform, options.arch),
      resourceMonitorName,
    );
    NodeFS.mkdirSync(NodePath.dirname(resourceMonitorDestination), { recursive: true });
    NodeFS.copyFileSync(
      NodePath.resolve(repoRoot, options.resourceMonitorPath),
      resourceMonitorDestination,
    );
    if (options.platform !== "win") NodeFS.chmodSync(resourceMonitorDestination, 0o755);

    const stagePackageJson = createCliStagePackageJson({ version: options.version, dependencies });
    NodeFS.writeFileSync(
      NodePath.join(appRoot, "package.json"),
      `${JSON.stringify(stagePackageJson, null, 2)}\n`,
    );
    NodeFS.writeFileSync(
      NodePath.join(appRoot, "pnpm-workspace.yaml"),
      stringify(
        createStageWorkspaceConfig({
          platform: options.platform,
          arch: options.arch,
          allowBuilds: workspaceConfig.allowBuilds,
          patchedDependencies,
          overrides: resolvedOverrides,
        }),
      ),
    );
    if (Object.keys(patchedDependencies).length > 0) {
      NodeFS.cpSync(NodePath.join(repoRoot, "patches"), NodePath.join(appRoot, "patches"), {
        recursive: true,
      });
    }

    Effect.runSync(
      Console.log(
        `[cli-release] Installing production dependencies for ${options.platform}-${options.arch}.`,
      ),
    );
    runChecked(process.platform === "win32" ? "vp.cmd" : "vp", STAGE_INSTALL_ARGS, {
      cwd: appRoot,
      encoding: "utf8",
    });
    pruneBundledClaudeExecutables(NodePath.join(appRoot, "node_modules"));

    const nodeExecutablePath = NodeFS.realpathSync(process.execPath);
    const bundledNodeName = options.platform === "win" ? "node.exe" : "node";
    const bundledNodePath = NodePath.join(nodeRuntimeDir, bundledNodeName);
    NodeFS.copyFileSync(nodeExecutablePath, bundledNodePath);
    NodeFS.copyFileSync(
      resolveNodeLicensePath(nodeExecutablePath),
      NodePath.join(nodeRuntimeDir, "LICENSE"),
    );
    if (options.platform !== "win") NodeFS.chmodSync(bundledNodePath, 0o755);

    const launcherPath = NodePath.join(
      releaseRoot,
      "bin",
      options.platform === "win" ? "t3.cmd" : "t3",
    );
    NodeFS.writeFileSync(
      launcherPath,
      options.platform === "win" ? renderWindowsCliLauncher() : renderUnixCliLauncher(),
    );
    if (options.platform !== "win") NodeFS.chmodSync(launcherPath, 0o755);

    NodeFS.mkdirSync(outputDir, { recursive: true });
    NodeFS.rmSync(archivePath, { force: true });
    runChecked("tar", ["-czf", archivePath, "-C", temporaryRoot, rootName], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    runChecked("tar", ["-xzf", archivePath, "-C", extractionRoot], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    verifyPackagedCliVersion(
      NodePath.join(extractionRoot, rootName),
      options.platform,
      options.version,
    );

    Effect.runSync(Console.log(`[cli-release] Verified ${archivePath}`));
    return archivePath;
  } finally {
    NodeFS.rmSync(temporaryRoot, { recursive: true, force: true });
    NodeFS.rmSync(extractionRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  buildCliReleaseArtifact(parseCliReleaseOptions(process.argv.slice(2)));
}
