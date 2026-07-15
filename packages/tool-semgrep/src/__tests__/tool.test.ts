/**
 * Tier-1 (in-process) tests for the semgrep adapter `Tool`: the declarative surface
 * (commandSpecs / identity / metadata), the config-discovering scan-arg helper (the
 * `--sarif`/`--error` exit contract), the exit model, the manifest↔runtime
 * host-shape parity guards (networked posture ⇒ a `network` requirement), and the
 * full normalize→envelope path through the acceptance harness (a golden SARIF
 * fixture with CVSS `security-severity` recovery, routed through ingestSarif).
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

import { buildScanArgs, buildSemgrepExclude, SEMGREP_STABLE_ID, tool } from '../tool.js';

import type { ToolPluginManifest } from '@opensip-cli/core';
import type { AdapterRunContext, ScannerExitModel } from '@opensip-cli/external-tool-adapter';

const PKG = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { name: string; version: string; opensipTools: Record<string, unknown> };

const GOLDEN_RAW = readFileSync(
  fileURLToPath(new URL('../../__fixtures__/semgrep-golden.sarif', import.meta.url)),
  'utf8',
);
const EXPECTED = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../__fixtures__/expected-signals.json', import.meta.url)),
    'utf8',
  ),
) as unknown[];

function manifestFromPackage(): ToolPluginManifest {
  return {
    ...(PKG.opensipTools as object),
    name: PKG.name,
    version: PKG.version,
    apiVersion: PKG.opensipTools.apiVersion as number,
  } as ToolPluginManifest;
}

const byName = (name: string) => tool.commandSpecs?.find((c) => c.name === name);

const ctxFor = (projectRoot: string): AdapterRunContext =>
  ({
    projectRoot,
    artifactPath: (name: string) => `${projectRoot}/.runtime/artifacts/semgrep/run1/${name}`,
  }) as unknown as AdapterRunContext;

describe('semgrep tool — identity + metadata', () => {
  it('declares the semgrep identity and stable UUID', () => {
    expect(tool.identity).toEqual({ name: 'semgrep' });
    expect(tool.metadata.id).toBe(SEMGREP_STABLE_ID);
    expect(tool.metadata.name).toBe('semgrep');
    expect(tool.metadata.description).toBe('Static analysis via Semgrep');
  });

  it('mounts the primary scan plus nested doctor + version', () => {
    expect((tool.commandSpecs ?? []).map((c) => c.name)).toEqual(['semgrep', 'doctor', 'version']);
    expect(byName('semgrep')?.scope).toBe('project');
    for (const name of ['doctor', 'version']) {
      expect(byName(name)?.parent).toBe('semgrep');
      expect(byName(name)?.scope).toBe('none');
    }
  });
});

describe('semgrep tool — scan helper', () => {
  it('falls back to --config auto when no local config exists, writing SARIF with --error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'semgrep-auto-'));
    const args = buildScanArgs(ctxFor(dir));
    expect(args).toEqual([
      'scan',
      '--config',
      'auto',
      '--sarif',
      '--output',
      `${dir}/.runtime/artifacts/semgrep/run1/semgrep.sarif`,
      '--error',
      dir,
    ]);
    // The exit contract (findings ⇒ nonzero) + the SARIF report both required.
    expect(args).toContain('--error');
    expect(args).toContain('--sarif');
  });

  it('uses a discovered local config file over --config auto', () => {
    const dir = mkdtempSync(join(tmpdir(), 'semgrep-cfg-'));
    const cfg = join(dir, 'semgrep.yml');
    writeFileSync(cfg, 'rules: []\n');
    expect(buildScanArgs(ctxFor(dir))[2]).toBe(cfg);
  });

  it('excludes the .runtime store via a relative --exclude segment', () => {
    expect(buildSemgrepExclude({ excludePath: '/proj/opensip-cli/.runtime' }).args).toEqual([
      '--exclude',
      'opensip-cli/.runtime',
    ]);
  });
});

describe('semgrep tool — version probe (covers the binary versionParse)', () => {
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
          semgrep: { binaries: { semgrep: { path: process.execPath } } },
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

describe('semgrep tool — exit model', () => {
  const model: ScannerExitModel = { ok: [0], findings: [1], errorFrom: 2 };
  it('0 ⇒ ok, 1 ⇒ findings, >=2 ⇒ fault', () => {
    expect(interpretExit(0, model)).toBe('ok');
    expect(interpretExit(1, model)).toBe('findings');
    expect(interpretExit(2, model)).toBe('fault');
  });
});

describe('semgrep tool — manifest ↔ runtime parity (no drift)', () => {
  it('the package.json manifest matches the runtime tool', () => {
    expect(() => {
      assertManifestMatchesTool(manifestFromPackage(), tool);
    }).not.toThrow();
  });

  it('generated manifest commands equal the derived runtime command shells', () => {
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

  it('the networked posture derives a network requirement (subprocess + filesystem + network)', () => {
    expect(PKG.opensipTools.requires).toEqual(deriveAdapterManifestRequires(tool));
    expect((PKG.opensipTools.requires as { resource: string }[]).map((r) => r.resource)).toEqual([
      'subprocess',
      'filesystem',
      'network',
    ]);
    expect(PKG.opensipTools.config).toEqual(deriveAdapterConfigManifest(tool));
  });
});

describe('semgrep tool — acceptance harness (normalize → envelope)', () => {
  const result = runAcceptanceCase({
    tool: 'semgrep',
    kind: 'sarif',
    raw: GOLDEN_RAW,
    fingerprintStrategy: 'message-hash',
  });

  it('recovers severity from CVSS security-severity, else the SARIF level', () => {
    expect(result.signals.map(normalizedSignalShape)).toEqual(EXPECTED);
    // The first rule carries security-severity 8.5 ⇒ the FIRST/NVD high band.
    expect(result.signals[0]?.severity).toBe('high');
    expect(result.signals[0]?.metadata?.securitySeverity).toBe('8.5');
  });

  it('builds an envelope whose verdict FAILS (a high-severity finding is error-rung)', () => {
    expect(result.envelope.tool).toBe('semgrep');
    expect(result.envelope.verdict.passed).toBe(false);
  });

  it('stamps a message-hash fingerprint on every envelope signal', () => {
    expect(result.envelope.signals).toHaveLength(2);
    for (const s of result.envelope.signals) {
      expect(s.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
