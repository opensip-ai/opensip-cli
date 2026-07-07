/**
 * Tier-1 (in-process) tests for the spotbugs adapter `Tool` (ADR-0090 D6 Tier 1).
 *
 * SpotBugs is a SARIF adapter with NO per-adapter parser — its `scan` command
 * declares `output: { kind: 'sarif' }` and OMITS `parse`, so the shared substrate
 * `ingestSarif` reads the report. Beyond the declarative surface (commandSpecs /
 * identity / metadata), the scan-arg builder (which requires compiled classes),
 * and the manifest↔runtime host-shape guards, this suite pins the SpotBugs exit
 * BITMASK model: bugs(1)|missing-class(2) are findings (via `findingsFromNonzero`)
 * while the analysis-error bit (>= 4) is a genuine fault.
 */

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

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

import { buildScanArgs, SPOTBUGS_STABLE_ID, tool } from '../tool.js';

import type { ToolPluginManifest } from '@opensip-cli/core';
import type { AdapterRunContext, ScannerExitModel } from '@opensip-cli/external-tool-adapter';

const PKG = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { name: string; version: string; opensipTools: Record<string, unknown> };

const GOLDEN_RAW = readFileSync(
  fileURLToPath(new URL('../../__fixtures__/spotbugs-golden.sarif', import.meta.url)),
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

describe('spotbugs tool — identity + metadata', () => {
  it('declares the spotbugs identity with NO aliases', () => {
    expect(tool.identity).toEqual({ name: 'spotbugs' });
  });

  it('carries the stable UUID and a description', () => {
    expect(tool.metadata.id).toBe(SPOTBUGS_STABLE_ID);
    expect(tool.metadata.name).toBe('spotbugs');
    expect(tool.metadata.description).toBe('Java bytecode analysis via SpotBugs');
  });

  it('defaults to the line-shift-tolerant message-hash fingerprint strategy', () => {
    expect(tool.extensionPoints?.fingerprintStrategy?.id).toBe(
      'external-tool-adapter.sha256-file-rule-message',
    );
  });
});

describe('spotbugs tool — commandSpecs', () => {
  it('mounts the primary scan, plus nested doctor + version', () => {
    expect((tool.commandSpecs ?? []).map((c) => c.name)).toEqual(['spotbugs', 'doctor', 'version']);
  });

  it('the primary command is `spotbugs` (no aliases), project-scoped, raw-stream dispatch', () => {
    const primary = byName('spotbugs');
    expect(primary?.parent).toBeUndefined();
    expect(primary?.aliases).toEqual([]);
    expect(primary?.scope).toBe('project');
    expect(primary?.output).toBe('raw-stream');
    expect(primary?.rawStreamReason).toBe('runtime-render-dispatch');
  });

  it('doctor + version are nested under spotbugs, scope:none, diagnostic-gate', () => {
    for (const name of ['doctor', 'version']) {
      const spec = byName(name);
      expect(spec?.parent).toBe('spotbugs');
      expect(spec?.scope).toBe('none');
      expect(spec?.output).toBe('raw-stream');
      expect(spec?.rawStreamReason).toBe('diagnostic-gate');
    }
  });
});

describe('spotbugs tool — scan-arg builder (requires compiled classes)', () => {
  it('builds the -textui SARIF argv against the discovered class output dir', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'spotbugs-classes-'));
    mkdirSync(join(projectRoot, 'target', 'classes'), { recursive: true });
    const ctx = {
      projectRoot,
      artifactPath: (name: string) => `${projectRoot}/.runtime/artifacts/spotbugs/run1/${name}`,
    } as unknown as AdapterRunContext;
    expect(buildScanArgs(ctx)).toEqual([
      '-textui',
      '-effort:max',
      '-low',
      '-sarif',
      '-output',
      `${projectRoot}/.runtime/artifacts/spotbugs/run1/spotbugs.sarif`,
      join(projectRoot, 'target', 'classes'),
    ]);
  });

  it('throws MISSING_BUILD_OUTPUT when no compiled classes exist', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'spotbugs-empty-'));
    const ctx = {
      projectRoot,
      artifactPath: (name: string) => `${projectRoot}/${name}`,
    } as unknown as AdapterRunContext;
    expect(() => buildScanArgs(ctx)).toThrow(/compiled Java classes/i);
  });
});

describe('spotbugs tool — exit model (SpotBugs bitmask, Phase-0 decision 4)', () => {
  // SpotBugs' exit code is a bugs(1)|missing-class(2)|error(4) bitmask. Bugs and
  // missing-referenced-classes are FINDINGS (reclaimed via findingsFromNonzero);
  // only the error bit (>= 4) is a genuine fault. Findings themselves come from
  // the parsed SARIF file.
  const model: ScannerExitModel = {
    ok: [0],
    findings: [],
    findingsFromNonzero: true,
    errorFrom: 4,
  };

  it('exit 0 ⇒ clean', () => {
    expect(interpretExit(0, model, { artifactValid: true })).toBe('ok');
  });

  it('exit 1 (bugs) + a valid artifact ⇒ findings', () => {
    expect(interpretExit(1, model, { artifactValid: true })).toBe('findings');
  });

  it('exit 3 (bugs | missing-class) ⇒ findings (below the error ceiling)', () => {
    expect(interpretExit(3, model, { artifactValid: true })).toBe('findings');
  });

  it('exit 4 (error bit set) ⇒ fault (the ceiling wins over the bitset reclaim)', () => {
    expect(interpretExit(4, model, { artifactValid: true })).toBe('fault');
    expect(interpretExit(6, model, { artifactValid: true })).toBe('fault');
  });
});

describe('spotbugs tool — manifest ↔ runtime host-shape guards', () => {
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

describe('spotbugs tool — shared ingestSarif (normalize → envelope)', () => {
  const result = runAcceptanceCase({
    tool: 'spotbugs',
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
    expect(result.envelope.tool).toBe('spotbugs');
    expect(result.envelope.signals).toHaveLength(2);
    for (const s of result.envelope.signals) {
      expect(s.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
