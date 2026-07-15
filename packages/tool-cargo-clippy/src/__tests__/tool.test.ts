/**
 * Tier-1 (in-process) tests for the cargo-clippy adapter `Tool`: the declarative
 * surface (commandSpecs / identity / metadata), the scan-arg helper, the exit
 * model (findingsFromNonzero — clippy exits 0 or 101, never 1), the
 * manifest↔runtime host-shape parity guards, and the full normalize→envelope path
 * via the acceptance harness.
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

import { parseCargoClippyJsonLines } from '../parse-cargo-clippy-json-lines.js';
import { buildScanArgs, CARGO_CLIPPY_STABLE_ID, tool } from '../tool.js';

import type { ToolPluginManifest } from '@opensip-cli/core';
import type { AdapterRunContext, ScannerExitModel } from '@opensip-cli/external-tool-adapter';

const PKG = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { name: string; version: string; opensipTools: Record<string, unknown> };

const GOLDEN_RAW = readFileSync(
  fileURLToPath(new URL('../../__fixtures__/cargo-clippy-golden.jsonl', import.meta.url)),
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

describe('cargo-clippy tool — identity + metadata', () => {
  it('declares the cargo-clippy identity with the `clippy` alias', () => {
    expect(tool.identity).toEqual({
      name: 'cargo-clippy',
      aliases: ['clippy'],
    });
  });

  it('carries the stable UUID, name, and description', () => {
    expect(tool.metadata.id).toBe(CARGO_CLIPPY_STABLE_ID);
    expect(tool.metadata.name).toBe('cargo-clippy');
    expect(tool.metadata.description).toMatch(/cargo clippy/i);
    expect(tool.metadata.description).toMatch(/CARGO_TARGET_DIR|warm target/i);
  });

  it('defaults to the message-hash fingerprint strategy', () => {
    expect(tool.extensionPoints?.fingerprintStrategy?.id).toBe(
      'external-tool-adapter.sha256-file-rule-message',
    );
  });
});

describe('cargo-clippy tool — commandSpecs', () => {
  it('mounts the primary scan plus nested doctor + version', () => {
    expect((tool.commandSpecs ?? []).map((c) => c.name)).toEqual([
      'cargo-clippy',
      'doctor',
      'version',
    ]);
  });

  it('the primary command is project-scoped, raw-stream, aliased `clippy`', () => {
    const primary = byName('cargo-clippy');
    expect(primary?.parent).toBeUndefined();
    expect(primary?.aliases).toEqual(['clippy']);
    expect(primary?.scope).toBe('project');
    expect(primary?.output).toBe('raw-stream');
  });

  it('doctor + version are nested under cargo-clippy, scope:none', () => {
    for (const name of ['doctor', 'version']) {
      expect(byName(name)?.parent).toBe('cargo-clippy');
      expect(byName(name)?.scope).toBe('none');
    }
  });
});

describe('cargo-clippy tool — scan helper', () => {
  it('builds the clippy JSON-message argv across all targets/features', () => {
    const ctx = { projectRoot: '/proj' } as unknown as AdapterRunContext;
    expect(buildScanArgs(ctx)).toEqual([
      'clippy',
      '--message-format=json',
      '--all-targets',
      '--all-features',
    ]);
  });
});

describe('cargo-clippy tool — exit model (findingsFromNonzero — 0 or 101)', () => {
  const model: ScannerExitModel = {
    ok: [0],
    findings: [],
    findingsFromNonzero: true,
  };

  it('exit 0 ⇒ ok', () => {
    expect(interpretExit(0, model)).toBe('ok');
  });

  it('exit 101 + a valid artifact ⇒ findings', () => {
    expect(interpretExit(101, model, { artifactValid: true })).toBe('findings');
  });

  it('exit 101 + a missing/garbage artifact ⇒ fault', () => {
    expect(interpretExit(101, model, { artifactValid: false })).toBe('fault');
  });
});

describe('cargo-clippy tool — manifest ↔ runtime parity (no drift)', () => {
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

describe('cargo-clippy tool — acceptance harness (normalize → envelope)', () => {
  const result = runAcceptanceCase({
    tool: 'cargo-clippy',
    kind: 'stdout',
    raw: GOLDEN_RAW,
    parse: parseCargoClippyJsonLines,
    fingerprintStrategy: 'message-hash',
  });

  it('produces the golden normalized signals (spanless summary skipped)', () => {
    expect(result.signals.map(normalizedSignalShape)).toEqual(EXPECTED);
  });

  it('stamps a message-hash fingerprint on every envelope signal', () => {
    expect(result.envelope.signals).toHaveLength(1);
    for (const s of result.envelope.signals) {
      expect(s.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
