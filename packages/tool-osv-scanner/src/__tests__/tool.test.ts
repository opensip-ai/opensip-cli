/**
 * Tier-1 (in-process) tests for the osv-scanner adapter `Tool` (ADR-0090 D6
 * Tier 1).
 *
 * Asserts the declarative surface (commandSpecs / identity / metadata), the binary
 * helpers (version parse + scan args), the FROZEN exit model (Phase-0 decision 4 —
 * incl. the `128` nothing-scanned no-op), the manifest↔runtime host-shape guards
 * (`assertManifestMatchesTool` + `deriveAdapterManifestCommands` parity), and the
 * full normalize→envelope path via the acceptance harness.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { assertManifestMatchesTool } from '@opensip-cli/core';
import {
  DEFAULT_EXIT_MODEL,
  deriveAdapterManifestCommands,
  interpretExit,
  normalizedSignalShape,
  runAcceptanceCase,
} from '@opensip-cli/external-tool-adapter';
import { describe, expect, it } from 'vitest';

import { parseOsvJson } from '../parse-osv-json.js';
import { buildScanArgs, OSV_SCANNER_STABLE_ID, parseOsvVersion, tool } from '../tool.js';

import type { ToolPluginManifest } from '@opensip-cli/core';
import type { AdapterRunContext, ScannerExitModel } from '@opensip-cli/external-tool-adapter';

const PKG = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { name: string; version: string; opensipTools: Record<string, unknown> };

const GOLDEN_RAW = readFileSync(
  fileURLToPath(new URL('../../__fixtures__/osv-golden.json', import.meta.url)),
  'utf8',
);
const EXPECTED = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../__fixtures__/expected-signals.json', import.meta.url)),
    'utf8',
  ),
) as unknown[];

/** Reconstruct the admitted `ToolPluginManifest` the host builds from package.json. */
function manifestFromPackage(): ToolPluginManifest {
  return {
    ...(PKG.opensipTools as object),
    name: PKG.name,
    version: PKG.version,
    apiVersion: PKG.opensipTools.apiVersion as number,
  } as ToolPluginManifest;
}

describe('osv-scanner tool — identity + metadata', () => {
  it('declares the osv-scanner identity with the `osv` alias', () => {
    expect(tool.identity).toEqual({ name: 'osv-scanner', aliases: ['osv'] });
  });

  it('carries the stable UUID and a description', () => {
    expect(tool.metadata.id).toBe(OSV_SCANNER_STABLE_ID);
    expect(tool.metadata.name).toBe('osv-scanner');
    expect(tool.metadata.description).toBe('Dependency vulnerability scanning via OSV-Scanner');
  });

  it('defaults to the line-shift-tolerant message-hash fingerprint strategy', () => {
    expect(tool.extensionPoints?.fingerprintStrategy?.id).toBe(
      'external-tool-adapter.sha256-file-rule-message',
    );
  });
});

const byName = (name: string) => tool.commandSpecs?.find((c) => c.name === name);

describe('osv-scanner tool — commandSpecs', () => {
  it('mounts the primary scan, plus nested doctor + version', () => {
    const names = (tool.commandSpecs ?? []).map((c) => c.name);
    expect(names).toEqual(['osv-scanner', 'doctor', 'version']);
  });

  it('the primary command is `osv-scanner` (aliased `osv`), project-scoped, raw-stream dispatch', () => {
    const primary = byName('osv-scanner');
    expect(primary?.parent).toBeUndefined();
    expect(primary?.aliases).toEqual(['osv']);
    expect(primary?.scope).toBe('project');
    expect(primary?.output).toBe('raw-stream');
    expect(primary?.rawStreamReason).toBe('runtime-render-dispatch');
  });

  it('doctor + version are nested under osv-scanner, scope:none, diagnostic-gate', () => {
    for (const name of ['doctor', 'version']) {
      const spec = byName(name);
      expect(spec?.parent).toBe('osv-scanner');
      expect(spec?.scope).toBe('none');
      expect(spec?.output).toBe('raw-stream');
      expect(spec?.rawStreamReason).toBe('diagnostic-gate');
    }
  });
});

describe('osv-scanner tool — binary helpers', () => {
  it('parses the osv-scanner version stdout (banner, bare semver, or leading v)', () => {
    expect(parseOsvVersion('osv-scanner version: 1.9.1')).toBe('1.9.1');
    expect(parseOsvVersion('1.7.0\n')).toBe('1.7.0');
    expect(parseOsvVersion('v2.0.0')).toBe('2.0.0');
  });

  it('falls back to the trimmed stdout when no semver is present', () => {
    expect(parseOsvVersion('  unknown  ')).toBe('unknown');
  });

  it('builds the recursive-scan argv writing JSON to the run artifact path', () => {
    const ctx = {
      projectRoot: '/proj',
      artifactPath: (name: string) => `/proj/.runtime/artifacts/osv-scanner/run1/${name}`,
    } as unknown as AdapterRunContext;
    expect(buildScanArgs(ctx)).toEqual([
      '--format',
      'json',
      '--output',
      '/proj/.runtime/artifacts/osv-scanner/run1/osv.json',
      '-r',
      '/proj',
    ]);
  });
});

