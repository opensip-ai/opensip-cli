/**
 * @fileoverview Behaviour tests for the AST-based no-bootstrap-tool-import check
 * (release 3.0.0, §1). The headline invariant: the host must not statically
 * import a tool RUNTIME (`fitnessTool`/`graphTool`/`simulationTool`), but a
 * tool-package's NON-runtime API is fine, and a tool-runtime symbol appearing as
 * TEXT inside a template literal (the `init` scaffolds) is NOT a real import.
 */
import { runCheckOnFixture, type FixtureFile } from '@opensip-tools/fitness/internal'
import { describe, expect, it } from 'vitest'

import { analyzeBootstrapToolImport } from '../checks/architecture/no-bootstrap-tool-import.js'
import { checks } from '../index.js'

const CLI_PATH = 'packages/cli/src/sample.ts'

function check() {
  const c = checks.find((x) => x.config.slug === 'no-bootstrap-tool-import')
  if (!c) throw new Error('check not found: no-bootstrap-tool-import')
  return c
}

async function findingsFor(file: FixtureFile): Promise<number> {
  const run = await runCheckOnFixture(check(), { files: [file] })
  return run.findings.length
}

describe('analyzeBootstrapToolImport (AST)', () => {
  it('flags a static tool-runtime import (incl. aliased)', () => {
    const v = analyzeBootstrapToolImport(
      [
        "import { fitnessTool } from '@opensip-tools/fitness'",
        "import { graphTool as gt } from '@opensip-tools/graph'",
        'export const tools = [fitnessTool, gt]',
      ].join('\n'),
      CLI_PATH,
    )
    expect(v).toHaveLength(2)
    expect(v[0]?.message).toContain('fitnessTool')
    expect(v[1]?.message).toContain('graphTool')
  })

  it('does NOT flag a tool package NON-runtime API import', () => {
    const v = analyzeBootstrapToolImport(
      [
        "import { defineCheck } from '@opensip-tools/fitness'",
        "import { discoverGraphAdapterPackages, type GraphLanguageAdapter } from '@opensip-tools/graph'",
        'export const x = defineCheck',
      ].join('\n'),
      CLI_PATH,
    )
    expect(v).toEqual([])
  })

  it('IGNORES a tool-runtime symbol appearing as TEXT in a template literal (the scaffold invariant)', () => {
    // This is exactly the shape `init/config-templates.ts` emits — scaffold
    // source the host returns as a STRING, never executes. The AST sees a string
    // literal, not an import declaration.
    const v = analyzeBootstrapToolImport(
      [
        'export const scaffold = `',
        "import { fitnessTool } from '@opensip-tools/fitness';",
        'fitnessTool.run();',
        '`',
      ].join('\n'),
      CLI_PATH,
    )
    expect(v).toEqual([])
  })
})

describe('no-bootstrap-tool-import (gate)', () => {
  it('flags a tool-runtime import in CLI host code', async () => {
    expect(
      await findingsFor({ path: CLI_PATH, content: "import { simulationTool } from '@opensip-tools/simulation'\nexport const t = simulationTool" }),
    ).toBeGreaterThanOrEqual(1)
  })

  it('does NOT flag outside packages/cli/src (a tool engine importing a sibling)', async () => {
    expect(
      await findingsFor({ path: 'packages/graph/engine/src/x.ts', content: "import { fitnessTool } from '@opensip-tools/fitness'\nexport const t = fitnessTool" }),
    ).toBe(0)
  })

  it('does NOT flag test code (white-box tests may import a tool runtime)', async () => {
    expect(
      await findingsFor({ path: 'packages/cli/src/__tests__/x.test.ts', content: "import { fitnessTool } from '@opensip-tools/fitness'\nexport const t = fitnessTool" }),
    ).toBe(0)
  })
})
