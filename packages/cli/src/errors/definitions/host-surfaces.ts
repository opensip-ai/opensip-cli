/**
 * Host surface failures outside wiring/suite/init — tools, telemetry, runtime
 * inventory, capability workers, session replay, and host-plane/seam guards.
 *
 * Ruling D9: one definition per (responsibility × kind) cluster. Distinguishing
 * detail lives in allowlisted `metadata.condition`, not one code per message.
 */

import { HOST_WIRING, USER_INPUT } from './axes.js';

import type { ErrorDefinition } from '@opensip-cli/core';

/** Tool-author contract breach: public, plugin-incompatible exit. */
const TOOL_AUTHOR_CONTRACT = {
  source: 'application',
  defaultResponsibility: 'tool-author',
  kind: 'validation',
  retry: 'never',
  severity: 'error',
  exposure: 'public',
  exitClass: 'plugin-incompatible',
  stability: 'public',
  lifecycle: 'active',
} as const satisfies Omit<ErrorDefinition, 'owner' | 'code' | 'operatorAction'>;

/** Containment / destructive-boundary refusal (ruling D9 security kind). */
const SECURITY_REFUSAL = {
  source: 'application',
  defaultResponsibility: 'user',
  kind: 'security',
  retry: 'never',
  severity: 'error',
  exposure: 'public',
  exitClass: 'configuration',
  stability: 'public',
  lifecycle: 'active',
} as const satisfies Omit<ErrorDefinition, 'owner' | 'code' | 'operatorAction'>;

