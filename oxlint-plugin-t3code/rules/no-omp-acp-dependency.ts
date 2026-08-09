import { defineRule } from "@oxlint/plugins";

const OMP_BOUNDARY_FILE: Record<string, true> = {
  "OmpAdapter.ts": true,
  "OmpDriver.ts": true,
  "OmpProvider.ts": true,
  "OmpTextGeneration.ts": true,
};

const isOmpBoundaryFile = (filename: string): boolean => {
  const normalized = filename.replaceAll("\\", "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return (
    normalized.includes("/apps/server/src/provider/omp/") ||
    basename.startsWith("OmpRpc") ||
    OMP_BOUNDARY_FILE[basename] === true
  );
};

const isAcpModule = (source: string): boolean => {
  const normalized = source.replaceAll("\\", "/").toLowerCase();
  if (normalized === "effect-acp" || normalized.startsWith("effect-acp/")) return true;
  return /(?:^|\/)acp(?:\/|$)/u.test(normalized);
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Keep the OMP provider boundary on native JSONL RPC and independent of ACP.",
    },
  },
  createOnce(context) {
    const shouldReportSource = (sourceNode: unknown): boolean => {
      if (!isOmpBoundaryFile(context.filename)) return false;
      if (typeof sourceNode !== "object" || sourceNode === null) return false;
      if (!("type" in sourceNode) || sourceNode.type !== "Literal") return false;
      if (!("value" in sourceNode) || typeof sourceNode.value !== "string") return false;
      return isAcpModule(sourceNode.value);
    };
    const message =
      "OMP integrations must use native OMP RPC/rpc-ui. ACP imports are forbidden at the OMP provider boundary.";

    return {
      ImportDeclaration(node) {
        if (shouldReportSource(node.source)) context.report({ node, message });
      },
      ExportNamedDeclaration(node) {
        if (node.source && shouldReportSource(node.source)) context.report({ node, message });
      },
      ExportAllDeclaration(node) {
        if (shouldReportSource(node.source)) context.report({ node, message });
      },
      ImportExpression(node) {
        if (shouldReportSource(node.source)) context.report({ node, message });
      },
    };
  },
});
