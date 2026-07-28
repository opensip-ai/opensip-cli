/**
 * External-tool-adapter error definitions (Plan 00 Phase 5 scanner lifecycle).
 */

import { defineErrorCatalog } from '@opensip-cli/core';

/** Substrate catalogs are keyed on the npm package name (ruling D1). */
export const EXTERNAL_TOOL_ERROR_OWNER_ID = '@opensip-cli/external-tool-adapter';

export const externalToolErrorCatalog = defineErrorCatalog(
  {
    // The npm package name, not a short label. A substrate's owner id IS its package name under
    // D1, and the aggregate rejects a contribution whose declared owner disagrees with the name
    // it is registered under — so a short id silently kept this catalog out of the runtime
    // registry, where its codes then resolved to UNKNOWN_FAILURE.
    id: EXTERNAL_TOOL_ERROR_OWNER_ID,
    displayName: '@opensip-cli/external-tool-adapter',
    packageName: EXTERNAL_TOOL_ERROR_OWNER_ID,
  },
  {
    'EXTERNAL.SCANNER.BINARY_MISSING': {
      code: 'EXTERNAL.SCANNER.BINARY_MISSING',
      source: 'external',
      defaultResponsibility: 'operator',
      kind: 'not-found',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'configuration',
      operatorAction:
        'Install the scanner binary, add it to PATH, or set the tool binary path config/env pin.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['tool', 'command', 'layer'],
    },
    'EXTERNAL.SCANNER.SPAWN_FAILED': {
      code: 'EXTERNAL.SCANNER.SPAWN_FAILED',
      source: 'infrastructure',
      defaultResponsibility: 'environment',
      kind: 'I/O',
      retry: 'caller-policy',
      severity: 'error',
      exposure: 'redacted',
      exitClass: 'runtime',
      operatorAction: 'Check binary permissions and OS errno; retry after fixing the environment.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['command', 'errno'],
    },
    'EXTERNAL.SCANNER.KILLED_BY_SIGNAL': {
      code: 'EXTERNAL.SCANNER.KILLED_BY_SIGNAL',
      source: 'infrastructure',
      defaultResponsibility: 'environment',
      kind: 'I/O',
      retry: 'caller-policy',
      severity: 'error',
      exposure: 'redacted',
      exitClass: 'runtime',
      operatorAction:
        'The scanner was killed by an external signal (OOM killer, kill -9, container stop). Check system memory and process limits, then retry.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['command', 'signal'],
    },

    /**
     * An adapter's own declaration is unusable: no commands, or a command with no parser.
     *
     * `tool-author` and `plugin-incompatible` — the adapter author wrote this, and it is caught
     * at definition time, before any scanner runs. One code for both (D9): same author, same
     * file, same fix, with `metadata.field` naming which part.
     */
    'EXTERNAL.ADAPTER.SPEC_INVALID': {
      code: 'EXTERNAL.ADAPTER.SPEC_INVALID',
      source: 'application',
      defaultResponsibility: 'tool-author',
      kind: 'validation',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'plugin-incompatible',
      operatorAction:
        'Declare at least one command on the external tool adapter, and give every command a parser.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['field'],
    },

    /**
     * A scanner adapter needs configuration the project has not supplied — a config file, a
     * dependency source, or a build output directory.
     *
     * `user` and `configuration`: unlike the spec errors above, this is resolved by editing the
     * project, and the message names what to add. One code across all the scanner adapters
     * (D9), with `metadata.field` naming the missing input.
     */
    'EXTERNAL.SCANNER.CONFIG_REQUIRED': {
      code: 'EXTERNAL.SCANNER.CONFIG_REQUIRED',
      source: 'application',
      defaultResponsibility: 'user',
      kind: 'not-found',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'configuration',
      operatorAction:
        'Provide the input the scanner needs (its config file, dependency manifest, or build output) and re-run.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['field', 'scanner'],
    },

    /**
     * A scan could not start or could not finish: no project context, or the scanner exceeded
     * its deadline.
     *
     * `environment` and `caller-policy` retry — a timeout is about the machine and the workload,
     * and the caller owns whether to retry with a longer budget.
     */
    'EXTERNAL.SCANNER.SCAN_UNAVAILABLE': {
      code: 'EXTERNAL.SCANNER.SCAN_UNAVAILABLE',
      source: 'external',
      defaultResponsibility: 'environment',
      kind: 'timeout',
      retry: 'caller-policy',
      severity: 'error',
      exposure: 'public',
      exitClass: 'runtime',
      operatorAction:
        'The scan could not complete. Run from inside a project, or raise the scanner timeout for large workloads.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['condition', 'scanner'],
    },
    /**
     * A scanner produced output this adapter cannot ingest: a missing or unparsable artifact,
     * or a result shape the parser rejected.
     *
     * `external` source and `environment` responsibility — the scanner wrote it, and the
     * actionable step is about that tool's version or invocation rather than about opensip.
     */
    'EXTERNAL.SCANNER.ARTIFACT_INVALID': {
      code: 'EXTERNAL.SCANNER.ARTIFACT_INVALID',
      source: 'external',
      defaultResponsibility: 'environment',
      kind: 'integrity',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'runtime',
      operatorAction:
        'The scanner did not produce output this adapter can read. Check the scanner version matches the one the adapter supports.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['condition', 'scanner'],
    },

    /**
     * The scanner ran but failed: a non-zero exit that is not a findings result, or a fault the
     * adapter could not attribute.
     *
     * `caller-policy` retry — a scanner fault is often transient (a lock, a partial index), and
     * the caller owns whether re-running is worth it.
     */
    'EXTERNAL.SCANNER.FAULT': {
      code: 'EXTERNAL.SCANNER.FAULT',
      source: 'external',
      defaultResponsibility: 'environment',
      kind: 'I/O',
      retry: 'caller-policy',
      severity: 'error',
      exposure: 'public',
      exitClass: 'runtime',
      operatorAction:
        'The scanner failed. Check its own output for the cause; the captured stderr tail is on the error.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['condition', 'scanner', 'exitCode'],
    },
  },
);
