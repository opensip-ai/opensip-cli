const SEMVER_RE = /\b(v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/u;

/**
 * Extract the first semver (`X.Y.Z`, with optional prerelease/build) from
 * arbitrary text such as a scanner's `--version` banner. A leading `v` is
 * stripped; returns `undefined` when no semver is found.
 */
export function parseFirstSemver(raw: string): string | undefined {
  const match = SEMVER_RE.exec(raw);
  if (match?.[1] === undefined) return undefined;
  return match[1].startsWith('v') ? match[1].slice(1) : match[1];
}
