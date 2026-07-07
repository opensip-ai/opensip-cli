const SEMVER_RE = /\b(v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/u;

export function parseFirstSemver(raw: string): string | undefined {
  const match = SEMVER_RE.exec(raw);
  if (match?.[1] === undefined) return undefined;
  return match[1].startsWith('v') ? match[1].slice(1) : match[1];
}
