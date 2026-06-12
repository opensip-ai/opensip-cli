/**
 * @fileoverview fitness's `init` example contribution (ADR-0038).
 *
 * fitness OWNS the example check/recipe bytes + the pinned check ids that `init`
 * scaffolds — relocated here from the CLI's `config-templates.ts` so a tool's
 * scaffold content lives with the tool (the host just writes the bytes under
 * `userPluginDir('fit', kind)`). The byte content is verbatim; a Phase-0 golden +
 * a Phase-1 parity test pin byte-identity with the legacy CLI builders.
 */

import type { ScaffoldContext, ScaffoldFile } from '@opensip-tools/core';

/**
 * Pinned example-check ids per language — the COMPLETE id universe (drives
 * stale-scaffolded detection regardless of the project's detected languages).
 * Verbatim from the legacy `config-templates.ts`.
 */
export const EXAMPLE_CHECK_IDS: Record<string, string> = {
  typescript: 'a3e1f8c4-9b2d-4f5a-8e6c-7d1a2b3c4d5e',
  rust: 'b4f2e9d5-8c3e-4a6b-9f7d-8e2b3c4d5e6f',
  python: 'c5a3f0e6-7d4f-4b7c-a08e-9f3c4d5e6f70',
  go: 'd6b4a1f7-6e5a-4c8d-b19f-a04d5e6f7081',
  java: 'e7c5b2a8-5f6b-4d9e-c2af-b15e6f708192',
  cpp: 'f8d6c3b9-4a7c-4ea0-d3b0-c26f708192a3',
};

/** Example fitness check source (verbatim). `language` is tool-local `string`. */
export function exampleCheckSource(language: string, polyglotSuffix = ''): string {
  // The example check flags any file containing the literal
  // `EXAMPLE_TODO`. Default behavior on a fresh repo is to pass with
  // 0 violations — it scans real files but finds nothing.
  const slug = polyglotSuffix ? `example-check-${polyglotSuffix}` : 'example-check';
  return `// Example fitness check.
//
// Edit this file or add new .mjs files to opensip-tools/fit/checks/.
// Files in this directory are auto-loaded on the next \`opensip-tools fit\` run.
//
// This demo flags any file containing the literal \`EXAMPLE_TODO\`. After
// you confirm the wiring works, delete or replace it with a real check.
//
// Docs: https://github.com/opensip-ai/opensip-tools#authoring-a-check-package
import { defineCheck } from '@opensip-tools/fitness';

export const checks = [
  defineCheck({
    id: '${EXAMPLE_CHECK_IDS[language] ?? ''}',
    slug: '${slug}',
    description: 'Demo check — flags any file containing the literal EXAMPLE_TODO',
    scope: { languages: ['${language}'], concerns: ['backend'] },
    tags: ['example'],
    analyze: (content, filePath) => {
      const i = content.indexOf('EXAMPLE_TODO');
      if (i < 0) return [];
      return [{
        line: content.slice(0, i).split('\\n').length,
        message: 'Found the example trigger string.',
        severity: 'warning',
        suggestion:
          'This is just a demo. Delete opensip-tools/fit/checks/example-check.mjs ' +
          'once you have your own checks.',
        filePath,
      }];
    },
  }),
];
`;
}

/** Example fitness recipe source (verbatim). */
export function exampleRecipeSource(slugs: readonly string[]): string {
  const slugList = slugs.map((s) => `'${s}'`).join(', ');
  return `// Example fitness recipe — runs only the example check(s).
//
// Edit this file or add new .mjs files to opensip-tools/fit/recipes/.
// Files in this directory are auto-loaded on the next run.
//
// Run this recipe explicitly:  opensip-tools fit --recipe example
//
// To run all enabled checks (built-in + your custom ones), omit
// --recipe and the built-in \`default\` recipe applies.
export const recipes = [{
  id: 'URCP_example',
  name: 'example',
  displayName: 'Example',
  description: 'Demo recipe — runs only the example check(s)',
  checks: { type: 'explicit', checkIds: [${slugList}] },
  execution: { mode: 'parallel', stopOnFirstFailure: false, timeout: 30_000 },
  reporting: { format: 'table', verbose: false },
}];
`;
}

/**
 * fitness's scaffold contribution — reproduces `scaffold-writer.ts`'s fit logic:
 * single language ⇒ one `example-check.mjs` + a recipe over `['example-check']`;
 * polyglot ⇒ one `example-check-<lang>.mjs` per language + a recipe over the
 * per-language slugs.
 */
export function fitScaffoldExamples(ctx: ScaffoldContext): ScaffoldFile[] {
  const languages = ctx.languages.length > 0 ? ctx.languages : ['typescript'];
  const single = languages.length === 1;

  // Single language ⇒ one un-suffixed `example-check.mjs`. Polyglot ⇒ one
  // `example-check-<lang>.mjs` per language. A declarative `.map` (not a
  // push-in-loop) keeps the check files' contents the single source.
  const checkFiles: ScaffoldFile[] = single
    ? [
        {
          kind: 'checks',
          filename: 'example-check.mjs',
          content: exampleCheckSource(languages[0] ?? 'typescript'),
          stableId: EXAMPLE_CHECK_IDS[languages[0] ?? 'typescript'] ?? '',
        },
      ]
    : languages.map((lang) => ({
        kind: 'checks',
        filename: `example-check-${lang}.mjs`,
        content: exampleCheckSource(lang, lang),
        stableId: EXAMPLE_CHECK_IDS[lang] ?? '',
      }));

  const slugs = single ? ['example-check'] : languages.map((lang) => `example-check-${lang}`);

  return [
    ...checkFiles,
    {
      kind: 'recipes',
      filename: 'example-recipe.mjs',
      content: exampleRecipeSource(slugs),
      stableId: 'URCP_example',
    },
  ];
}

/** fitness's COMPLETE stable example-id universe (every language's check id). */
export function fitStableExampleIds(): string[] {
  return Object.values(EXAMPLE_CHECK_IDS);
}
