/**
 * @fileoverview Extension docs must teach the blessed seam, not hand-rolled output (§4.8).
 *
 * The extend-docs are the real authoring API — an author copies the example, not the
 * ADR. Teaching the old privileged pattern (a hand-rolled `.option('--json')`, a raw
 * `process.stdout.write(JSON.stringify(...))`) regenerates the exact drift the command
 * plane (2.11.0) and output plane (2.12.0) removed. The blessed seam is a typed
 * `CommandSpec` + the host emit seams; the host owns `--json`, rendering, and stdout.
 *
 * This check SELF-READS the extend-docs tree (`docs/public/50-extend`, recursively)
 * — they are excluded from the code-scan targets — and flags those forbidden
 * patterns in the docs' code examples. It runs from the project root
 * (`process.cwd()`); on a consumer project with no such docs it is a no-op.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-tools/fitness';

/** The extend-docs tree, relative to the scanned project root. */
const EXTEND_DOCS_REL = path.join('docs', 'public', '50-extend');

const FORBIDDEN: readonly { readonly re: RegExp; readonly what: string }[] = [
  {
    re: /\.option\(\s*['"]--json['"]/,
    what: "a hand-rolled `.option('--json')` — the host provides `--json` via commonFlags",
  },
  {
    re: /\bprocess\.stdout\.write\s*\(/,
    what: 'a raw `process.stdout.write(...)` — return your result; the host renders + serializes it',
  },
  {
    re: /\bstdout\.write\s*\([^)]*JSON\.stringify/,
    what: 'a JSON.stringify-to-stdout write — the host wraps `--json` in a CommandOutcome',
  },
];

/** Pure analysis over one markdown doc's content. Exported for unit tests. */
export function analyzeBlessedSeam(
  content: string,
): { readonly line: number; readonly what: string }[] {
  const hits: { line: number; what: string }[] = [];
  for (const [i, line] of content.split('\n').entries()) {
    for (const rule of FORBIDDEN) {
      if (rule.re.test(line)) hits.push({ line: i + 1, what: rule.what });
    }
  }
  return hits;
}

/** Recursively collect `.md` files under `dir`. */
function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(full));
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

export const docsTeachBlessedSeam = defineCheck({
  id: '42f18278-e825-4696-a521-c49fd78879d7',
  slug: 'docs-teach-blessed-seam',
  description:
    'Extension docs must teach the blessed CommandSpec seam, not hand-rolled --json / stdout (§4.8)',
  scope: { languages: ['typescript'], concerns: ['backend'] },
  tags: ['architecture', 'documentation'],
  // eslint-disable-next-line @typescript-eslint/require-await -- analyzeAll is async by contract; this check's IO is sync fs
  async analyzeAll(_files: FileAccessor): Promise<CheckViolation[]> {
    const dir = path.join(process.cwd(), EXTEND_DOCS_REL);
    if (!existsSync(dir)) return [];

    const violations: CheckViolation[] = [];
    for (const file of markdownFiles(dir)) {
      const content = readFileSync(file, 'utf8');
      for (const hit of analyzeBlessedSeam(content)) {
        violations.push({
          filePath: file,
          line: hit.line,
          message: `Extension docs must teach the blessed seam (§4.8): found ${hit.what}.`,
          severity: 'error',
          suggestion:
            'Teach a typed CommandSpec (defineCommand) with commonFlags + an `output` mode; ' +
            'return the result and let the host own --json / rendering / stdout.',
        });
      }
    }
    return violations;
  },
});
