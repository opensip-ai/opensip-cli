/**
 * Tier-1 (in-process) tests for the pip-audit adapter `Tool`: the declarative
 * surface (commandSpecs / identity / metadata), the requirements-aware scan-arg
 * helper, the exit model, the manifest↔runtime host-shape parity guards (networked
 * posture ⇒ a `network` requirement), and the full normalize→envelope path through
 * the acceptance harness (with a golden fixture).
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

import { parsePipAuditJson } from '../parse-pip-audit-json.js';
import { buildScanArgs, PIP_AUDIT_STABLE_ID, tool } from '../tool.js';

import type { ToolPluginManifest } from '@opensip-cli/core';
import type { AdapterRunContext, ScannerExitModel } from '@opensip-cli/external-tool-adapter';

const PKG = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { name: string; version: string; opensipTools: Record<string, unknown> };

const GOLDEN_RAW = readFileSync(
  fileURLToPath(new URL('../../__fixtures__/pip-audit-golden.json', import.meta.url)),
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
    artifactPath: (name: string) => `${projectRoot}/.runtime/artifacts/pip-audit/run1/${name}`,
  }) as unknown as AdapterRunContext;

describe('pip-audit tool — identity + metadata', () => {
  it('declares the pip-audit identity and stable UUID', () => {
    expect(tool.identity).toEqual({ name: 'pip-audit' });
    expect(tool.metadata.id).toBe(PIP_AUDIT_STABLE_ID);
    expect(tool.metadata.name).toBe('pip-audit');
    expect(tool.metadata.description).toBe(
      'Python dependency vulnerability auditing via pip-audit',
    );
  });

  it('mounts the primary scan plus nested doctor + version', () => {
    expect((tool.commandSpecs ?? []).map((c) => c.name)).toEqual([
      'pip-audit',
      'doctor',
      'version',
    ]);
    expect(byName('pip-audit')?.scope).toBe('project');
    for (const name of ['doctor', 'version']) {
      expect(byName(name)?.parent).toBe('pip-audit');
      expect(byName(name)?.scope).toBe('none');
    }
  });
});

describe('pip-audit tool — scan helper', () => {
  it('audits the ACTIVE environment (no target args) when no requirements file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pip-audit-empty-'));
    expect(buildScanArgs(ctxFor(dir))).toEqual([
      '--format',
      'json',
      '--output',
      `${dir}/.runtime/artifacts/pip-audit/run1/pip-audit.json`,
      '--progress-spinner',
      'off',
    ]);
  });

  it('audits the discovered requirements file with -r', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pip-audit-reqs-'));
    const reqs = join(dir, 'requirements.txt');
    writeFileSync(reqs, 'flask==1.0\n');
    expect(buildScanArgs(ctxFor(dir))).toEqual([
      '-r',
      reqs,
      '--format',
      'json',
      '--output',
      `${dir}/.runtime/artifacts/pip-audit/run1/pip-audit.json`,
      '--progress-spinner',
      'off',
    ]);
  });
});

describe('pip-audit tool — exit model', () => {
  const model: ScannerExitModel = { ok: [0], findings: [1], errorFrom: 2 };
  it('0 ⇒ ok, 1 ⇒ findings, >=2 ⇒ fault', () => {
    expect(interpretExit(0, model)).toBe('ok');
    expect(interpretExit(1, model)).toBe('findings');
    expect(interpretExit(2, model)).toBe('fault');
  });
});

describe('pip-audit tool — manifest ↔ runtime parity (no drift)', () => {
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

describe('pip-audit tool — acceptance harness (normalize → envelope)', () => {
  const result = runAcceptanceCase({
    tool: 'pip-audit',
    kind: 'json',
    raw: GOLDEN_RAW,
    parse: parsePipAuditJson,
    fingerprintStrategy: 'message-hash',
  });

  it('produces the golden normalized signals (clean deps yield nothing)', () => {
    expect(result.signals.map(normalizedSignalShape)).toEqual(EXPECTED);
  });

  it('builds an envelope whose verdict FAILS (high-severity vulns are error-rung)', () => {
    expect(result.envelope.tool).toBe('pip-audit');
    expect(result.envelope.verdict.passed).toBe(false);
  });

  it('stamps a message-hash fingerprint on every envelope signal', () => {
    expect(result.envelope.signals).toHaveLength(2);
    for (const s of result.envelope.signals) {
      expect(s.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
