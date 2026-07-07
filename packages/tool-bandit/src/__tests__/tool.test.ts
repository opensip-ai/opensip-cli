/**
 * Tier-1 (in-process) tests for the bandit adapter `Tool`: the declarative surface
 * (commandSpecs / identity / metadata), the binary + scan-arg helpers, the exit
 * model, the manifest↔runtime host-shape parity guards, and the full
 * normalize→envelope path through the acceptance harness (with a golden fixture).
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

import { parseBanditJson } from '../parse-bandit-json.js';
import { BANDIT_STABLE_ID, buildBanditExclude, buildScanArgs, tool } from '../tool.js';

import type { ToolPluginManifest } from '@opensip-cli/core';
import type { AdapterRunContext, ScannerExitModel } from '@opensip-cli/external-tool-adapter';

const PKG = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { name: string; version: string; opensipTools: Record<string, unknown> };

const GOLDEN_RAW = readFileSync(
  fileURLToPath(new URL('../../__fixtures__/bandit-golden.json', import.meta.url)),
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

describe('bandit tool — identity + metadata', () => {
  it('declares the bandit identity and stable UUID', () => {
    expect(tool.identity).toEqual({ name: 'bandit' });
    expect(tool.metadata.id).toBe(BANDIT_STABLE_ID);
    expect(tool.metadata.name).toBe('bandit');
    expect(tool.metadata.description).toBe('Python security scanning via Bandit');
  });

  it('defaults to the line-shift-tolerant message-hash fingerprint strategy', () => {
    expect(tool.extensionPoints?.fingerprintStrategy?.id).toBe(
      'external-tool-adapter.sha256-file-rule-message',
    );
  });

  it('mounts the primary scan plus nested doctor + version', () => {
    expect((tool.commandSpecs ?? []).map((c) => c.name)).toEqual(['bandit', 'doctor', 'version']);
    expect(byName('bandit')?.output).toBe('raw-stream');
    expect(byName('bandit')?.scope).toBe('project');
    for (const name of ['doctor', 'version']) {
      expect(byName(name)?.parent).toBe('bandit');
      expect(byName(name)?.scope).toBe('none');
    }
  });
});

describe('bandit tool — binary + scan helpers', () => {
  it('builds the recursive scan argv writing JSON to the run artifact path', () => {
    const ctx = {
      projectRoot: '/proj',
      artifactPath: (name: string) => `/proj/.runtime/artifacts/bandit/run1/${name}`,
    } as unknown as AdapterRunContext;
    expect(buildScanArgs(ctx)).toEqual([
      '-r',
      '/proj',
      '-f',
      'json',
      '-o',
      '/proj/.runtime/artifacts/bandit/run1/bandit.json',
    ]);
  });

  it('excludes the .runtime store via -x', () => {
    expect(buildBanditExclude({ excludePath: '/proj/opensip-cli/.runtime' }).args).toEqual([
      '-x',
      '/proj/opensip-cli/.runtime',
    ]);
  });
});

describe('bandit tool — exit model', () => {
  const model: ScannerExitModel = { ok: [0], findings: [1], errorFrom: 2 };
  it('0 ⇒ ok, 1 ⇒ findings, >=2 ⇒ fault', () => {
    expect(interpretExit(0, model)).toBe('ok');
    expect(interpretExit(1, model)).toBe('findings');
    expect(interpretExit(2, model)).toBe('fault');
  });
});

describe('bandit tool — manifest ↔ runtime parity (no drift)', () => {
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

  it('generated manifest requires + config equal the substrate derivations (local-only ⇒ no network)', () => {
    expect(PKG.opensipTools.requires).toEqual(deriveAdapterManifestRequires(tool));
    expect((PKG.opensipTools.requires as { resource: string }[]).map((r) => r.resource)).toEqual([
      'subprocess',
      'filesystem',
    ]);
    expect(PKG.opensipTools.config).toEqual(deriveAdapterConfigManifest(tool));
  });
});

describe('bandit tool — acceptance harness (normalize → envelope)', () => {
  const result = runAcceptanceCase({
    tool: 'bandit',
    kind: 'json',
    raw: GOLDEN_RAW,
    parse: parseBanditJson,
    fingerprintStrategy: 'message-hash',
  });

  it('produces the golden normalized signals', () => {
    expect(result.signals.map(normalizedSignalShape)).toEqual(EXPECTED);
  });

  it('builds an envelope whose verdict FAILS (a HIGH finding is error-rung)', () => {
    expect(result.envelope.tool).toBe('bandit');
    expect(result.envelope.verdict.passed).toBe(false);
  });

  it('stamps a message-hash fingerprint on every envelope signal', () => {
    expect(result.envelope.signals).toHaveLength(3);
    for (const s of result.envelope.signals) {
      expect(s.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
