/**
 * Tier-1 (in-process) tests for the gitleaks adapter `Tool` (ADR-0090 D6 Tier 1).
 *
 * Asserts the declarative surface (commandSpecs / identity / metadata), the binary
 * helpers (version parse + scan args), the FROZEN exit model (Phase-0 decision 4),
 * the manifest↔runtime host-shape guards (`assertManifestMatchesTool` +
 * `deriveAdapterManifestCommands` parity), and the full normalize→envelope path
 * via the acceptance harness — including a redaction check across the envelope.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { assertManifestMatchesTool } from '@opensip-cli/core';
import {
  DEFAULT_EXIT_MODEL,
  deriveAdapterManifestCommands,
  interpretExit,
  normalizedSignalShape,
  runAcceptanceCase,
} from '@opensip-cli/external-tool-adapter';
import { describe, expect, it } from 'vitest';

import { parseGitleaksJson } from '../parse-gitleaks-json.js';
import {
  buildGitleaksExclude,
  buildScanArgs,
  GITLEAKS_STABLE_ID,
  parseGitleaksVersion,
  tool,
} from '../tool.js';

import type { ToolPluginManifest } from '@opensip-cli/core';
import type { AdapterRunContext, ScannerExitModel } from '@opensip-cli/external-tool-adapter';

const PKG = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { name: string; version: string; opensipTools: Record<string, unknown> };

const GOLDEN_RAW = readFileSync(
  fileURLToPath(new URL('../../__fixtures__/gitleaks-golden.json', import.meta.url)),
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

describe('gitleaks tool — identity + metadata', () => {
  it('declares the gitleaks identity with the `secrets` alias', () => {
    expect(tool.identity).toEqual({ name: 'gitleaks', aliases: ['secrets'] });
  });

  it('carries the stable UUID and a description', () => {
    expect(tool.metadata.id).toBe(GITLEAKS_STABLE_ID);
    expect(tool.metadata.name).toBe('gitleaks');
    expect(tool.metadata.description).toBe('Secret scanning via Gitleaks');
  });

  it('defaults to the line-shift-tolerant message-hash fingerprint strategy', () => {
    expect(tool.extensionPoints?.fingerprintStrategy?.id).toBe(
      'external-tool-adapter.sha256-file-rule-message',
    );
  });
});

const byName = (name: string) => tool.commandSpecs?.find((c) => c.name === name);

describe('gitleaks tool — commandSpecs', () => {
  it('mounts the primary scan, plus nested doctor + version', () => {
    const names = (tool.commandSpecs ?? []).map((c) => c.name);
    expect(names).toEqual(['gitleaks', 'doctor', 'version']);
  });

  it('the primary command is `gitleaks` (aliased `secrets`), project-scoped, raw-stream dispatch', () => {
    const primary = byName('gitleaks');
    expect(primary?.parent).toBeUndefined();
    expect(primary?.aliases).toEqual(['secrets']);
    expect(primary?.scope).toBe('project');
    expect(primary?.output).toBe('raw-stream');
    expect(primary?.rawStreamReason).toBe('runtime-render-dispatch');
  });

  it('doctor + version are nested under gitleaks, scope:none, diagnostic-gate', () => {
    for (const name of ['doctor', 'version']) {
      const spec = byName(name);
      expect(spec?.parent).toBe('gitleaks');
      expect(spec?.scope).toBe('none');
      expect(spec?.output).toBe('raw-stream');
      expect(spec?.rawStreamReason).toBe('diagnostic-gate');
    }
  });
});

describe('gitleaks tool — binary helpers', () => {
  it('parses the gitleaks version stdout (with or without a leading v)', () => {
    expect(parseGitleaksVersion('8.18.4')).toBe('8.18.4');
    expect(parseGitleaksVersion('v8.18.4\n')).toBe('8.18.4');
    expect(parseGitleaksVersion('gitleaks version 8.19.0')).toBe('8.19.0');
  });

  it('falls back to the trimmed stdout when no semver is present', () => {
    expect(parseGitleaksVersion('  unknown  ')).toBe('unknown');
  });

  it('builds the filesystem-scan argv writing JSON to the run artifact path', () => {
    const ctx = {
      projectRoot: '/proj',
      artifactPath: (name: string) => `/proj/.runtime/artifacts/gitleaks/run1/${name}`,
    } as unknown as AdapterRunContext;
    expect(buildScanArgs(ctx)).toEqual([
      'detect',
      '--no-git',
      '--source',
      '/proj',
      '--report-format',
      'json',
      '--report-path',
      '/proj/.runtime/artifacts/gitleaks/run1/gitleaks.json',
    ]);
  });
});

describe('gitleaks tool — A3 .runtime exclusion (buildGitleaksExclude)', () => {
  const ex = buildGitleaksExclude({
    excludePath: '/proj/opensip-cli/.runtime',
    configPath: (name) => `/proj/opensip-cli/.runtime/artifacts/gitleaks/run1/${name}`,
  });

  it('references a generated --config allowlist written to the per-run dir', () => {
    const cfg = '/proj/opensip-cli/.runtime/artifacts/gitleaks/run1/gitleaks-exclude.toml';
    expect(ex.args).toEqual(['--config', cfg]);
    expect(ex.configFile.path).toBe(cfg);
  });

  it('extends the default ruleset and allowlists the .runtime store (with the E2E marker)', () => {
    expect(ex.configFile.contents).toContain('useDefault = true');
    // The allowlist path regex matches any file under opensip-cli/.runtime.
    expect(ex.configFile.contents).toContain('opensip-cli/\\.runtime');
    // The marker the deterministic worker-E2E fake reads to honor the exclusion.
    expect(ex.configFile.contents).toContain('# opensip-cli A3 exclude: opensip-cli/.runtime');
  });
});

describe('gitleaks tool — exit model (Phase-0 decision 4)', () => {
  const model: ScannerExitModel = { ok: [0], findings: [1], errorFrom: 2 };

  it('exit 0 ⇒ clean (no findings)', () => {
    expect(interpretExit(0, model)).toBe('ok');
  });

  it('exit 1 + a valid artifact ⇒ findings', () => {
    expect(interpretExit(1, model, { artifactValid: true })).toBe('findings');
  });

  it('exit 1 + a missing/garbage artifact ⇒ fault (the gitleaks disambiguation)', () => {
    expect(interpretExit(1, model, { artifactValid: false })).toBe('fault');
  });

  it('exit >= 2 ⇒ fault', () => {
    expect(interpretExit(2, model)).toBe('fault');
    expect(interpretExit(7, model)).toBe('fault');
  });

  it('matches the substrate default model', () => {
    expect(model).toEqual(DEFAULT_EXIT_MODEL);
  });
});

describe('gitleaks tool — manifest ↔ runtime host-shape guards', () => {
  it('the package.json manifest matches the runtime tool (no drift)', () => {
    expect(() => {
      assertManifestMatchesTool(manifestFromPackage(), tool);
    }).not.toThrow();
  });

  it('the generated manifest commands equal the derived runtime command shells', () => {
    // The package.json `commands` are written by the shared manifest generator
    // (which OMITS an empty `aliases`), while the substrate's
    // `deriveAdapterManifestCommands` always emits `aliases: []`. Canonicalize
    // that one representational difference (`aliases ?? []`) before comparing the
    // substantive shells.
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

  it('declares subprocess + filesystem resource needs (local-only posture)', () => {
    expect(PKG.opensipTools.requires).toEqual([
      {
        resource: 'subprocess',
        reason: 'Executes the user-installed gitleaks binary via execFile (no shell)',
      },
      {
        resource: 'filesystem',
        reason:
          'Reads the project working tree and writes the raw scan artifact under .runtime/artifacts',
      },
    ]);
  });
});

describe('gitleaks tool — acceptance harness (normalize → envelope)', () => {
  const result = runAcceptanceCase({
    tool: 'gitleaks',
    kind: 'json',
    raw: GOLDEN_RAW,
    parse: parseGitleaksJson,
    fingerprintStrategy: 'message-hash',
  });

  it('produces the golden normalized signals', () => {
    expect(result.signals.map(normalizedSignalShape)).toEqual(EXPECTED);
  });

  it('builds an envelope whose verdict FAILS (high-severity secrets are error-rung)', () => {
    expect(result.envelope.tool).toBe('gitleaks');
    expect(result.envelope.verdict.passed).toBe(false);
  });

  it('stamps a message-hash fingerprint on every envelope signal worker-side', () => {
    expect(result.envelope.signals).toHaveLength(2);
    for (const s of result.envelope.signals) {
      expect(s.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('NEVER lets a raw secret into the built envelope (secret-egress guard)', () => {
    const serialized = JSON.stringify(result.envelope);
    for (const raw of ['AKIAIOSFODNN7EXAMPLE', 'glpat-XXXXXXXXXXXXXXXXXXXX', 'aws_key =']) {
      expect(serialized).not.toContain(raw);
    }
  });
});
