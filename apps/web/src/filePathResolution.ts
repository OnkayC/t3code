/**
 * When a preview path was opened relative to the project root but the agent
 * meant a nested cwd (e.g. `tools/oke-stg/foo.yaml` under `flux/oke-flux/`),
 * recover by picking the unique workspace path that ends with that suffix.
 *
 * Returns null when zero or multiple candidates match — never guess.
 */
export function pickUniqueWorkspacePathSuffixMatch(
  requestedRelativePath: string,
  candidates: ReadonlyArray<{ readonly path: string; readonly kind?: string }>,
): string | null {
  const normalized = requestedRelativePath
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "");
  if (normalized.length === 0) return null;

  const matches = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.kind !== undefined && candidate.kind !== "file") continue;
    const path = candidate.path.replaceAll("\\", "/").replace(/^\/+/, "");
    if (path.length === 0) continue;
    if (path === normalized || path.endsWith(`/${normalized}`)) {
      matches.add(path);
      if (matches.size > 1) return null;
    }
  }

  if (matches.size !== 1) return null;
  const [match] = matches;
  return match !== undefined && match !== normalized ? match : null;
}
