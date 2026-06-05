/**
 * plugin/domain-resolution — pure validation + routing logic for the
 * `plugin add/remove/sync` commands.
 *
 * Extracted from `commands/plugin.ts` to keep that file focused on the
 * command bodies. Everything here decides WHICH host dir / domain a spec
 * targets — it reads package markers but performs no install. The
 * plugin-supporting domains are NOT hardcoded: they come from the
 * registered tools' `pluginLayout` descriptors (threaded in as
 * `PluginLayout[]`), so the kernel stays tool-agnostic and the tools
 * remain the single source of truth (ADR-0009 corollary 1).
 */

import { execFileSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';

import { isMarkerKind, readMarkerKind, type MarkerKind, type PluginLayout } from '@opensip-tools/core';

import { extractNameFromSpec } from './host-dir.js';

/**
 * Pseudo-domain for full Tool plugins (whole subcommands). Distinct from
 * the fit/sim plugin DOMAINS (which are project-committed + listed in
 * `plugins.<domain>` config): a Tool plugin auto-discovers by its
 * `opensipTools.kind: "tool"` marker, needs NO config entry, and installs
 * user-global by default (`~/.opensip-tools/plugins/tool`) so the
 * subcommand is available in every project — or project-local
 * (`.runtime/plugins/tool`) with `--project`.
 */
export const TOOL_DOMAIN = 'tool';

/** The set of plugin-supporting domain names from the contributed layouts. */
export function domainNames(layouts: readonly PluginLayout[]): string[] {
  return layouts.map((l) => l.domain);
}

/**
 * Infer a target domain from a package name when --domain is omitted: the
 * first declared domain whose name appears as a word in the package name,
 * else the first declared domain. Domain names come from trusted
 * first-party layouts, so building a RegExp from them is safe.
 */
function inferDomain(packageName: string, domains: readonly string[]): string | undefined {
  const match = domains.find((d) => new RegExp(String.raw`\b${d}\b`).test(packageName));
  return match ?? domains[0];
}

/**
 * Resolve the target domain, rejecting arbitrary strings from --domain.
 * A bare cast would let a caller pass '../../etc' and drive path
 * construction outside opensip-tools/.runtime/.
 */
export function resolveDomain(
  override: string | undefined,
  packageName: string,
  domains: readonly string[],
): string | undefined {
  if (override === undefined) return inferDomain(packageName, domains);
  return domains.includes(override) ? override : undefined;
}

/**
 * Detect a package's `opensipTools.kind` BEFORE installing, so `plugin add`
 * can route a Tool plugin to its host dir rather than a fit/sim domain.
 *
 *  - Local-path specs (`.`/`/`/`file:`): read the target's package.json
 *    directly — free and offline.
 *  - Registry specs: `npm view <name> opensipTools.kind` (one network
 *    call; `plugin add` is already online for the install).
 *
 * Returns undefined when undetectable (offline, private registry, no
 * marker) — the caller then falls back to fit/sim domain inference.
 */
function detectPluginKind(spec: string, cwd: string): MarkerKind | undefined {
  if (spec.startsWith('/') || spec.startsWith('.') || spec.startsWith('file:')) {
    const raw = spec.startsWith('file:') ? spec.slice('file:'.length) : spec;
    return readMarkerKind(isAbsolute(raw) ? raw : join(cwd, raw));
  }
  try {
    const name = extractNameFromSpec(spec) ?? spec;
    const out = execFileSync('npm', ['view', name, 'opensipTools.kind'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return isMarkerKind(out) ? out : undefined;
  } catch {
    // @fitness-ignore-next-line error-handling-quality -- `npm view` failure (offline, private registry, or no such package) means the kind is undetectable; returning undefined routes the caller to fit/sim domain inference — the documented fallback, not a swallowed error.
    return undefined;
  }
}

/**
 * Decide whether `plugin add/remove <spec>` targets a Tool plugin:
 * explicit `--domain tool`, or (when no `--domain` is given) a detected
 * `kind: "tool"` marker. An explicit fit/sim `--domain` is honoured as-is.
 */
export function isToolTarget(domainOverride: string | undefined, spec: string, cwd: string): boolean {
  if (domainOverride === TOOL_DOMAIN) return true;
  if (domainOverride !== undefined) return false;
  return detectPluginKind(spec, cwd) === 'tool';
}
