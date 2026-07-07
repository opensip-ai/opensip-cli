/**
 * Tier-1 (in-process) tests for the cppcheck adapter `Tool` (ADR-0090 D6 Tier 1).
 *
 * Cppcheck is a SARIF adapter with NO per-adapter parser — its `scan` command
 * declares `output: { kind: 'sarif' }` and OMITS `parse`, so the shared substrate
 * `ingestSarif` reads the report. Beyond the declarative surface (commandSpecs /
 * identity / metadata), this suite pins the `--output-format=sarif` arg builder
 * (both the plain-directory and `compile_commands.json` input modes), the
 * `.runtime` exclude, the exit model, and the shared SARIF read path over C/C++
 * findings.
 */

import { writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

import { buildCppcheckExclude, buildScanArgs, CPPCHECK_STABLE_ID, tool } from '../tool.js';

import type { ToolPluginManifest } from '@opensip-cli/core';
import type { AdapterRunContext, ScannerExitModel } from '@opensip-cli/external-tool-adapter';

const PKG = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { name: string; version: string; opensipTools: Record<string, unknown> };

const GOLDEN_RAW = readFileSync(
  fileURLToPath(new URL('../../__fixtures__/cppcheck-golden.sarif', import.meta.url)),
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

describe('cppcheck tool — identity + metadata', () => {
  it('declares the cppcheck identity with NO aliases', () => {
    expect(tool.identity).toEqual({ name: 'cppcheck' });
  });

  it('carries the stable UUID and a description', () => {
    expect(tool.metadata.id).toBe(CPPCHECK_STABLE_ID);
    expect(tool.metadata.name).toBe('cppcheck');
    expect(tool.metadata.description).toBe('C/C++ static analysis via Cppcheck');
  });

  it('defaults to the line-shift-tolerant message-hash fingerprint strategy', () => {
    expect(tool.extensionPoints?.fingerprintStrategy?.id).toBe(
      'external-tool-adapter.sha256-file-rule-message',
    );
  });
});

describe('cppcheck tool — commandSpecs', () => {
  it('mounts the primary scan, plus nested doctor + version', () => {
    expect((tool.commandSpecs ?? []).map((c) => c.name)).toEqual(['cppcheck', 'doctor', 'version']);
  });

  it('the primary command is `cppcheck` (no aliases), project-scoped, raw-stream dispatch', () => {
    const primary = byName('cppcheck');
    expect(primary?.parent).toBeUndefined();
    expect(primary?.aliases).toEqual([]);
    expect(primary?.scope).toBe('project');
    expect(primary?.output).toBe('raw-stream');
    expect(primary?.rawStreamReason).toBe('runtime-render-dispatch');
  });

  it('doctor + version are nested under cppcheck, scope:none, diagnostic-gate', () => {
    for (const name of ['doctor', 'version']) {
      const spec = byName(name);
      expect(spec?.parent).toBe('cppcheck');
      expect(spec?.scope).toBe('none');
      expect(spec?.output).toBe('raw-stream');
      expect(spec?.rawStreamReason).toBe('diagnostic-gate');
    }
  });
});

describe('cppcheck tool — scan-arg + exclude builders', () => {
  it('scans the project directory when no compile_commands.json is present', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cppcheck-plain-'));
    const ctx = {
      projectRoot,
      artifactPath: (name: string) => `${projectRoot}/.runtime/artifacts/cppcheck/run1/${name}`,
    } as unknown as AdapterRunContext;
    expect(buildScanArgs(ctx)).toEqual([
      '--enable=warning,style,performance,portability,information',
      '--inline-suppr',
      '--output-format=sarif',
      `--output-file=${projectRoot}/.runtime/artifacts/cppcheck/run1/cppcheck.sarif`,
      projectRoot,
    ]);
  });

  it('prefers a compile_commands.json compilation database when present', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cppcheck-cdb-'));
    const cdb = join(projectRoot, 'compile_commands.json');
    writeFileSync(cdb, '[]', 'utf8');
    const ctx = {
      projectRoot,
      artifactPath: (name: string) => `${projectRoot}/.runtime/artifacts/cppcheck/run1/${name}`,
    } as unknown as AdapterRunContext;
    expect(buildScanArgs(ctx)).toEqual([
      '--enable=warning,style,performance,portability,information',
      '--inline-suppr',
      '--output-format=sarif',
      `--output-file=${projectRoot}/.runtime/artifacts/cppcheck/run1/cppcheck.sarif`,
      `--project=${cdb}`,
    ]);
  });

  it('excludes the .runtime store via -i (A3)', () => {
    expect(buildCppcheckExclude({ excludePath: '/proj/opensip-cli/.runtime' }).args).toEqual([
      '-i',
      '/proj/opensip-cli/.runtime',
    ]);
  });
});

describe('cppcheck tool — exit model', () => {
  // Cppcheck exits 0 clean; findings come from the parsed SARIF, so any nonzero
  // (>= 1) is a genuine fault.
  const model: ScannerExitModel = { ok: [0], findings: [], errorFrom: 1 };

  it('exit 0 ⇒ clean (findings, if any, come from the SARIF — not the exit code)', () => {
    expect(interpretExit(0, model)).toBe('ok');
  });

  it('exit 1 ⇒ fault, EVEN with a valid artifact (no findings code to absorb it)', () => {
    expect(interpretExit(1, model, { artifactValid: true })).toBe('fault');
    expect(interpretExit(2, model)).toBe('fault');
  });
});

describe('cppcheck tool — manifest ↔ runtime host-shape guards', () => {
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

describe('cppcheck tool — shared ingestSarif (normalize → envelope)', () => {
  const result = runAcceptanceCase({
    tool: 'cppcheck',
    kind: 'sarif',
    raw: GOLDEN_RAW,
    fingerprintStrategy: 'message-hash',
  });

  it('produces the golden normalized C/C++ signals via the shared SARIF read path', () => {
    expect(result.signals.map(normalizedSignalShape)).toEqual(EXPECTED);
  });

  it('recovers severity from the SARIF level (error → high, warning → medium)', () => {
    expect(result.signals.map((s) => s.severity)).toEqual(['high', 'medium']);
  });

  it('stamps a message-hash fingerprint on every envelope signal worker-side', () => {
    expect(result.envelope.tool).toBe('cppcheck');
    expect(result.envelope.signals).toHaveLength(2);
    for (const s of result.envelope.signals) {
      expect(s.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
