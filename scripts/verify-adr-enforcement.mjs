#!/usr/bin/env node
/**
 * verify-adr-enforcement — keep every ADR's enforcement status honest (ADR-0137
 * convention). Each ADR's frontmatter must declare how its Decision is enforced,
 * so the "which ADRs lack a check?" audit is continuous, not periodic.
 *
 * Rules (see docs/decisions/TEMPLATE.md):
 *   - enforcement: mechanizable       ⇒ must have `enforced-by:` (one or more
 *       enforcers, or NONE-YET for a tracked gap).
 *   - enforcement: not-mechanizable   ⇒ must have `enforcement-reason:`.
 *   - `enforced-by` values are origin-tagged:
 *       local:<slug>   — project-local dogfood fitness check: an opensip-cli/fit/
 *                        checks/*.mjs file OR a check in a private (never-published)
 *                        packages/fitness/checks-* pack (e.g. checks-dogfood)
 *       shipped:<slug> — fitness check shipped in a publishable packages/fitness/
 *                        checks-* pack (the product)
 *       depcruise:<r> | graph:<r> | eslint:<r> | script:<name> | type-structural
 *       NONE-YET       — mechanizable but no check exists yet (a tracked gap)
 *   - A `local:`/`shipped:` slug MUST exist as a defined fitness check, and its
 *     origin tag MUST match where the slug actually lives (catches an opensip-cli
 *     -internal check that drifts into the shipped pack, or vice-versa).
 *
 * Non-fitness enforcers (depcruise/graph/eslint/script/type-structural) are
 * format-checked only — validating their targets is left to their own gates.
 * NONE-YET is reported as the standing backlog but does NOT fail the gate.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DECISIONS = 'docs/decisions';
const ORIGIN_PREFIXES = ['local', 'shipped'];
const OTHER_PREFIXES = ['depcruise', 'graph', 'eslint', 'script'];
const BARE_OK = new Set(['type-structural', 'NONE-YET']);

/** Recursively collect *.ts/*.mjs files under a directory (skips node_modules/dist). */
function sourceFiles(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    if (
      name === 'node_modules' ||
      name === 'dist' ||
      name === '__tests__' ||
      name === '__fixtures__'
    )
      continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (/\.(ts|mjs)$/.test(name)) acc.push(full);
  }
  return acc;
}

/** Build slug → origin ('local' | 'shipped') from the check source trees (shell-free). */
function loadSlugOrigins() {
  const origins = new Map();
  const scan = (roots, origin) => {
    for (const root of roots) {
      for (const file of sourceFiles(root)) {
        const text = readFileSync(file, 'utf8');
        for (const m of text.matchAll(/slug: ['"]([a-z0-9-]+)['"]/g)) {
          if (!origins.has(m[1])) origins.set(m[1], origin);
        }
      }
    }
  };
  // Partition packages/fitness/checks-* by their package.json `private` flag: a
  // private, never-published pack (e.g. checks-dogfood) holds opensip-cli-internal
  // dogfood checks → origin 'local'; a publishable pack ships to adopters →
  // origin 'shipped'. This keeps the relocated opensip-internal architecture
  // checks tagged 'local:' even though they live under packages/fitness/checks-*.
  const shippedRoots = [];
  const localPackRoots = [];
  for (const d of readdirSync('packages/fitness')) {
    if (!d.startsWith('checks-')) continue;
    let isPrivate = false;
    try {
      const pkg = JSON.parse(readFileSync(join('packages/fitness', d, 'package.json'), 'utf8'));
      isPrivate = pkg.private === true;
    } catch {
      // no/unreadable package.json → fail safe toward the stricter 'shipped' tag
    }
    (isPrivate ? localPackRoots : shippedRoots).push(join('packages/fitness', d, 'src'));
  }
  scan(shippedRoots, 'shipped');
  // Project-local origins: the .mjs dogfood checks AND any private checks-* pack.
  scan([...localPackRoots, 'opensip-cli/fit/checks'], 'local');
  return origins;
}

function frontmatterField(text, field) {
  const m = text.match(new RegExp(`^${field}:\\s*([^\\n#]*)`, 'm'));
  return m ? m[1].trim() : undefined;
}

function parseEnforcedBy(text) {
  const raw = frontmatterField(text, 'enforced-by');
  if (raw === undefined) return;
  if (raw === 'NONE-YET') return ['NONE-YET'];
  // inline array: ['a', 'b'] or [a, b]
  const inner = raw.replace(/^\[|\]$/g, '');
  return inner
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

const origins = loadSlugOrigins();
const files = readdirSync(DECISIONS)
  .filter((f) => /^ADR-\d+.*\.md$/.test(f))
  .sort();

const errors = [];
const gaps = [];
let mech = 0;
let notMech = 0;

for (const file of files) {
  const adr = file.match(/ADR-\d+/)[0];
  const text = readFileSync(join(DECISIONS, file), 'utf8');
  const enforcement = frontmatterField(text, 'enforcement');
  const enforcedBy = parseEnforcedBy(text);
  const hasReason = /^enforcement-reason:/m.test(text);

  if (!enforcement) {
    errors.push(`${adr}: missing 'enforcement:' field (must be mechanizable | not-mechanizable)`);
    continue;
  }

  const isMechanizable = /mechan/.test(enforcement) && !/not-mechan/.test(enforcement);
  if (isMechanizable) {
    mech += 1;
    if (!enforcedBy || enforcedBy.length === 0) {
      errors.push(`${adr}: enforcement '${enforcement}' but no 'enforced-by:'`);
      continue;
    }
    for (const e of enforcedBy) {
      if (BARE_OK.has(e)) {
        if (e === 'NONE-YET') gaps.push(adr);
        continue;
      }
      const [prefix, ...rest] = e.split(':');
      const name = rest.join(':');
      if (ORIGIN_PREFIXES.includes(prefix)) {
        const actual = origins.get(name);
        if (actual === undefined) {
          errors.push(
            `${adr}: enforced-by '${e}' names a fitness check '${name}' that does not exist`,
          );
        } else if (actual !== prefix) {
          errors.push(
            `${adr}: enforced-by '${e}' tagged '${prefix}' but check '${name}' actually lives in the ${actual} tree`,
          );
        }
      } else if (!OTHER_PREFIXES.includes(prefix)) {
        errors.push(
          `${adr}: enforced-by '${e}' has an unknown form (expected local:/shipped:/depcruise:/graph:/eslint:/script:/type-structural/NONE-YET)`,
        );
      }
    }
  } else if (/not-mechan/.test(enforcement)) {
    notMech += 1;
    if (!hasReason) {
      errors.push(
        `${adr}: enforcement 'not-mechanizable' but no 'enforcement-reason:' explaining why`,
      );
    }
  } else {
    // partial or other — must still declare an enforcer
    if (!enforcedBy || enforcedBy.length === 0) {
      errors.push(`${adr}: enforcement '${enforcement}' must declare 'enforced-by:'`);
    }
  }
}

const log = (m) => console.error(`[verify-adr-enforcement] ${m}`);
log(
  `${files.length} ADRs · ${mech} mechanizable · ${notMech} not-mechanizable · ${gaps.length} NONE-YET gap(s)`,
);
if (gaps.length > 0) log(`standing backlog (mechanizable, no check yet): ${gaps.join(', ')}`);

if (errors.length > 0) {
  log(`FAIL — ${errors.length} enforcement-annotation problem(s):`);
  for (const e of errors) log(`  ${e}`);
  process.exit(1);
}
log('OK — every ADR declares a consistent, valid enforcement status.');
