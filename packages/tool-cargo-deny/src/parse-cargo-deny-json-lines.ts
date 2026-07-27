import { createSignal, ToolError } from '@opensip-cli/core';
import {
  asArray,
  asObject,
  getNumber,
  getString,
  nativeLabelToSeverity,
  parseJsonLines,
  externalToolErrorCatalog,
  withNativeSeverity,
} from '@opensip-cli/external-tool-adapter';

import type { Signal, SignalCategory } from '@opensip-cli/core';
import type { AdapterRunContext, ParsedScannerOutput } from '@opensip-cli/external-tool-adapter';

const ARTIFACT_INVALID = externalToolErrorCatalog.require('EXTERNAL.SCANNER.ARTIFACT_INVALID');

function reportParseErrors(ctx: AdapterRunContext, errorCount: number, signalCount: number): void {
  if (errorCount === 0) return;
  if (signalCount === 0) {
    throw new ToolError(
      'cargo-deny produced an unusable JSON-lines report.',
      ARTIFACT_INVALID.code,
      {
        definition: ARTIFACT_INVALID,
        metadata: { condition: 'malformed-json-line', scanner: 'cargo-deny' },
      },
    );
  }
  ctx.logger.warn({
    evt: 'external.scanner.report.partial',
    module: '@opensip-cli/tool-cargo-deny',
    scanner: 'cargo-deny',
    condition: 'malformed-json-line',
    parseErrorCount: errorCount,
    findingCount: signalCount,
  });
}

/**
 * cargo-deny `--format json check` emits NDJSON `{ type, fields }` messages. Only
 * `type: "diagnostic"` carries a finding; the `fields` bag holds `severity`,
 * `message`, `code`, optional nested `advisory` (with `id`), and `labels[]` (each
 * a dependency-graph/manifest span with an optional `line`/`column`). It is NOT
 * the rustc diagnostic shape — there is no `level` or `spans[].file_name`.
 */
function diagnosticFields(value: unknown): Record<string, unknown> | undefined {
  const root = asObject(value);
  if (root === undefined) return undefined;
  const type = getString(root, 'type');
  // Accept the `{type:'diagnostic',fields}` envelope; tolerate a bare fields object
  // (older cargo-deny) but never a `summary`/`log` message.
  if (type !== undefined && type !== 'diagnostic') return undefined;
  return asObject(root.fields) ?? root;
}

function firstLabel(fields: Record<string, unknown>): Record<string, unknown> | undefined {
  return asObject(asArray(fields.labels)?.[0]);
}

/**
 * Prefer the RustSec/GHSA advisory id when present (stable, human-searchable),
 * else the diagnostic `code` string (`vulnerability`, `banned`, …).
 */
function ruleIdOf(fields: Record<string, unknown>): string {
  const advisoryId = getString(asObject(fields.advisory), 'id');
  if (advisoryId !== undefined && advisoryId.length > 0) return advisoryId;
  // `code` is a bare string in modern cargo-deny; tolerate a nested `{code}` too.
  return getString(asObject(fields.code), 'code') ?? getString(fields, 'code') ?? 'cargo-deny';
}

/**
 * Bans/license codes that can reach cargo-deny's default warn/error JSON stream
 * and do not carry an obvious `ban`/`license` marker. Cargo-deny omits the
 * originating check from its JSON envelope, so exact codes are the only reliable
 * domain discriminator for these cases.
 */
const QUALITY_CODES = new Set([
  // bans
  'not-allowed',
  'unmatched-skip',
  'unnecessary-skip',
  'unmatched-wrapper',
  'unmatched-skip-root',
  'exact-features-mismatch',
  'feature-not-explicitly-allowed',
  'unknown-feature',
  'default-feature-enabled',
  'checksum-mismatch',
  'denied-by-extension',
  'detected-executable',
  'detected-executable-script',
  'unable-to-check-path',
  'unmatched-bypass',
  'unmatched-path-bypass',
  'unmatched-glob',
  'unused-wrapper',
  'workspace-duplicate',
  'unresolved-workspace-dependency',
  'unused-workspace-dependency',
  'non-utf8-path',
  'non-root-path',
  'replaced-in-std',
  'unmatched-replacement-ignore',
  // licenses
  'accepted',
  'rejected',
  'unlicensed',
  'missing-clarification-file',
  'parse-error',
  'gather-failure',
]);

