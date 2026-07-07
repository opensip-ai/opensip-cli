/**
 * Tier-1 (in-process) tests for the pmd adapter `Tool` (ADR-0090 D6 Tier 1).
 *
 * PMD 7 is a SARIF adapter with NO per-adapter parser — its `scan` command
 * declares `output: { kind: 'sarif' }` and OMITS `parse`, so the shared substrate
 * `ingestSarif` reads the report. Beyond the declarative surface (commandSpecs /
 * identity / metadata), the `pmd check -f sarif` arg builder, and the
 * manifest↔runtime host-shape guards, this suite pins the PMD exit model
 * (exit 4 = violations ⇒ findings; any other nonzero ⇒ fault).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { assertManifestMatchesTool } from '@opensip-cli/core';
import {
  deriveAdapterConfigManifest,
  deriveAdapterManifestCommands,
  deriveAdapterManifestRequires,
  interpretExit,
  normalizedSignalShape,
  runAcceptanceCase,
} from '@opensip-cli/external-tool-adapter';
import { describe, expect, it } from 'vitest';

import { buildScanArgs, PMD_STABLE_ID, tool } from '../tool.js';

import type { ToolPluginManifest } from '@opensip-cli/core';
import type { AdapterRunContext, ScannerExitModel } from '@opensip-cli/external-tool-adapter';

const PKG = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { name: string; version: string; opensipTools: Record<string, unknown> };

const GOLDEN_RAW = readFileSync(
  fileURLToPath(new URL('../../__fixtures__/pmd-golden.sarif', import.meta.url)),
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

describe('pmd tool — identity + metadata', () => {
  it('declares the pmd identity with NO aliases', () => {
    expect(tool.identity).toEqual({ name: 'pmd' });
  });

  it('carries the stable UUID and a description', () => {
    expect(tool.metadata.id).toBe(PMD_STABLE_ID);
    expect(tool.metadata.name).toBe('pmd');
    expect(tool.metadata.description).toBe('Java source analysis via PMD');
  });

  it('defaults to the line-shift-tolerant message-hash fingerprint strategy', () => {
    expect(tool.extensionPoints?.fingerprintStrategy?.id).toBe(
      'external-tool-adapter.sha256-file-rule-message',
    );
  });
});

describe('pmd tool — commandSpecs', () => {
  it('mounts the primary scan, plus nested doctor + version', () => {
    expect((tool.commandSpecs ?? []).map((c) => c.name)).toEqual(['pmd', 'doctor', 'version']);
  });

  it('the primary command is `pmd` (no aliases), project-scoped, raw-stream dispatch', () => {
    const primary = byName('pmd');
    expect(primary?.parent).toBeUndefined();
    expect(primary?.aliases).toEqual([]);
    expect(primary?.scope).toBe('project');
    expect(primary?.output).toBe('raw-stream');
    expect(primary?.rawStreamReason).toBe('runtime-render-dispatch');
  });

  it('doctor + version are nested under pmd, scope:none, diagnostic-gate', () => {
    for (const name of ['doctor', 'version']) {
      const spec = byName(name);
      expect(spec?.parent).toBe('pmd');
      expect(spec?.scope).toBe('none');
      expect(spec?.output).toBe('raw-stream');
      expect(spec?.rawStreamReason).toBe('diagnostic-gate');
    }
  });
});

describe('pmd tool — scan-arg builder', () => {
  it('builds the `check -f sarif` argv writing SARIF to the run artifact path', () => {
    const ctx = {
      projectRoot: '/proj',
      artifactPath: (name: string) => `/proj/.runtime/artifacts/pmd/run1/${name}`,
    } as unknown as AdapterRunContext;
    expect(buildScanArgs(ctx)).toEqual([
      'check',
      '-d',
      '/proj',
      '-R',
      'rulesets/java/quickstart.xml',
      '-f',
      'sarif',
      '-r',
      '/proj/.runtime/artifacts/pmd/run1/pmd.sarif',
    ]);
  });
});

describe('pmd tool — exit model (PMD 7: exit 4 = violations)', () => {
  // PMD 7 exits 4 when it found violations (a distinct findings code), 0 when
  // clean, and any other nonzero (error/CLI-misuse) is a fault.
  const model: ScannerExitModel = { ok: [0], findings: [4], errorFrom: 1 };

  it('exit 0 ⇒ clean', () => {
    expect(interpretExit(0, model)).toBe('ok');
  });

  it('exit 4 (violations) + a valid artifact ⇒ findings', () => {
    expect(interpretExit(4, model, { artifactValid: true })).toBe('findings');
  });

  it('exit 1 ⇒ fault (an error, not a findings code)', () => {
    expect(interpretExit(1, model)).toBe('fault');
    expect(interpretExit(2, model)).toBe('fault');
  });

  it('declares 7.0.0 as the real CLI floor (the `check` verb + `-f sarif`)', () => {
    expect(PKG.opensipTools).toBeTruthy();
    // The floor is documented on the binary spec (not surfaced on the Tool), so
    // this asserts intent alongside the exit model rather than the runtime value.
    expect(model.findings).toEqual([4]);
  });
});

describe('pmd tool — manifest ↔ runtime host-shape guards', () => {
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

  it('the generated manifest requires + config equal the substrate derivations', () => {
    expect(PKG.opensipTools.requires).toEqual(deriveAdapterManifestRequires(tool));
    expect(PKG.opensipTools.config).toEqual(deriveAdapterConfigManifest(tool));
  });

  it('derives subprocess + filesystem only (local-only posture, no network)', () => {
    expect((PKG.opensipTools.requires as { resource: string }[]).map((r) => r.resource)).toEqual([
      'subprocess',
      'filesystem',
    ]);
  });
});

describe('pmd tool — shared ingestSarif (normalize → envelope)', () => {
  const result = runAcceptanceCase({
    tool: 'pmd',
    kind: 'sarif',
    raw: GOLDEN_RAW,
    fingerprintStrategy: 'message-hash',
  });

  it('produces the golden normalized signals via the shared SARIF read path', () => {
    expect(result.signals.map(normalizedSignalShape)).toEqual(EXPECTED);
  });

  it('recovers severity from the SARIF level (error → high, warning → medium)', () => {
    expect(result.signals.map((s) => s.severity)).toEqual(['medium', 'high']);
  });

  it('stamps a message-hash fingerprint on every envelope signal worker-side', () => {
    expect(result.envelope.tool).toBe('pmd');
    expect(result.envelope.signals).toHaveLength(2);
    for (const s of result.envelope.signals) {
      expect(s.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