export const hostSurfacesDefinitions = {
  /**
   * `tools create` / trust-list edit refuses to mutate opensip-cli.config.yml because the
   * file is not in a shape it can safely modify — too large, malformed YAML, non-map root,
   * `tools` not a map, or `tools.trusted` not a sequence.
   *
   * Same integrity posture as `CLI.SUITE.EDIT_REFUSED`: refuse rather than silently drop
   * content the host did not fully understand.
   */
  'CLI.TOOLS.EDIT_REFUSED': {
    ...USER_INPUT,
    code: 'CLI.TOOLS.EDIT_REFUSED',
    kind: 'integrity',
    operatorAction:
      'opensip cannot safely edit tools.trusted in this config file. Fix the reported problem in opensip-cli.config.yml, or add the trust entry by hand.',
    publicMetadataKeys: ['condition', 'path'],
  },

  /**
   * `npm pack` during tools install did not yield a usable tarball identity (missing
   * package.json name/version and no safe bare .tgz basename on stdout).
   */
  'CLI.TOOLS.PACK_INVALID': {
    ...USER_INPUT,
    code: 'CLI.TOOLS.PACK_INVALID',
    defaultResponsibility: 'environment',
    operatorAction:
      'npm pack did not produce a usable tarball name. Ensure package.json has name and version, and re-run tools install.',
    publicMetadataKeys: ['condition'],
  },

  /**
   * A packed tarball resolved outside the staged package directory — containment refusal.
   */
  'CLI.TOOLS.PACK_CONTAINMENT': {
    ...SECURITY_REFUSAL,
    code: 'CLI.TOOLS.PACK_CONTAINMENT',
    defaultResponsibility: 'environment',
    operatorAction:
      'The npm pack tarball escaped the staged package directory. Re-run tools install; if it persists, report a bug with the package identity.',
    publicMetadataKeys: ['condition'],
  },

  /**
   * CPU-profile artifact paths escaped their containment root, selected directory, or
   * landed on a non-directory component (symlink / file).
   */
  'CLI.PROFILE.CONTAINMENT_REFUSED': {
    ...SECURITY_REFUSAL,
    code: 'CLI.PROFILE.CONTAINMENT_REFUSED',
    operatorAction:
      'The profile artifact path was refused for containment. Choose a directory under a trusted root and re-run with profiling enabled.',
    publicMetadataKeys: ['condition'],
  },

  /**
   * Profile artifact metadata is foreign to the index or fails its directory binding.
   */
  'CLI.PROFILE.ARTIFACT_INVALID': {
    ...USER_INPUT,
    code: 'CLI.PROFILE.ARTIFACT_INVALID',
    kind: 'integrity',
    defaultResponsibility: 'tool-author',
    exitClass: 'runtime',
    operatorAction:
      'Profile artifact metadata failed its integrity check. Capture the run id and report a bug; do not construct profile metadata by hand.',
    publicMetadataKeys: ['condition'],
  },

  /**
   * The inspector profiler stopped without a CPU profile payload.
   */
  'CLI.PROFILE.CAPTURE_FAILED': {
    ...HOST_WIRING,
    code: 'CLI.PROFILE.CAPTURE_FAILED',
    defaultResponsibility: 'environment',
    kind: 'I/O',
    retry: 'caller-policy',
    exposure: 'public',
    operatorAction:
      'CPU profiling failed to capture a profile. Re-run with profiling enabled; if it persists, report a bug with the run id.',
    publicMetadataKeys: ['condition'],
  },

  /**
   * Runtime command inventory rejected a tool or host command-spec shape: missing names,
   * invalid staticHandler descriptors, missing handlers, or non-object specs.
   *
   * Plugin authors reach these when declaring commandSpecs; the message names the path.
   */
  'CLI.RUNTIME_INVENTORY.INVALID': {
    ...TOOL_AUTHOR_CONTRACT,
    code: 'CLI.RUNTIME_INVENTORY.INVALID',
    operatorAction:
      'Correct the commandSpecs / staticHandler shape on the named tool or host command. The message names the field the inventory rejected.',
    publicMetadataKeys: ['condition', 'path', 'tool'],
  },

  /**
   * A host plane method was invoked but this host does not provide that plane (OSS hosts
   * omit governance/audit/entitlements unless configured).
   */
  'CLI.HOST.PLANE_UNAVAILABLE': {
    ...HOST_WIRING,
    code: 'CLI.HOST.PLANE_UNAVAILABLE',
    kind: 'not-found',
    exposure: 'public',
    defaultResponsibility: 'environment',
    // Host deliberately omits the plane (OSS); the operator/tool author can act — not a
    // host wiring bug, so not `runtime`.
    exitClass: 'configuration',
    operatorAction:
      'This host does not provide the requested host plane. Use a host that implements it, or stop calling that plane from the tool.',
    publicMetadataKeys: ['condition', 'plane'],
  },

  /**
   * A data-gathering hook worker attempted an output/render/egress seam it must not use.
   */
  'CLI.HOST.SEAM_DENIED': {
    ...SECURITY_REFUSAL,
    code: 'CLI.HOST.SEAM_DENIED',
    defaultResponsibility: 'tool-author',
    exitClass: 'plugin-incompatible',
    operatorAction:
      'Hook workers may not call host output or render seams. Keep data-gathering hooks free of emit/render/egress calls.',
    publicMetadataKeys: ['condition', 'seam'],
  },

  /**
   * Two tools contributed session-replay handlers for the same tool short id.
   */
  'CLI.SESSION_REPLAY.DUPLICATE': {
    ...TOOL_AUTHOR_CONTRACT,
    code: 'CLI.SESSION_REPLAY.DUPLICATE',
    kind: 'conflict',
    operatorAction:
      'Only one session-replay contribution may claim a tool short id. Remove the duplicate contribution.',
    publicMetadataKeys: ['condition', 'tool'],
  },

  /**
   * External session replay cannot be isolated (missing provenance or dispatcher) and the
   * host refuses to run untrusted replay in-process.
   */
  'CLI.SESSION_REPLAY.ISOLATION_REFUSED': {
    ...TOOL_AUTHOR_CONTRACT,
    code: 'CLI.SESSION_REPLAY.ISOLATION_REFUSED',
    kind: 'security',
    operatorAction:
      'External tool session replay requires provenance and a worker dispatcher. Reinstall the tool or re-run from a project that admitted it.',
    publicMetadataKeys: ['condition', 'tool'],
  },

  /**
   * The host refuses to edit `plugins.<domain>` because the config file is not the shape it must be.
   *
   * Sibling of `CLI.TOOLS.EDIT_REFUSED` and deliberately a separate code: that one governs
   * `tools.trusted`, this one the plugin lists. They fail for the same reasons but name different
   * regions of the file, and an operator fixing one should not be pointed at the other.
   *
   * `USER_INPUT` axes — `exposure: 'public'`, `configuration` exit — because these messages are
   * the most actionable in the file. Each already names the file, the exact region, and the fix
   * ("Fix the syntax error and re-run"); as bare `Error`s all of that was replaced by
   * "The operation failed." for someone whose config file has a typo.
   */
  'CLI.PLUGIN.EDIT_REFUSED': {
    ...USER_INPUT,
    code: 'CLI.PLUGIN.EDIT_REFUSED',
    kind: 'integrity',
    operatorAction:
      'The config file could not be edited: it is missing or malformed at the named region. Fix the file and re-run.',
    publicMetadataKeys: ['condition', 'path', 'domain'],
  },
} as const;