/**
 * Map cargo-deny's real diagnostic codes (and legacy letter prefixes) to a
 * canonical category. Advisory / source-policy findings are security; bans and
 * license policy are quality/compliance (no dedicated `license` SignalCategory).
 */
function categoryOf(ruleId: string, code: string | undefined): SignalCategory {
  const id = ruleId.toLowerCase();
  const c = (code ?? '').toLowerCase();
  // Real cargo-deny codes (post letter-prefix era).
  if (
    c === 'vulnerability' ||
    c === 'unsound' ||
    c === 'unmaintained' ||
    c === 'yanked' ||
    c === 'notice' ||
    c.includes('advisory') ||
    c.includes('source') ||
    id.startsWith('rustsec-') ||
    id.startsWith('ghsa-') ||
    id.startsWith('cve-')
  ) {
    return 'security';
  }
  if (
    QUALITY_CODES.has(c) ||
    c === 'banned' ||
    c === 'denied' ||
    c === 'duplicate' ||
    c === 'wildcard' ||
    c.includes('ban') ||
    c.includes('license') ||
    c.includes('copyleft') ||
    // Legacy letter-prefix codes (L* licenses, B* bans).
    id.startsWith('b') ||
    id.startsWith('l')
  ) {
    return 'quality';
  }
  // Default: advisory-shaped ids stay security; unknown codes default security
  // (cargo-deny's primary job is dependency security/policy).
  return 'security';
}

function normalize(value: unknown): Signal | undefined {
  const fields = diagnosticFields(value);
  if (fields === undefined) return undefined;
  const message = getString(fields, 'message');
  if (message === undefined) return undefined;
  // cargo-deny's native key is `severity` (not rustc's `level`); keep `level` as a
  // defensive fallback.
  const severityLabel = getString(fields, 'severity') ?? getString(fields, 'level');
  const label = firstLabel(fields);
  const code = getString(asObject(fields.code), 'code') ?? getString(fields, 'code') ?? undefined;
  const ruleId = ruleIdOf(fields);
  return createSignal({
    source: 'cargo-deny',
    category: categoryOf(ruleId, code),
    // cargo-deny serializes codespan's internal-bug severity as `bug`; its SARIF
    // renderer maps that to `error`, which corresponds to OpenSIP `high`.
    severity:
      severityLabel?.trim().toLowerCase() === 'bug'
        ? 'high'
        : nativeLabelToSeverity(severityLabel, 'medium'),
    ruleId,
    message,
    code: {
      // cargo-deny locates findings in the dependency graph, not a source file; the
      // label `span` is the crate/manifest reference. Surface it as the file token
      // when present so the finding stays identifiable.
      file: getString(label, 'span') ?? '',
      ...(getNumber(label, 'line') === undefined ? {} : { line: getNumber(label, 'line') }),
      ...(getNumber(label, 'column') === undefined ? {} : { column: getNumber(label, 'column') }),
    },
    metadata: withNativeSeverity(
      {
        code: code ?? null,
        advisoryId: getString(asObject(fields.advisory), 'id') ?? null,
      },
      severityLabel ?? null,
    ),
  });
}

/**
 * Parse cargo-deny's `--format json check` NDJSON stream into signals — one per
 * `diagnostic` message. Non-diagnostic lines (`summary`/`log`) and messages
 * without a `message` field are skipped. Advisory findings prefer
 * `fields.advisory.id` (e.g. `RUSTSEC-…`) as `ruleId`.
 */
export function parseCargoDenyJsonLines(
  raw: ParsedScannerOutput,
  ctx: AdapterRunContext,
): readonly Signal[] {
  const decoded = parseJsonLines(raw.raw, { tolerateNonJson: true });
  const signals: Signal[] = [];
  for (const line of decoded.values) {
    const signal = normalize(line.value);
    if (signal !== undefined) signals.push(signal);
  }
  reportParseErrors(ctx, decoded.errors.length, signals.length);
  return signals;
}
