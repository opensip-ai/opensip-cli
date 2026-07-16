/**
 * Tier-1 (in-process) tests for the govulncheck adapter `Tool`: the declarative
 * surface (commandSpecs / identity / metadata), the scan-arg helper, the exit
 * model, the manifest↔runtime host-shape parity guards, and the full
 * normalize→envelope path via the acceptance harness.
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

import { parseGovulncheckJsonLines } from '../parse-govulncheck-json-lines.js';
import { buildScanArgs, GOVULNCHECK_STABLE_ID, tool } from '../tool.js';

import type { ToolPluginManifest } from '@opensip-cli/core';
import type { AdapterRunContext, ScannerExitModel } from '@opensip-cli/external-tool-adapter';

const PKG = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { name: string; version: string; opensipTools: Record<string, unknown> };

const GOLDEN_RAW = readFileSync(
  fileURLToPath(new URL('../../__fixtures__/govulncheck-golden.jsonl', import.meta.url)),
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

describe('govulncheck tool — identity + metadata', () => {
  it('declares the govulncheck identity (no aliases)', () => {
    expect(tool.identity).toEqual({ name: 'govulncheck' });
  });

  it('carries the stable UUID, name, and description', () => {
    expect(tool.metadata.id).toBe(GOVULNCHECK_STABLE_ID);
    expect(tool.metadata.name).toBe('govulncheck');
    expect(tool.metadata.description).toBe('Go vulnerability scanning via govulncheck');
  });

  it('defaults to the message-hash fingerprint strategy', () => {
    expect(tool.extensionPoints?.fingerprintStrategy?.id).toBe(
      'external-tool-adapter.sha256-file-rule-message',
    );
  });
});

describe('govulncheck tool — commandSpecs', () => {
  it('mounts the primary scan plus nested doctor + version', () => {
    expect((tool.commandSpecs ?? []).map((c) => c.name)).toEqual([
      'govulncheck',
      'doctor',
      'version',
    ]);
  });

  it('the primary command is project-scoped and raw-stream', () => {
    const primary = byName('govulncheck');
    expect(primary?.parent).toBeUndefined();
    expect(primary?.scope).toBe('project');
    expect(primary?.output).toBe('raw-stream');
  });

  it('doctor + version are nested under govulncheck, scope:none', () => {
    for (const name of ['doctor', 'version']) {
      expect(byName(name)?.parent).toBe('govulncheck');
      expect(byName(name)?.scope).toBe('none');
    }
  });
});

describe('govulncheck tool — scan helper', () => {
  it('builds the `-json ./...` argv', () => {
    const ctx = { projectRoot: '/proj' } as unknown as AdapterRunContext;
    expect(buildScanArgs(ctx)).toEqual(['-json', './...']);
  });
});

describe('govulncheck tool — exit model', () => {
  // -json always exits 0; findings come from parse. Nonzero is fault.
  const model: ScannerExitModel = { ok: [0], findings: [], errorFrom: 1 };

  it('exit 0 ⇒ ok', () => {
    expect(interpretExit(0, model)).toBe('ok');
  });

  it('exit 1/2/3 (analysis error) ⇒ fault', () => {
    expect(interpretExit(1, model)).toBe('fault');
    expect(interpretExit(2, model)).toBe('fault');
    expect(interpretExit(3, model)).toBe('fault');
  });
});

describe('govulncheck tool — manifest ↔ runtime parity (no drift)', () => {
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

  it('generated manifest requires + config equal the substrate derivations', () => {
    expect(PKG.opensipTools.requires).toEqual(deriveAdapterManifestRequires(tool));
    expect(PKG.opensipTools.config).toEqual(deriveAdapterConfigManifest(tool));
  });
});

describe('govulncheck tool — acceptance harness (normalize → envelope)', () => {
  const result = runAcceptanceCase({
    tool: 'govulncheck',
    kind: 'stdout',
    raw: GOLDEN_RAW,
    parse: parseGovulncheckJsonLines,
    fingerprintStrategy: 'message-hash',
  });

  it('produces the golden normalized signals (dedup: 3 findings → 2 signals)', () => {
    expect(result.signals.map(normalizedSignalShape)).toEqual(EXPECTED);
  });

  it('stamps a message-hash fingerprint on every envelope signal', () => {
    expect(result.envelope.signals).toHaveLength(2);
    for (const s of result.envelope.signals) {
      expect(s.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
