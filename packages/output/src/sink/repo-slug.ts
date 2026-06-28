/**
 * repoSlugFromIdentity — derive an `<org>/<repo>` slug from a {@link RepoIdentity}
 * for the `x-opensip-repo` cloud-handoff header (DEC-587 / DEC-588).
 *
 * OpenSIP Cloud reads `x-opensip-repo` as a free-form `<org>/<repo>` attribution
 * label (255-capped) used to scope ingested signals within the caller's tenant.
 * The OSS side resolves a {@link RepoIdentity} via `resolveRepoIdentity(cwd)`,
 * whose `remoteUrl` is the raw `git config --get remote.origin.url` output
 * (`git@github.com:org/repo.git`, `https://github.com/org/repo.git`, `ssh://…`,
 * etc.). This pure helper turns that into the slug.
 *
 * It NEVER throws and returns `undefined` when nothing parses — a repo-less
 * upload is a soft accept cloud-side (DEC-588), so an unparseable remote simply
 * omits the header rather than failing the run.
 *
 * Deliberately NOT merged with the OTel `repo_key` telemetry label
 * (`opensip.repo_key`): same shape, different invariants and sinks — the wire
 * header value must not couple to the telemetry attribute.
 */

import type { RepoIdentity } from '@opensip-cli/core';

/** A bare `<org>/<repo>` slug: two non-empty, slash-free segments. */
const SLUG_RE = /^[^/\s]+\/[^/\s]+$/;

function trimSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '/') start++;
  while (end > start && value[end - 1] === '/') end--;
  return value.slice(start, end);
}

/**
 * Extract the last two path segments (`org/repo`) from a git remote URL,
 * handling both scp-style (`git@host:org/repo`) and URL-style
 * (`scheme://host/org/repo`) remotes and stripping a trailing `.git`.
 */
function slugFromRemoteUrl(remoteUrl: string): string | undefined {
  let s = remoteUrl.trim();
  if (s.length === 0) return undefined;

  // Strip a trailing `.git` (case-insensitive) and any trailing slash.
  s = trimSlashes(s);
  s = s.replace(/\.git$/i, '');

  // Normalize scp-style `git@host:org/repo` → the `org/repo` tail. The colon
  // separates host from path; for URL-style remotes there is no bare `host:path`
  // colon (the `://` is handled below), so only split on the FIRST `:` that is
  // not part of a scheme.
  // Drop any `scheme://` prefix first.
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  // Drop user@ credentials prefix (e.g. `git@github.com:...`).
  // For scp form the path is after the first ':'.
  const colonIdx = s.indexOf(':');
  const slashIdx = s.indexOf('/');
  if (colonIdx !== -1 && (slashIdx === -1 || colonIdx < slashIdx)) {
    // scp-style: everything after the first colon is the path.
    s = s.slice(colonIdx + 1);
  } else {
    // URL-style (host already stripped of scheme): drop the leading host segment.
    const firstSlash = s.indexOf('/');
    if (firstSlash !== -1) s = s.slice(firstSlash + 1);
  }

  s = trimSlashes(s);
  if (s.length === 0) return undefined;

  const segments = s.split('/').filter((seg) => seg.length > 0);
  if (segments.length < 2) return undefined;

  const slug = segments.slice(-2).join('/');
  return SLUG_RE.test(slug) ? slug : undefined;
}

/**
 * Derive an `<org>/<repo>` slug from a {@link RepoIdentity}, or `undefined` when
 * none can be parsed. Prefers an explicit `id` that already looks like a slug;
 * otherwise parses `remoteUrl`. Pure, never throws.
 */
export function repoSlugFromIdentity(repo: RepoIdentity): string | undefined {
  if (repo.id !== undefined) {
    const id = repo.id.trim();
    if (SLUG_RE.test(id)) return id;
  }
  if (repo.remoteUrl !== undefined) {
    return slugFromRemoteUrl(repo.remoteUrl);
  }
  return undefined;
}
