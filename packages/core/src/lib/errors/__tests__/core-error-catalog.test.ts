import { describe, expect, it } from 'vitest';

import {
  CORE_SYSTEM_ERROR_OWNER,
  coreSystemErrorCatalog,
  definitionFromLegacyCode,
} from '../../error-definition.js';
import { ToolError } from '../../errors.js';
import { coreErrorCatalog, RUNTIME_COORDINATION_FAILURE_CODES } from '../core-error-catalog.js';
import { resolveDefinitionForCode } from '../resolve-definition.js';

describe('coreErrorCatalog', () => {
  it('publishes under core’s existing owner identity, not the package name', () => {
    // Ruling D1 keys SUBSTRATE catalogs on the package name; core is the documented
    // exception because `opensip-cli.core` is already published in the error-code index.
    expect(coreErrorCatalog.owner.id).toBe(CORE_SYSTEM_ERROR_OWNER.id);
    expect(coreErrorCatalog.owner.id).toBe('opensip-cli.core');
  });

  it('declares no code the legacy adapter catalog already owns', () => {
    // Two definitions for one code would make resolution order decide the axes.
    const legacy = new Set(coreSystemErrorCatalog.list.map((d) => d.code));
    const overlap = coreErrorCatalog.list.map((d) => d.code).filter((c) => legacy.has(c));
    expect(overlap).toEqual([]);
  });

  it('gives every definition a non-empty operator action', () => {
    // An operator action that says nothing is the failure mode this whole catalog exists to
    // retire — UNKNOWN_FAILURE's "capture the run id and report a bug" applied to a user's
    // missing config file.
    const silent = coreErrorCatalog.list.filter((d) => d.operatorAction.trim().length < 20);
    expect(silent.map((d) => d.code)).toEqual([]);
  });

  it('never publishes metadata a definition did not allowlist', () => {
    // publicMetadataKeys is the D9 bound on outward fields. A definition whose triage needs
    // an errno must say so; one that does not must not leak paths through metadata.
    for (const definition of coreErrorCatalog.list) {
      for (const key of definition.publicMetadataKeys ?? []) {
        expect(key).toMatch(/^[a-z][A-Za-z0-9]*$/u);
      }
    }
  });

  it('is frozen at every level', () => {
    const [first] = coreErrorCatalog.list;
    expect(first).toBeDefined();
    expect(Object.isFrozen(coreErrorCatalog)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
  });
});

describe('coreErrorCatalog — the demotions Wave 1 exists to fix', () => {
  it('resolves the missing-config failure to a public, user-actionable definition', () => {
    // BEFORE: code 'ERRORS.CONFIG.NOT_FOUND' had an unmapped head, so
    // definitionFromLegacyCode demoted the most common first-run failure in the product to
    // UNKNOWN_FAILURE — severity fatal, exposure operator-only, responsibility unknown — and
    // outwardMessage replaced the enumerated search paths with "An unexpected internal
    // failure occurred." The user was told nothing they could act on.
    const definition = coreErrorCatalog.require('CONFIGURATION.CONFIG.NOT_FOUND');
    expect(definition.exposure).toBe('public');
    expect(definition.defaultResponsibility).toBe('user');
    expect(definition.severity).toBe('error');
    expect(definition.exitClass).toBe('configuration');
    expect(definition.operatorAction).toContain('opensip init');

    const demoted = definitionFromLegacyCode('ERRORS.CONFIG.NOT_FOUND');
    expect(demoted.code).toBe('CORE.SYSTEM.UNKNOWN_FAILURE');
    expect(demoted.exposure).toBe('operator-only');
  });

  it('classifies tool identity failures as authoring errors, not internal invariants', () => {
    // BEFORE: the head 'TOOL' is unmapped, so a malformed manifest — and a name collision
    // during host bootstrap, which aborts the whole CLI — reported as an operator-only fatal
    // saying "report a bug".
    for (const code of [
      'VALIDATION.TOOL_IDENTITY.INVALID_NAME',
      'VALIDATION.TOOL_IDENTITY.CONFLICT',
      'VALIDATION.TOOL_IDENTITY.PARENT_MISMATCH',
      'VALIDATION.TOOL_IDENTITY.REQUIRED',
    ] as const) {
      const definition = coreErrorCatalog.require(code);
      expect(definition.defaultResponsibility).toBe('tool-author');
      expect(definition.exposure).toBe('public');
      expect(definition.exitClass).toBe('plugin-incompatible');
    }
    expect(definitionFromLegacyCode('TOOL.IDENTITY.INVALID_NAME').code).toBe(
      'CORE.SYSTEM.UNKNOWN_FAILURE',
    );
  });

  it('makes contention retryable and containment refusals non-retryable', () => {
    // Both conditions used to share SYSTEM_ERROR: kind invariant, retry never. The retry
    // loop had to special-case the contention class because the definition said the opposite
    // of what the type meant.
    const busy = coreErrorCatalog.require('CORE.RUNTIME_COORDINATION.BUSY');
    expect(busy.retry).toBe('transient');
    expect(busy.kind).toBe('conflict');

    const unsafe = coreErrorCatalog.require('CORE.RUNTIME_COORDINATION.UNSAFE_STATE');
    expect(unsafe.retry).toBe('never');
    expect(unsafe.kind).toBe('security');
  });

  it('starts using the two FailureKind members no definition had claimed', () => {
    // D9 step 4: `security` for containment/posture refusals, `integrity` for TOCTOU and
    // identity-change refusals. Both members existed in the vocabulary and were dead.
    const kinds = new Set(coreErrorCatalog.list.map((d) => d.kind));
    expect(kinds.has('security')).toBe(true);
    expect(kinds.has('integrity')).toBe(true);
  });

  it('keeps a degraded run’s exit successful when the degradation is not the verdict', () => {
    // Ruling D7: a post-scan delivery or stamping failure must never destroy a credible
    // verdict. These carry warning severity and a success exit class precisely so surfacing
    // them cannot turn a clean scan into a failed command.
    for (const code of [
      'PLUGIN.FINGERPRINT_STRATEGY.STAMP_FAILED',
      'CORE.BASELINE.FINGERPRINT_STRATEGY_FAILED',
      'CORE.SUBPROCESS.GIT_FAILED',
    ] as const) {
      const definition = coreErrorCatalog.require(code);
      expect(definition.severity).toBe('warning');
      expect(definition.exitClass).toBe('success');
    }
  });
});

describe('RUNTIME_COORDINATION_FAILURE_CODES', () => {
  it('names only codes that actually exist', () => {
    // A stale entry here is worse than no list: a consumer would test against a code nothing
    // can ever raise and quietly stop handling the case.
    for (const code of RUNTIME_COORDINATION_FAILURE_CODES) {
      expect(coreErrorCatalog.get(code), code).toBeDefined();
    }
  });

  it('covers every coordination, lease and recovery code the catalog declares', () => {
    // The whole point is that a future split cannot leave a consumer behind. If a new
    // CORE.RUNTIME_* code is added without listing it here, this fails.
    const declared = coreErrorCatalog.list
      .map((d) => d.code)
      .filter((code) => /RUNTIME_(COORDINATION|LEASE|RECOVERY)\./u.test(code));
    const missing = declared.filter((code) => !RUNTIME_COORDINATION_FAILURE_CODES.includes(code));
    expect(missing).toEqual([]);
  });

  it('excludes timeouts, which the lock and lease wait paths own', () => {
    expect(RUNTIME_COORDINATION_FAILURE_CODES.some((c) => c.startsWith('TIMEOUT.'))).toBe(false);
  });
});

describe('resolveDefinitionForCode (Plan 01 Wave 1)', () => {
  it('resolves a registered CORE.* code instead of demoting it', () => {
    // THE BUG THIS FIXES: `definitionFromLegacyCode` only ever consulted the legacy catalog,
    // so a code that Wave 1 registered — with the head `CORE`, which `legacyFamilyCode` does
    // not map — resolved to UNKNOWN_FAILURE. Registering a code without teaching the resolver
    // about it manufactures a NEW instance of the exact demotion this plan removes, and does
    // it silently: the call site reads as correct. Caught by a CLI exit-code test.
    expect(definitionFromLegacyCode('CORE.RUNTIME_RECOVERY.REQUIRED').code).toBe(
      'CORE.SYSTEM.UNKNOWN_FAILURE',
    );
    const resolved = resolveDefinitionForCode('CORE.RUNTIME_RECOVERY.REQUIRED');
    expect(resolved.code).toBe('CORE.RUNTIME_RECOVERY.REQUIRED');
    expect(resolved.exitClass).toBe('configuration');
  });

  it('gives a ToolError built from a bare registered code the right exit class', () => {
    // The end-to-end shape of the same defect: exit 1 where the condition means 2.
    const error = new ToolError('recovery required', 'CORE.RUNTIME_RECOVERY.REQUIRED');
    expect(error.definition.exitClass).toBe('configuration');
  });

  it('keeps the legacy family fallback and stays total', () => {
    // Registered codes win; everything else keeps documented behaviour, and a hostile code
    // must never throw here (D11) because this runs when something has already failed.
    expect(resolveDefinitionForCode('CONFIGURATION.ANYTHING.ELSE').code).toBe(
      'CONFIGURATION_ERROR',
    );
    expect(resolveDefinitionForCode('WHOLLY.UNKNOWN.HEAD').code).toBe(
      'CORE.SYSTEM.UNKNOWN_FAILURE',
    );
    expect(() => resolveDefinitionForCode('')).not.toThrow();
  });

  it('resolves every code the catalog declares', () => {
    // A registered code that does not resolve is invisible debt: it looks migrated and
    // behaves demoted.
    const unresolved = coreErrorCatalog.list
      .map((d) => d.code)
      .filter((code) => resolveDefinitionForCode(code).code !== code);
    expect(unresolved).toEqual([]);
  });
});
