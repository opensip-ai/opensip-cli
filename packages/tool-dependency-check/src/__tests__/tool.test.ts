/**
 * Tier-1 (in-process) tests for the dependency-check adapter `Tool` (ADR-0090
 * D6 Tier 1).
 *
 * OWASP Dependency-Check is a SARIF adapter with NO per-adapter parser — its
 * `scan` command declares `output: { kind: 'sarif' }` and OMITS `parse`, so the
 * shared substrate `ingestSarif` reads the report. This suite is the CVSS
 * `security-severity` recovery proof: each result carries a
 * `properties["security-severity"]` number that maps into the OpenSIP four-bucket
 * bands (9.1 → critical, 7.5 → high, 5.3 → medium) BEFORE the lossy SARIF `level`
 * fallback. It also pins the declarative surface, the `--format SARIF` arg builder,
 * the `.runtime` exclude, and the manifest↔runtime host-shape guards.
 */

import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertManifestMatchesTool } from '@opensip-cli/core';
import {
  deriveAdapterConfigManifest,
  deriveAdapterManifestCommands,
  deriveAdapterManifestRequires,
  ingestSarif,
  interpretExit,
  normalizedSignalShape,
  runAcceptanceCase,
} from '@opensip-cli/external-tool-adapter';
import { describe, expect, it } from 'vitest';

