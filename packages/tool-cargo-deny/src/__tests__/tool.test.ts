/**
 * Tier-1 (in-process) tests for the cargo-deny adapter `Tool`: the declarative
 * surface (commandSpecs / identity / metadata), the scan-arg helper, the exit
 * model (findingsFromNonzero bitset scanner), the manifest↔runtime host-shape
 * parity guards, and the full normalize→envelope path via the acceptance harness.
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

import { parseCargoDenyJsonLines } from '../parse-cargo-deny-json-lines.js';
import { buildScanArgs, CARGO_DENY_STABLE_ID, tool } from '../tool.js';

import type { ToolPluginManifest } from '@opensip-cli/core';
import type { AdapterRunContext, ScannerExitModel } from '@opensip-cli/external-tool-adapter';

const PKG = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { name: string; version: string; opensipTools: Record<string, unknown> };

const GOLDEN_RAW = readFileSync(
  fileURLToPath(new URL('../../__fixtures__/cargo-deny-golden.jsonl', import.meta.url)),
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

describe('cargo-deny tool — identity + metadata', () => {
  it('declares the cargo-deny identity with the `deny` alias', () => {
    expect(tool.identity).toEqual({ name: 'cargo-deny', aliases: ['deny'] });
  });

  it('carries the stable UUID, name, and description', () => {
    expect(tool.metadata.id).toBe(CARGO_DENY_STABLE_ID);
    expect(tool.metadata.name).toBe('cargo-deny');
    expect(tool.metadata.description).toBe('Rust dependency policy checks via cargo-deny');
  });

  it('defaults to the message-hash fingerprint strategy', () => {
    expect(tool.extensionPoints?.fingerprintStrategy?.id).toBe(
      'external-tool-adapter.sha256-file-rule-message',
    );
  });
});

describe('cargo-deny tool — commandSpecs', () => {
  it('mounts the primary scan plus nested doctor + version', () => {
    expect((tool.commandSpecs ?? []).map((c) => c.name)).toEqual([
      'cargo-deny',
      'doctor',
      'version',
    ]);
  });

  it('the primary command is project-scoped, raw-stream, aliased `deny`', () => {
    const primary = byName('cargo-deny');
    expect(primary?.parent).toBeUndefined();
    expect(primary?.aliases).toEqual(['deny']);
    expect(primary?.scope).toBe('project');
    expect(primary?.output).toBe('raw-stream');
  });

  it('doctor + version are nested under cargo-deny, scope:none', () => {
    for (const name of ['doctor', 'version']) {
      expect(byName(name)?.parent).toBe('cargo-deny');
      expect(byName(name)?.scope).toBe('none');
    }
  });
});

describe('cargo-deny tool — scan helper', () => {
  it('places the top-level `--format` option before the `check` subcommand', () => {
    const ctx = { projectRoot: '/proj' } as unknown as AdapterRunContext;
    expect(buildScanArgs(ctx)).toEqual(['--format', 'json', 'check']);
  });
});

describe('cargo-deny tool — exit model (findingsFromNonzero bitset scanner)', () => {
  // cargo-deny ORs per-check category bits; any nonzero with a parseable artifact is
  // findings, otherwise a fault.
  const model: ScannerExitModel = {
    ok: [0],
    findings: [],
    findingsFromNonzero: true,
  };

  it('exit 0 ⇒ ok', () => {
    expect(interpretExit(0, model)).toBe('ok');
  });

  it('nonzero + a valid artifact ⇒ findings', () => {
    expect(interpretExit(4, model, { artifactValid: true })).toBe('findings');
    expect(interpretExit(15, model, { artifactValid: true })).toBe('findings');
  });

  it('nonzero + a missing/garbage artifact ⇒ fault', () => {
    expect(interpretExit(4, model, { artifactValid: false })).toBe('fault');
  });
});

describe('cargo-deny tool — manifest ↔ runtime parity (no drift)', () => {
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

describe('cargo-deny tool — acceptance harness (normalize → envelope)', () => {
  const result = runAcceptanceCase({
    tool: 'cargo-deny',
    kind: 'stdout',
    raw: GOLDEN_RAW,
    parse: parseCargoDenyJsonLines,
    fingerprintStrategy: 'message-hash',
  });

  it('produces the golden normalized signals (summary line ignored)', () => {
    expect(result.signals.map(normalizedSignalShape)).toEqual(EXPECTED);
  });

  it('stamps a message-hash fingerprint on every envelope signal', () => {
    expect(result.envelope.signals).toHaveLength(2);
    for (const s of result.envelope.signals) {
      expect(s.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
