/**
 * plugin/domain-resolution — pure validation + routing logic for the
 * `<tool> plugin add/remove/sync` commands.
 *
 * Extracted from `commands/plugin.ts` to keep that file focused on the
 * command bodies. Everything here decides WHICH host dir / domain a pack
 * targets — no install. The plugin-supporting domains are NOT hardcoded:
 * they come from the registered tools' `pluginLayout` descriptors (threaded
 * in as `PluginLayout[]`), so the kernel stays tool-agnostic and the tools
 * remain the single source of truth (ADR-0009 corollary 1). The pack ops are
 * mounted under each pack-supporting tool primary (`opensip fit plugin …`),
 * so the domain is bound from the tool rather than a `--domain` flag.
 */

import { type PluginLayout } from '@opensip-cli/core';

/**
 * Pseudo-domain for full Tool plugins (whole subcommands). Distinct from
 * the fit/sim plugin DOMAINS (which are project-committed + listed in
 * `plugins.<domain>` config): a Tool plugin auto-discovers by its
 * `opensipTools.kind: "tool"` marker, needs NO config entry, and installs
 * user-global by default (`~/.opensip-cli/plugins/tool`) so the
 * subcommand is available in every project — or project-local
 * (`.runtime/plugins/tool`) with `--project`.
 *
 * Whole Tool plugins are managed by `opensip tools {install,uninstall,…}`
 * (NOT the per-tool `plugin` group); this constant is the shared host-dir
 * segment those commands resolve against.
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
 * construction outside opensip-cli/.runtime/.
 */
export function resolveDomain(
  override: string | undefined,
  packageName: string,
  domains: readonly string[],
): string | undefined {
  if (override === undefined) return inferDomain(packageName, domains);
  return domains.includes(override) ? override : undefined;
}
