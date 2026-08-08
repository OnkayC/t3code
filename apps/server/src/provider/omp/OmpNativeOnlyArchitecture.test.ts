// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const OMP_NATIVE_MODULES = [
  new URL("../Drivers/OmpDriver.ts", import.meta.url),
  new URL("../Layers/OmpAdapter.ts", import.meta.url),
  new URL("../Layers/OmpProvider.ts", import.meta.url),
  new URL("./OmpRpcRuntime.ts", import.meta.url),
  new URL("./OmpRpcProtocol.ts", import.meta.url),
  new URL("./OmpRuntimeEvents.ts", import.meta.url),
  new URL("../../textGeneration/OmpTextGeneration.ts", import.meta.url),
] as const;

const REPOSITORY_ROOT = new URL("../../../../../", import.meta.url);

function stripComments(source: string): string {
  let state: "code" | "single" | "double" | "template" | "line-comment" | "block-comment" = "code";
  let result = "";

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === "line-comment") {
      if (character === "\n") {
        result += character;
        state = "code";
      }
      continue;
    }
    if (state === "block-comment") {
      if (character === "\n") result += character;
      if (character === "*" && next === "/") {
        state = "code";
        index += 1;
      }
      continue;
    }
    if (state !== "code") {
      result += character;
      if (character === "\\") {
        if (next) {
          result += next;
          index += 1;
        }
      } else if (
        (state === "single" && character === "'") ||
        (state === "double" && character === '"') ||
        (state === "template" && character === "`")
      ) {
        state = "code";
      }
      continue;
    }
    if (character === "/" && next === "/") {
      state = "line-comment";
      index += 1;
    } else if (character === "/" && next === "*") {
      state = "block-comment";
      index += 1;
    } else {
      result += character;
      if (character === "'") state = "single";
      else if (character === '"') state = "double";
      else if (character === "`") state = "template";
    }
  }

  return result;
}

function importedModuleSpecifiers(source: string): ReadonlyArray<string> {
  const uncommented = stripComments(source);
  const patterns = [
    /(?:^|\n)\s*import(?:\s+type)?(?:\s+[\s\S]*?\s+from)?\s*["']([^"']+)["']/gu,
    /(?:^|\n)\s*export(?:\s+type)?\s+(?:\*|\{[\s\S]*?\})\s+from\s*["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']/gu,
  ] as const;
  return patterns.flatMap((pattern) =>
    [...uncommented.matchAll(pattern)].flatMap((match) => (match[1] ? [match[1]] : [])),
  );
}

function resolveLocalModule(specifier: string, importingModule: URL): URL | undefined {
  const resolved = specifier.startsWith(".")
    ? new URL(specifier, importingModule)
    : new URL(import.meta.resolve(specifier));
  if (
    resolved.protocol !== "file:" ||
    !resolved.href.startsWith(REPOSITORY_ROOT.href) ||
    resolved.pathname.includes("/node_modules/") ||
    !resolved.pathname.endsWith(".ts")
  ) {
    return undefined;
  }
  return resolved;
}

function reachableImports(
  roots: ReadonlyArray<URL>,
): ReadonlyArray<{ readonly moduleUrl: URL; readonly specifier: string }> {
  const pending = [...roots];
  const visited = new Set<string>();
  const imports: Array<{ readonly moduleUrl: URL; readonly specifier: string }> = [];

  while (pending.length > 0) {
    const moduleUrl = pending.pop();
    if (!moduleUrl || visited.has(moduleUrl.href)) continue;
    visited.add(moduleUrl.href);

    for (const specifier of importedModuleSpecifiers(NodeFS.readFileSync(moduleUrl, "utf8"))) {
      imports.push({ moduleUrl, specifier });
      const reachableModule = resolveLocalModule(specifier, moduleUrl);
      if (reachableModule) pending.push(reachableModule);
    }
  }

  return imports;
}

describe("OMP native-only architecture", () => {
  it("keeps the OMP driver, adapter, runtime, and text generation independent from ACP", () => {
    for (const { moduleUrl, specifier } of reachableImports(OMP_NATIVE_MODULES)) {
      expect(
        specifier.toLowerCase().includes("acp"),
        `${moduleUrl.pathname} imports ${specifier}`,
      ).toBe(false);
    }
  });
});
