import { createSignal } from '@opensip-cli/core';
import {
  asArray,
  asObject,
  getNumber,
  getString,
  nativeLabelToSeverity,
  parseJsonLines,
  withNativeSeverity,
} from '@opensip-cli/external-tool-adapter';

import type { Signal, SignalCategory } from '@opensip-cli/core';
import type { AdapterRunContext, ParsedScannerOutput } from '@opensip-cli/external-tool-adapter';

/**
 * cargo-deny `check --format json` emits NDJSON `{ type, fields }` messages. Only
 * `type: "diagnostic"` carries a finding; the `fields` bag holds `severity`,
 * `message`, `code`, and `labels[]` (each a dependency-graph/manifest span with an
 * optional `line`/`column`). It is NOT the rustc diagnostic shape — there is no
 * `level` or `spans[].file_name` (the pre-fix parser read those and so mislabelled
 * every finding `medium` with an empty location).
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

function ruleIdOf(fields: Record<string, unknown>): string {
  // `code` is a bare string in cargo-deny's fields; tolerate a nested `{code}` too.
  return getString(asObject(fields.code), 'code') ?? getString(fields, 'code') ?? 'cargo-deny';
}

/** Map cargo-deny's check kind (via the `code` prefix) to a canonical category. */
function categoryOf(ruleId: string): SignalCategory {
  const id = ruleId.toLowerCase();
  // bans/duplicates and license policy are code-quality/compliance concerns; advisories
  // and source policy map to security. (SignalCategory has no dedicated `license`.)
  if (id.startsWith('b') || id.startsWith('l') || id.includes('ban') || id.includes('license')) {
    return 'quality';
  }
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
  const ruleId = ruleIdOf(fields);
  return createSignal({
    source: 'cargo-deny',
    category: categoryOf(ruleId),
    severity: nativeLabelToSeverity(severityLabel, 'medium'),
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
    metadata: withNativeSeverity({}, severityLabel ?? null),
  });
}

/**
 * Parse cargo-deny's `check --format json` NDJSON stream into signals — one per
 * `diagnostic` message. Non-diagnostic lines (`summary`/`log`) and messages
 * without a `message` field are skipped.
 */
export function parseCargoDenyJsonLines(
  raw: ParsedScannerOutput,
  _ctx: AdapterRunContext,
): readonly Signal[] {
  const signals: Signal[] = [];
  for (const line of parseJsonLines(raw.raw, { tolerateNonJson: true }).values) {
    const signal = normalize(line.value);
    if (signal !== undefined) signals.push(signal);
  }
  return signals;
}