import {
  buildDependencyCheckExclude,
  buildScanArgs,
  DEPENDENCY_CHECK_STABLE_ID,
  tool,
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
  fileURLToPath(new URL('../../__fixtures__/dependency-check-golden.sarif', import.meta.url)),
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

const byName = (name: string) => tool.commandSpecs?.find((c) => c.name === name);

describe('dependency-check tool — identity + metadata', () => {
  it('declares the dependency-check identity with the owasp-dependency-check alias', () => {
    expect(tool.identity).toEqual({
      name: 'dependency-check',
      aliases: ['owasp-dependency-check'],
    });
  });

  it('carries the stable UUID and a description', () => {
    expect(tool.metadata.id).toBe(DEPENDENCY_CHECK_STABLE_ID);
    expect(tool.metadata.name).toBe('dependency-check');
    expect(tool.metadata.description).toBe(
      'Dependency vulnerability scanning via OWASP Dependency-Check',
    );
  });

  it('defaults to the line-shift-tolerant message-hash fingerprint strategy', () => {
    expect(tool.extensionPoints?.fingerprintStrategy?.id).toBe(
      'external-tool-adapter.sha256-file-rule-message',
    );
  });
});

describe('dependency-check tool — commandSpecs', () => {
  it('mounts the primary scan, plus nested doctor + version', () => {
    expect((tool.commandSpecs ?? []).map((c) => c.name)).toEqual([
      'dependency-check',
      'doctor',
      'version',
    ]);
  });

  it('the primary command is `dependency-check` (aliased owasp-dependency-check), project-scoped', () => {
    const primary = byName('dependency-check');
    expect(primary?.parent).toBeUndefined();
    expect(primary?.aliases).toEqual(['owasp-dependency-check']);
    expect(primary?.scope).toBe('project');
    expect(primary?.output).toBe('raw-stream');
    expect(primary?.rawStreamReason).toBe('runtime-render-dispatch');
  });

  it('doctor + version are nested under dependency-check, scope:none, diagnostic-gate', () => {
    for (const name of ['doctor', 'version']) {
      const spec = byName(name);
      expect(spec?.parent).toBe('dependency-check');
      expect(spec?.scope).toBe('none');
      expect(spec?.output).toBe('raw-stream');
      expect(spec?.rawStreamReason).toBe('diagnostic-gate');
    }
  });
});

describe('dependency-check tool — scan-arg + exclude builders', () => {
  it('builds the SARIF argv (--out is the artifact DIRECTORY, --noupdate for offline)', () => {
    const ctx = {
      projectRoot: '/proj/my-app',
      artifactPath: (name: string) => `/proj/.runtime/artifacts/dependency-check/run1/${name}`,
    } as unknown as AdapterRunContext;
    const artifact = '/proj/.runtime/artifacts/dependency-check/run1/dependency-check-report.sarif';
    expect(buildScanArgs(ctx)).toEqual([
      '--project',
      basename('/proj/my-app'),
      '--scan',
      '/proj/my-app',
      '--format',
      'SARIF',
      '--out',
      dirname(artifact),
      '--noupdate',
      '--disableOssIndex',
      '--disableNodeAudit',
      '--disableYarnAudit',
      '--disablePnpmAudit',
    ]);
  });

  it('excludes the .runtime store via an Ant recursive --exclude pattern (A3)', () => {
    expect(buildDependencyCheckExclude({ excludePath: '/proj/opensip-cli/.runtime' }).args).toEqual(
      ['--exclude', '**/opensip-cli/.runtime/**'],
    );
  });
});

describe('dependency-check tool — exit model', () => {
  // Dependency-Check exits 0 clean; findings come from the parsed SARIF (no
  // `--failOnCVSS` is passed), so any nonzero (>= 1) is a genuine fault.
  const model: ScannerExitModel = { ok: [0], findings: [], errorFrom: 1 };

  it('exit 0 ⇒ clean (findings, if any, come from the SARIF — not the exit code)', () => {
    expect(interpretExit(0, model)).toBe('ok');
  });

  it('exit 1 ⇒ fault, EVEN with a valid artifact (no findings code to absorb it)', () => {
    expect(interpretExit(1, model, { artifactValid: true })).toBe('fault');
    expect(interpretExit(2, model)).toBe('fault');
  });
});

describe('dependency-check tool — manifest ↔ runtime host-shape guards', () => {
  it('the package.json manifest matches the runtime tool (no drift)', () => {
    expect(() => {
      assertManifestMatchesTool(manifestFromPackage(), tool);
    }).not.toThrow();
  });

  it('the generated manifest commands equal the derived runtime command shells', () => {
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

  it('the generated manifest requires + config equal the substrate derivations (A13/A4)', () => {
    // `requires` is DERIVED from the declared network posture, not hand-typed — a
    // posture flip surfaces as `--check` drift.
    expect(PKG.opensipTools.requires).toEqual(deriveAdapterManifestRequires(tool));
    const derivedConfig = deriveAdapterConfigManifest(tool);
    expect(derivedConfig?.namespace).toBe('dependency-check');
    expect(PKG.opensipTools.config).toEqual(derivedConfig);
  });
});

describe('dependency-check tool — CVSS security-severity recovery (ADR-0091 D2)', () => {
  const result = runAcceptanceCase({
    tool: 'dependency-check',
    kind: 'sarif',
    raw: GOLDEN_RAW,
    fingerprintStrategy: 'message-hash',
  });

  it('produces the golden normalized signals via the shared SARIF read path', () => {
    expect(result.signals.map(normalizedSignalShape)).toEqual(EXPECTED);
  });

  it('maps the CVSS bands: 9.1 → critical, 7.5 → high, 5.3 → medium', () => {
    const signals = ingestSarif(JSON.parse(GOLDEN_RAW) as SarifLog, {
      source: 'dependency-check',
    });
    const byRule = (id: string) => signals.find((s) => s.ruleId === id);
    expect(byRule('CVE-2021-44228')?.severity).toBe('critical');
    expect(byRule('CVE-2021-44228')?.metadata.securitySeverity).toBe('9.1');
    expect(byRule('CVE-2019-10086')?.severity).toBe('high');
    expect(byRule('CVE-2019-10086')?.metadata.securitySeverity).toBe('7.5');
    expect(byRule('CVE-2020-13956')?.severity).toBe('medium');
    expect(byRule('CVE-2020-13956')?.metadata.securitySeverity).toBe('5.3');
  });

  it('stamps a message-hash fingerprint on every envelope signal worker-side', () => {
    expect(result.envelope.tool).toBe('dependency-check');
    expect(result.envelope.signals).toHaveLength(3);
    for (const s of result.envelope.signals) {
      expect(s.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('dependency-check tool — version probe (covers the binary versionParse)', () => {
  it('resolves the config-pinned binary and normalizes its --version output to a semver', async () => {
    // Pin the binary to the real node executable so the substrate's version probe
    // runs a REAL `--version` and feeds stdout through the tool's inline
    // `versionParse` (parseFirstSemver ?? trim). node --version ⇒ `vX.Y.Z`.
    const version = tool.commandSpecs?.find((c) => c.name === 'version') as unknown as {
      handler: (opts: unknown, cli: unknown) => Promise<void>;
    };
    const emitted: { found: boolean; version?: string }[] = [];
    const cli = {
      scope: {
        toolConfig: {
          'dependency-check': {
            binaries: { 'dependency-check': { path: process.execPath } },
          },
        },
      },
      emitJson: (value: { found: boolean; version?: string }) => emitted.push(value),
    };
    await version.handler({ json: true }, cli);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.found).toBe(true);
    expect(emitted[0]?.version).toMatch(/^\d+\.\d+/);
  });
});