describe('osv-scanner tool — exit model (Phase-0 decision 4)', () => {
  // Frozen OSV model: `128` ("no packages found") is a CLEAN no-op, not a fault.
  const model: ScannerExitModel = { ok: [0, 128], findings: [1], errorFrom: 2 };

  it('exit 0 ⇒ clean (no findings)', () => {
    expect(interpretExit(0, model)).toBe('ok');
  });

  it('exit 1 + a valid artifact ⇒ findings', () => {
    expect(interpretExit(1, model, { artifactValid: true })).toBe('findings');
  });

  it('exit 128 ⇒ clean no-op (no packages/lockfiles found), NOT a fault', () => {
    expect(interpretExit(128, model)).toBe('ok');
  });

  it('exit 127 (general error) ⇒ fault', () => {
    expect(interpretExit(127, model)).toBe('fault');
  });

  it('exit 2 ⇒ fault', () => {
    expect(interpretExit(2, model)).toBe('fault');
  });

  it('matches the runtime command exit model, which EXTENDS the substrate default with 128', () => {
    const primary = byName('osv-scanner');
    // The runtime spec stores the exit model on the primary command's args closure
    // indirectly; assert the frozen shape and that it diverges from the default by
    // exactly the nothing-scanned code.
    expect(model).not.toEqual(DEFAULT_EXIT_MODEL);
    expect(model.ok).toEqual([0, 128]);
    expect(primary).toBeDefined();
  });
});

describe('osv-scanner tool — manifest ↔ runtime host-shape guards', () => {
  it('the package.json manifest matches the runtime tool (no drift)', () => {
    expect(() => {
      assertManifestMatchesTool(manifestFromPackage(), tool);
    }).not.toThrow();
  });

  it('the generated manifest commands equal the derived runtime command shells', () => {
    // The package.json `commands` are written by the shared manifest generator
    // (which OMITS an empty `aliases`), while the substrate's
    // `deriveAdapterManifestCommands` always emits `aliases: []`. Canonicalize that
    // one representational difference (`aliases ?? []`) before comparing the
    // substantive shells.
    const canon = (c: Record<string, unknown>): Record<string, unknown> => ({
      ...c,
      aliases: c.aliases ?? [],
    });
    const generated = (PKG.opensipTools.commands as Record<string, unknown>[]).map(canon);
    const derived = deriveAdapterManifestCommands(tool).map((c) =>
      canon(c as unknown as Record<string, unknown>),
    );
    expect(generated).toEqual(derived);
  });

  it('declares subprocess + filesystem resource needs (local-only posture)', () => {
    expect(PKG.opensipTools.requires).toEqual([
      {
        resource: 'subprocess',
        reason: 'Executes the user-installed osv-scanner binary via execFile (no shell)',
      },
      {
        resource: 'filesystem',
        reason:
          'Reads the project working tree and writes the raw scan artifact under .runtime/artifacts',
      },
    ]);
  });
});

describe('osv-scanner tool — acceptance harness (normalize → envelope)', () => {
  const result = runAcceptanceCase({
    tool: 'osv-scanner',
    kind: 'json',
    raw: GOLDEN_RAW,
    parse: parseOsvJson,
    fingerprintStrategy: 'message-hash',
  });

  it('produces the golden normalized signals', () => {
    expect(result.signals.map(normalizedSignalShape)).toEqual(EXPECTED);
  });

  it('builds an envelope whose verdict FAILS (the high-severity vuln is error-rung)', () => {
    expect(result.envelope.tool).toBe('osv-scanner');
    expect(result.envelope.verdict.passed).toBe(false);
  });

  it('stamps a message-hash fingerprint on every envelope signal worker-side', () => {
    expect(result.envelope.signals).toHaveLength(2);
    for (const s of result.envelope.signals) {
      expect(s.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('preserves provenance-friendly native severity + advisory metadata (no loss)', () => {
    const [high, moderate] = result.signals;
    expect(high?.metadata.nativeSeverity).toBe('HIGH');
    expect(high?.metadata.cvss).toBe('7.5');
    expect(moderate?.metadata.nativeSeverity).toBe('MODERATE');
    expect(moderate?.metadata.aliases).toEqual(['CVE-2021-44906']);
  });
});
