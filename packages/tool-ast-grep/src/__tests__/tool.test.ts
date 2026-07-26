/**
 * Tier-1 (in-process) tests for the ast-grep adapter `Tool`: the declarative
 * surface (commandSpecs / identity / aliases / metadata), the config-required
 * scan-arg helper, the stdout-SARIF parse fn, the exit model, the manifest↔runtime
 * host-shape parity guards, and the full normalize→envelope path through the
 * acceptance harness (with a golden SARIF fixture routed through ingestSarif).
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

import {
  AST_GREP_STABLE_ID,
  buildAstGrepExclude,
  buildScanArgs,
  parseAstGrepSarif,
  tool,
} from '../tool.js';

import type { ToolPluginManifest } from '@opensip-cli/core';
import type {
  AdapterRunContext,
  ParsedScannerOutput,
  ScannerExitModel,
} from '@opensip-cli/external-tool-adapter';

const PKG = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { name: string; version: string; opensipTools: Record<string, unknown> };

const GOLDEN_RAW = readFileSync(
  fileURLToPath(new URL('../../__fixtures__/ast-grep-golden.sarif', import.meta.url)),
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

describe('ast-grep tool — identity + metadata', () => {
  it('declares the ast-grep identity with the `sg` alias and stable UUID', () => {
    expect(tool.identity).toEqual({ name: 'ast-grep', aliases: ['sg'] });
    expect(tool.metadata.id).toBe(AST_GREP_STABLE_ID);
    expect(tool.metadata.name).toBe('ast-grep');
    expect(tool.metadata.description).toBe('Structural code scanning via ast-grep');
  });

  it('mounts the primary scan (aliased sg) plus nested doctor + version', () => {
    expect((tool.commandSpecs ?? []).map((c) => c.name)).toEqual(['ast-grep', 'doctor', 'version']);
    expect(byName('ast-grep')?.aliases).toEqual(['sg']);
    expect(byName('ast-grep')?.scope).toBe('project');
    for (const name of ['doctor', 'version']) {
      expect(byName(name)?.parent).toBe('ast-grep');
      expect(byName(name)?.scope).toBe('none');
    }
  });
});

describe('ast-grep tool — scan helper', () => {
  it('builds the SARIF scan argv against a discovered sgconfig.yml', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ast-grep-cfg-'));
    const cfg = join(dir, 'sgconfig.yml');
    writeFileSync(cfg, 'ruleDirs:\n  - rules\n');
    expect(buildScanArgs({ projectRoot: dir } as unknown as AdapterRunContext)).toEqual([
      'scan',
      '--config',
      cfg,
      '--format',
      'sarif',
      '.',
    ]);
  });

  it('throws ADAPTER.CONFIG.MISSING when no sgconfig / .ast-grep file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ast-grep-nocfg-'));
    expect(() => buildScanArgs({ projectRoot: dir } as unknown as AdapterRunContext)).toThrow(
      /ast-grep requires an sgconfig/,
    );
  });

  it('excludes the .runtime store via relative --globs (!path/**)', () => {
    expect(buildAstGrepExclude({ excludePath: '/proj/opensip-cli/.runtime' }).args).toEqual([
      '--globs',
      '!opensip-cli/.runtime/**',
    ]);
  });
});

describe('ast-grep tool — stdout SARIF parse', () => {
  it('normalizes the stdout SARIF document into golden signals (source = tool)', () => {
    const raw: ParsedScannerOutput = { kind: 'stdout', raw: GOLDEN_RAW };
    const ctx = {
      tool: 'ast-grep',
      projectRoot: '/proj',
    } as unknown as AdapterRunContext;
    expect(parseAstGrepSarif(raw, ctx).map(normalizedSignalShape)).toEqual(EXPECTED);
  });

  it('throws ADAPTER.ARTIFACT.INVALID on non-JSON stdout', () => {
    const raw: ParsedScannerOutput = { kind: 'stdout', raw: 'not sarif' };
    const ctx = {
      tool: 'ast-grep',
      projectRoot: '/proj',
    } as unknown as AdapterRunContext;
    // Assert the stable error CODE (the contract), not the human message text:
    // the shared external-tool-adapter owns the SARIF-invalid wording (OBS-SARIF /
    // ADR-0175 centralization), which must be free to change without breaking
    // every consuming scanner's test.
    expect(() => parseAstGrepSarif(raw, ctx)).toThrow(
      expect.objectContaining({ code: 'EXTERNAL.SCANNER.ARTIFACT_INVALID' }),
    );
  });
});

describe('ast-grep tool — version probe (covers the binary versionParse)', () => {
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
          'ast-grep': { binaries: { 'ast-grep': { path: process.execPath } } },
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

describe('ast-grep tool — exit model', () => {
  const model: ScannerExitModel = { ok: [0], findings: [1], errorFrom: 2 };
  it('0 ⇒ ok, 1 ⇒ findings, >=2 ⇒ fault', () => {
    expect(interpretExit(0, model)).toBe('ok');
    expect(interpretExit(1, model)).toBe('findings');
    expect(interpretExit(2, model)).toBe('fault');
  });
});

describe('ast-grep tool — manifest ↔ runtime parity (no drift)', () => {
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

  it('local-only posture derives subprocess + filesystem (no network); config parity holds', () => {
    expect(PKG.opensipTools.requires).toEqual(deriveAdapterManifestRequires(tool));
    expect((PKG.opensipTools.requires as { resource: string }[]).map((r) => r.resource)).toEqual([
      'subprocess',
      'filesystem',
    ]);
    expect(PKG.opensipTools.config).toEqual(deriveAdapterConfigManifest(tool));
  });
});

describe('ast-grep tool — acceptance harness (normalize → envelope)', () => {
  const result = runAcceptanceCase({
    tool: 'ast-grep',
    kind: 'sarif',
    raw: GOLDEN_RAW,
    fingerprintStrategy: 'message-hash',
  });

  it('produces the golden normalized signals via the shared ingestSarif', () => {
    expect(result.signals.map(normalizedSignalShape)).toEqual(EXPECTED);
  });

  it('stamps a message-hash fingerprint on every envelope signal', () => {
    expect(result.envelope.signals).toHaveLength(2);
    for (const s of result.envelope.signals) {
      expect(s.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
