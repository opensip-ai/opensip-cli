/**
 * Tier-1 (in-process) tests for the trivy adapter `Tool` (ADR-0090 D6 Tier 1).
 *
 * Trivy is the SARIF adapter — the FIRST real consumer of the substrate's shared
 * `ingestSarif`. So beyond the declarative surface (commandSpecs / identity /
 * metadata), the binary helpers, the FROZEN exit model (Phase-0 decision 4: NO
 * findings code; any nonzero is a fault), and the manifest↔runtime host-shape
 * guards, this suite proves the SARIF READ PATH end-to-end — especially the CVSS
 * `security-severity` SEVERITY RECOVERY:
 *
 *   - a result with `level:"error"` + `security-severity:"9.8"` normalizes to
 *     `critical` (NOT `high` — the writer collapses critical+high → `error`, so a
 *     level-only inverse is ambiguous and the CVSS number is what disambiguates);
 *   - a result with `level:"error"` + `security-severity:"7.5"` → `high`;
 *   - a result with NO `security-severity` falls back to the `level` band
 *     (`warning` → `medium`).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { assertManifestMatchesTool } from '@opensip-cli/core';
import {
  DEFAULT_EXIT_MODEL,
  deriveAdapterConfigManifest,
  deriveAdapterManifestCommands,
  deriveAdapterManifestRequires,
  ingestSarif,
  interpretExit,
  normalizedSignalShape,
  runAcceptanceCase,
  sarifLevelToSeverity,
} from '@opensip-cli/external-tool-adapter';
import { describe, expect, it } from 'vitest';

import {
  buildScanArgs,
  buildTrivyExclude,
  parseTrivyVersion,
  tool,
  TRIVY_STABLE_ID,
} from '../tool.js';

import type { ToolPluginManifest } from '@opensip-cli/core';
import type {
  AdapterRunContext,
  SarifLog,
  ScannerExitModel,
} from '@opensip-cli/external-tool-adapter';

const PKG = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { name: string; version: string; opensipTools: Record<string, unknown> };

const GOLDEN_RAW = readFileSync(
  fileURLToPath(new URL('../../__fixtures__/trivy-golden.sarif', import.meta.url)),
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

describe('trivy tool — identity + metadata', () => {
  it('declares the trivy identity with NO aliases', () => {
    expect(tool.identity).toEqual({ name: 'trivy' });
  });

  it('carries the stable UUID and a description', () => {
    expect(tool.metadata.id).toBe(TRIVY_STABLE_ID);
    expect(tool.metadata.name).toBe('trivy');
    expect(tool.metadata.description).toBe('Vulnerability + misconfig scanning via Trivy');
  });

  it('defaults to the line-shift-tolerant message-hash fingerprint strategy', () => {
    expect(tool.extensionPoints?.fingerprintStrategy?.id).toBe(
      'external-tool-adapter.sha256-file-rule-message',
    );
  });
});

const byName = (name: string) => tool.commandSpecs?.find((c) => c.name === name);

describe('trivy tool — commandSpecs', () => {
  it('mounts the primary scan, plus nested doctor + version', () => {
    const names = (tool.commandSpecs ?? []).map((c) => c.name);
    expect(names).toEqual(['trivy', 'doctor', 'version']);
  });

  it('the primary command is `trivy` (no aliases), project-scoped, raw-stream dispatch', () => {
    const primary = byName('trivy');
    expect(primary?.parent).toBeUndefined();
    expect(primary?.aliases).toEqual([]);
    expect(primary?.scope).toBe('project');
    expect(primary?.output).toBe('raw-stream');
    expect(primary?.rawStreamReason).toBe('runtime-render-dispatch');
  });

  it('doctor + version are nested under trivy, scope:none, diagnostic-gate', () => {
    for (const name of ['doctor', 'version']) {
      const spec = byName(name);
      expect(spec?.parent).toBe('trivy');
      expect(spec?.scope).toBe('none');
      expect(spec?.output).toBe('raw-stream');
      expect(spec?.rawStreamReason).toBe('diagnostic-gate');
    }
  });
});

describe('trivy tool — binary helpers', () => {
  it('parses the trivy version stdout (banner, bare semver, or leading v)', () => {
    expect(parseTrivyVersion('Version: 0.50.1\nVulnerability DB:\n  Version: 2')).toBe('0.50.1');
    expect(parseTrivyVersion('0.49.0\n')).toBe('0.49.0');
    expect(parseTrivyVersion('v0.51.2')).toBe('0.51.2');
  });

  it('falls back to the trimmed stdout when no semver is present', () => {
    expect(parseTrivyVersion('  unknown  ')).toBe('unknown');
  });

  it('builds the filesystem-scan argv with the local-only flags, writing SARIF to the run artifact path', () => {
    const ctx = {
      projectRoot: '/proj',
      artifactPath: (name: string) => `/proj/.runtime/artifacts/trivy/run1/${name}`,
    } as unknown as AdapterRunContext;
    expect(buildScanArgs(ctx)).toEqual([
      'fs',
      '--format',
      'sarif',
      '--output',
      '/proj/.runtime/artifacts/trivy/run1/trivy.sarif',
      '--skip-db-update',
      '--skip-java-db-update',
      '--offline-scan',
      '/proj',
    ]);
  });
});

describe('trivy tool — A3 .runtime exclusion (buildTrivyExclude)', () => {
  it('skips the opensip artifact store via --skip-dirs', () => {
    expect(buildTrivyExclude({ excludePath: '/proj/opensip-cli/.runtime' }).args).toEqual([
      '--skip-dirs',
      '/proj/opensip-cli/.runtime',
    ]);
  });
});

describe('trivy tool — exit model (Phase-0 decision 4)', () => {
  // Frozen Trivy model: Trivy exits 0 even WITH findings (no `--exit-code`), so
  // there is NO findings code — findings are derived from the parsed SARIF and ANY
  // nonzero exit is a genuine fault.
  const model: ScannerExitModel = { ok: [0], findings: [], errorFrom: 1 };

  it('exit 0 ⇒ clean (findings, if any, come from the SARIF — not the exit code)', () => {
    expect(interpretExit(0, model)).toBe('ok');
  });

  it('exit 1 ⇒ fault, EVEN with a valid artifact (no findings code to absorb it)', () => {
    expect(interpretExit(1, model, { artifactValid: true })).toBe('fault');
  });

  it('exit 2 ⇒ fault', () => {
    expect(interpretExit(2, model)).toBe('fault');
  });

  it('diverges from the substrate default by dropping the findings code', () => {
    expect(model).not.toEqual(DEFAULT_EXIT_MODEL);
    expect(model.findings).toEqual([]);
    expect(model.ok).toEqual([0]);
  });
});

describe('trivy tool — manifest ↔ runtime host-shape guards', () => {
  it('the package.json manifest matches the runtime tool (no drift)', () => {
    expect(() => {
      assertManifestMatchesTool(manifestFromPackage(), tool);
    }).not.toThrow();
  });

  it('the generated manifest commands equal the derived runtime command shells', () => {
    // The package.json `commands` are written by the shared manifest generator
    // (which OMITS an empty `aliases`); the substrate's `deriveAdapterManifestCommands`
    // always emits `aliases: []`. Canonicalize that one representational difference
    // (`aliases ?? []`) before comparing the substantive shells.
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

  it('the generated manifest requires equal the posture-derived requires (no drift)', () => {
    // A13: `requires` is DERIVED from the network posture, not hand-typed.
    expect(PKG.opensipTools.requires).toEqual(deriveAdapterManifestRequires(tool));
  });

  it('derives subprocess + filesystem only (local-only posture, no network)', () => {
    expect((PKG.opensipTools.requires as { resource: string }[]).map((r) => r.resource)).toEqual([
      'subprocess',
      'filesystem',
    ]);
  });

  it('the generated manifest config descriptor equals the derived namespace claim (A4)', () => {
    const derived = deriveAdapterConfigManifest(tool);
    expect(derived?.namespace).toBe('trivy');
    expect(PKG.opensipTools.config).toEqual(derived);
  });
});

describe('trivy tool — shared ingestSarif (normalize → envelope)', () => {
  const result = runAcceptanceCase({
    tool: 'trivy',
    kind: 'sarif',
    raw: GOLDEN_RAW,
    fingerprintStrategy: 'message-hash',
  });

  it('produces the golden normalized signals via the shared SARIF read path', () => {
    expect(result.signals.map(normalizedSignalShape)).toEqual(EXPECTED);
  });

  it('builds an envelope whose verdict FAILS (critical + high are error-rung)', () => {
    expect(result.envelope.tool).toBe('trivy');
    expect(result.envelope.verdict.passed).toBe(false);
  });

  it('stamps a message-hash fingerprint on every envelope signal worker-side', () => {
    expect(result.envelope.signals).toHaveLength(3);
    for (const s of result.envelope.signals) {
      expect(s.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('trivy tool — SARIF severity recovery (the ingest core job, ADR-0091 D2)', () => {
  const signals = ingestSarif(JSON.parse(GOLDEN_RAW) as SarifLog, { source: 'trivy' });
  const byRule = (id: string) => signals.find((s) => s.ruleId === id);

  it('recovers `critical` from CVSS 9.8 even though `level:"error"` alone maps to `high`', () => {
    // The load-bearing proof: the SARIF `level` is lossy (critical AND high → error),
    // so a level-only inverse can never reach critical.
    expect(sarifLevelToSeverity('error')).toBe('high');
    const certifi = byRule('CVE-2023-37920');
    expect(certifi?.severity).toBe('critical');
    expect(certifi?.metadata.securitySeverity).toBe('9.8');
    expect(certifi?.metadata.nativeLevel).toBe('error');
  });

  it('recovers `high` from CVSS 7.5 (a second `level:"error"` result, distinct band)', () => {
    const setuptools = byRule('CVE-2022-40897');
    expect(setuptools?.severity).toBe('high');
    expect(setuptools?.metadata.securitySeverity).toBe('7.5');
    expect(setuptools?.metadata.nativeLevel).toBe('error');
  });

  it('falls back to the `level` band when a rule has NO security-severity (warning → medium)', () => {
    const misconfig = byRule('DS002');
    expect(misconfig?.severity).toBe('medium');
    // No CVSS number was present → no securitySeverity recovered; the native level
    // is preserved for provenance.
    expect(misconfig?.metadata.securitySeverity).toBeUndefined();
    expect(misconfig?.metadata.nativeLevel).toBe('warning');
  });

  it('anchors each finding at its lockfile/Dockerfile location (startLine 1)', () => {
    expect(byRule('CVE-2023-37920')?.filePath).toBe('requirements.txt');
    expect(byRule('CVE-2023-37920')?.line).toBe(1);
    expect(byRule('DS002')?.filePath).toBe('Dockerfile');
  });
});
