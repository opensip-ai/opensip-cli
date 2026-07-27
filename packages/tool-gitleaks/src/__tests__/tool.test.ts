/**
 * Tier-1 (in-process) tests for the gitleaks adapter `Tool` (ADR-0090 D6 Tier 1).
 *
 * Asserts the declarative surface (commandSpecs / identity / metadata), the binary
 * helpers (version parse + scan args), the FROZEN exit model (Phase-0 decision 4),
 * the manifest↔runtime host-shape guards (`assertManifestMatchesTool` +
 * `deriveAdapterManifestCommands` parity), and the full normalize→envelope path
 * via the acceptance harness — including a redaction check across the envelope.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertManifestMatchesTool } from '@opensip-cli/core';
import {
  DEFAULT_EXIT_MODEL,
  deriveAdapterConfigManifest,
  deriveAdapterManifestCommands,
  deriveAdapterManifestRequires,
  interpretExit,
  normalizedSignalShape,
  runAcceptanceCase,
} from '@opensip-cli/external-tool-adapter';
import { makeTestScope, withScopeSync } from '@opensip-cli/test-support';
import { describe, expect, it } from 'vitest';

import { parseGitleaksJson } from '../parse-gitleaks-json.js';
import {
  buildGitleaksExclude,
  buildScanArgs,
  GITLEAKS_STABLE_ID,
  parseGitleaksVersion,
  tool,
} from '../tool.js';

import type { Logger, ToolPluginManifest } from '@opensip-cli/core';
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
      '.',
      '--report-format',
      'json',
      '--report-path',
      '/proj/.runtime/artifacts/gitleaks/run1/gitleaks.json',
    ]);
  });

  it('uses a project-relative scan source because the scanner runs from projectRoot', () => {
    const ctx = {
      projectRoot: '/proj',
      artifactPath: (name: string) => `/proj/.runtime/artifacts/gitleaks/run1/${name}`,
    } as unknown as AdapterRunContext;
    const args = buildScanArgs(ctx);
    expect(args.slice(args.indexOf('--source'), args.indexOf('--source') + 2)).toEqual([
      '--source',
      '.',
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

  it('extends the default ruleset when the project has no gitleaks config', () => {
    // /proj has no .gitleaks.toml in the test environment → useDefault.
    expect(ex.configFile.contents).toContain('useDefault = true');
    expect(ex.configFile.contents).not.toMatch(/^path\s*=/m);
    // The allowlist path regex matches any file under opensip-cli/.runtime.
    expect(ex.configFile.contents).toContain('opensip-cli/\\.runtime');
    // The marker the deterministic worker-E2E fake reads to honor the exclusion.
    expect(ex.configFile.contents).toContain('# opensip-cli A3 exclude: opensip-cli/.runtime');
  });

  it('uses the legacy global allowlist form supported by the minimum Gitleaks 8.18', () => {
    expect(ex.configFile.contents).toMatch(/(?:^|\n)\[allowlist\](?:\n|$)/);
    expect(ex.configFile.contents).not.toContain('[[allowlists]]');
  });

  it('inlines the project .gitleaks.toml when present (no extra extend hop)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitleaks-cfg-'));
    const projectToml = join(dir, '.gitleaks.toml');
    writeFileSync(projectToml, '[extend]\nuseDefault = true\n');
    const withProject = buildGitleaksExclude({
      excludePath: join(dir, 'opensip-cli', '.runtime'),
      configPath: (name) => join(dir, 'opensip-cli', '.runtime', name),
    });
    // Flattened: project body is copied (preserves its own useDefault), no path= hop.
    expect(withProject.configFile.contents).toContain('useDefault = true');
    expect(withProject.configFile.contents).not.toMatch(/^path\s*=/m);
    expect(withProject.configFile.contents).toContain('opensip-cli/\\.runtime');
    expect(withProject.configFile.contents).toContain('[allowlist]');
    expect(withProject.configFile.contents).toContain(
      '# opensip-cli A3 exclude: opensip-cli/.runtime',
    );
  });

  it('merges the runtime path into a legacy [allowlist] instead of emitting an invalid duplicate', () => {
    for (const header of ['[allowlist]', '[allowlist] # retained for Gitleaks 8.18']) {
      const dir = mkdtempSync(join(tmpdir(), 'gitleaks-legacy-al-'));
      const projectToml = join(dir, '.gitleaks.toml');
      writeFileSync(
        projectToml,
        `[extend]\nuseDefault = true\n\n${header}\npaths = ['''vendor''']\n`,
      );
      const withProject = buildGitleaksExclude({
        excludePath: join(dir, 'opensip-cli', '.runtime'),
        configPath: (name) => join(dir, 'opensip-cli', '.runtime', name),
      });
      const legacyHeaders = withProject.configFile.contents.match(/^\s*\[allowlist\]/gm) ?? [];
      expect(legacyHeaders).toHaveLength(1);
      expect(withProject.configFile.contents).not.toContain('[[allowlists]]');
      expect(withProject.configFile.contents).toContain("'''vendor'''");
      expect(withProject.configFile.contents).toContain('opensip-cli/\\.runtime');
    }
  });

  it('merges into a quoted legacy paths key without adding a duplicate TOML key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitleaks-quoted-paths-'));
    writeFileSync(
      join(dir, '.gitleaks.toml'),
      `[extend]\nuseDefault = true\n\n[allowlist]\n"paths" = ['''vendor''']\n`,
    );
    const withProject = buildGitleaksExclude({
      excludePath: join(dir, 'opensip-cli', '.runtime'),
      configPath: (name) => join(dir, 'opensip-cli', '.runtime', name),
    });
    const pathKeys = withProject.configFile.contents.match(/^\s*(?:"paths"|paths)\s*=/gm) ?? [];
    expect(pathKeys).toHaveLength(1);
    expect(withProject.configFile.contents).toContain('opensip-cli/\\.runtime');
  });

  it('preserves an explicitly empty project config instead of substituting default rules', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitleaks-empty-cfg-'));
    writeFileSync(join(dir, '.gitleaks.toml'), '');
    const withProject = buildGitleaksExclude({
      excludePath: join(dir, 'opensip-cli', '.runtime'),
      configPath: (name) => join(dir, 'opensip-cli', '.runtime', name),
    });
    expect(withProject.configFile.contents).not.toContain('useDefault = true');
    expect(withProject.configFile.contents).toMatch(/(?:^|\n)\[allowlist\](?:\n|$)/);
  });

  it('keeps modern allowlists when the project uses a commented modern table header', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitleaks-modern-al-'));
    writeFileSync(
      join(dir, '.gitleaks.toml'),
      "[extend]\nuseDefault = true\n\n[[allowlists]] # project exclusion\npaths = ['''vendor''']\n",
    );
    const withProject = buildGitleaksExclude({
      excludePath: join(dir, 'opensip-cli', '.runtime'),
      configPath: (name) => join(dir, 'opensip-cli', '.runtime', name),
    });
    const modernHeaders = withProject.configFile.contents.match(/^\s*\[\[allowlists\]\]/gm) ?? [];
    expect(modernHeaders).toHaveLength(2);
    expect(withProject.configFile.contents).not.toMatch(/^\s*\[allowlist\]/m);
  });

  it('inserts a new CRLF paths line into a legacy allowlist with no existing paths key, staying inside the section boundary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitleaks-crlf-legacy-'));
    // CRLF line endings, a legacy [allowlist] section that carries a
    // non-paths key (so there is nothing to merge into), followed by ANOTHER
    // TOML table — proves the new paths line lands inside the [allowlist]
    // section (bounded by the next header) rather than at end-of-file.
    writeFileSync(
      join(dir, '.gitleaks.toml'),
      '[extend]\r\nuseDefault = true\r\n\r\n[allowlist]\r\ndescription = "legacy"\r\n\r\n[another]\r\nkey = "val"\r\n',
    );
    const withProject = buildGitleaksExclude({
      excludePath: join(dir, 'opensip-cli', '.runtime'),
      configPath: (name) => join(dir, 'opensip-cli', '.runtime', name),
    });
    const contents = withProject.configFile.contents;
    expect(contents.match(/^\s*\[allowlist\]/gm)).toHaveLength(1);
    expect((contents.match(/paths = \[/g) ?? []).length).toBe(1);
    // Preserves the project's own key and stays CRLF throughout the insertion.
    expect(contents).toContain('description = "legacy"');
    expect(contents).toMatch(/paths = \[.*\]\r\n/);
    // Bounded by the next table: the new paths line precedes [another].
    expect(contents.indexOf('paths = [')).toBeLessThan(contents.indexOf('[another]'));
    expect(contents).toContain('opensip-cli/\\.runtime');
  });

  it('inserts a leading newline before a new paths line when the legacy header sits at the exact end of the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitleaks-eof-legacy-'));
    // No trailing newline after [allowlist] — the header IS the end of the
    // file, and the file uses bare LF elsewhere (no CRLF present at all).
    writeFileSync(join(dir, '.gitleaks.toml'), '[extend]\nuseDefault = true\n\n[allowlist]');
    const withProject = buildGitleaksExclude({
      excludePath: join(dir, 'opensip-cli', '.runtime'),
      configPath: (name) => join(dir, 'opensip-cli', '.runtime', name),
    });
    const contents = withProject.configFile.contents;
    expect(contents.match(/^\s*\[allowlist\]/gm)).toHaveLength(1);
    expect((contents.match(/paths = \[/g) ?? []).length).toBe(1);
    // The inserted line is LF-terminated (no CRLF anywhere in the source) and
    // a newline was synthesized between the header and the new paths line
    // (there was none in the original file).
    expect(contents).toContain('[allowlist]\npaths = [');
    expect(contents).toContain('opensip-cli/\\.runtime');
  });
});

describe('gitleaks tool — projectRootFromRuntimeExclude fallback', () => {
  it('derives the project root with a single dirname() step when the exclude path is not the standard opensip-cli/.runtime shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitleaks-custom-exclude-'));
    // Marker content only present in the config placed directly under `dir`
    // (one dirname() step above the exclude path). If the resolver mistakenly
    // took the opensip-cli/.runtime double-dirname step here, it would look
    // one directory too far up and never find this file.
    writeFileSync(join(dir, '.gitleaks.toml'), '[extend]\nuseDefault = true\n# fallback-marker\n');
    const excludePath = join(dir, 'some-other-runtime-dir');
    const withProject = buildGitleaksExclude({
      excludePath,
      configPath: (name) => join(excludePath, name),
    });
    expect(withProject.configFile.contents).toContain('# fallback-marker');
    expect(withProject.configFile.contents).toContain('useDefault = true');
  });
});

describe('gitleaks tool — readProjectConfig fallback (oversized / unreadable project config)', () => {
  it('falls back visibly when the project config exceeds the byte cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitleaks-oversized-cfg-'));
    // MAX_GITLEAKS_CONFIG_BYTES (1_048_576) + 1 byte — deliberately over the
    // cap so the size guard rejects the file before ever reading its contents.
    writeFileSync(join(dir, '.gitleaks.toml'), Buffer.alloc(1_048_577, 0x61));
    const logs: { level: string; message: string | Record<string, unknown> }[] = [];
    const logger: Logger = {
      debug: (message) => logs.push({ level: 'debug', message }),
      info: (message) => logs.push({ level: 'info', message }),
      warn: (message) => logs.push({ level: 'warn', message }),
      error: (message) => logs.push({ level: 'error', message }),
    };
    const withProject = withScopeSync(makeTestScope({ logger }), () =>
      buildGitleaksExclude({
        excludePath: join(dir, 'opensip-cli', '.runtime'),
        configPath: (name) => join(dir, 'opensip-cli', '.runtime', name),
      }),
    );
    // Same shape as "no project config at all" — the oversized file's content
    // is never inlined into the generated exclude config.
    expect(withProject.configFile.contents).toContain('useDefault = true');
    expect(withProject.configFile.contents).not.toMatch(/^path\s*=/m);
    expect(withProject.configFile.contents).not.toContain('a'.repeat(64));
    expect(logs).toEqual([
      {
        level: 'warn',
        message: expect.objectContaining({
          condition: 'config-too-large',
          config: '.gitleaks.toml',
          limit: 1_048_576,
          size: 1_048_577,
        }),
      },
    ]);
  });

  it('falls back to the default ruleset and logs the swallow when the project config is unreadable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitleaks-unreadable-cfg-'));
    // A directory named `.gitleaks.toml` passes existsSync (so the adapter
    // believes the project has a config) and passes the size guard (a
    // directory's reported size is tiny), but readFileSync throws EISDIR —
    // the real shape of "config path exists but is not a readable file".
    const configPath = join(dir, '.gitleaks.toml');
    mkdirSync(configPath);
    const logs: { level: string; message: string | Record<string, unknown> }[] = [];
    const logger: Logger = {
      debug: (message) => logs.push({ level: 'debug', message }),
      info: (message) => logs.push({ level: 'info', message }),
      warn: (message) => logs.push({ level: 'warn', message }),
      error: (message) => logs.push({ level: 'error', message }),
    };
    const scope = makeTestScope({ logger });

    const withProject = withScopeSync(scope, () =>
      buildGitleaksExclude({
        excludePath: join(dir, 'opensip-cli', '.runtime'),
        configPath: (name) => join(dir, 'opensip-cli', '.runtime', name),
      }),
    );

    expect(withProject.configFile.contents).toContain('useDefault = true');
    expect(withProject.configFile.contents).toMatch(/(?:^|\n)\[allowlist\](?:\n|$)/);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.level).toBe('warn');
    expect(logs[0]?.message).toMatchObject({
      evt: 'gitleaks.project_config.degraded',
      module: 'tool-gitleaks',
      condition: 'config-read-failed',
      config: '.gitleaks.toml',
      errorCode: 'EISDIR',
    });
    expect(JSON.stringify(logs[0]?.message)).not.toContain(configPath);
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

  it('the generated manifest requires equal the posture-derived requires (no drift)', () => {
    // A13: `requires` is DERIVED from the network posture, not hand-typed. The
    // generated manifest must match the substrate derivation byte-for-byte, so a
    // posture flip surfaces as a `--check` drift.
    expect(PKG.opensipTools.requires).toEqual(deriveAdapterManifestRequires(tool));
  });

  it('derives subprocess + filesystem only (local-only posture, no network)', () => {
    expect((PKG.opensipTools.requires as { resource: string }[]).map((r) => r.resource)).toEqual([
      'subprocess',
      'filesystem',
    ]);
  });

  it('the generated manifest config descriptor equals the derived namespace claim (A4)', () => {
    // A4: the installed-path namespace claim (so the host pre-fork pass recognizes a
    // `gitleaks:` block and never bricks). Generator parity guards against drift.
    const derived = deriveAdapterConfigManifest(tool);
    expect(derived?.namespace).toBe('gitleaks');
    expect(PKG.opensipTools.config).toEqual(derived);
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
