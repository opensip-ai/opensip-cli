import { describe, expect, it } from 'vitest'

import { analyzeCliRealpathValidation } from '../cli-realpath-validation.js'

const CLI_FILE = 'packages/cli/src/foo.ts'
const PLUGIN_FILE = 'packages/core/src/plugins/discover.ts'
const OTHER_FILE = 'packages/dashboard/src/foo.ts'

describe('cli-realpath-validation', () => {
  it('flags filePath.startsWith(projectRoot) in cli/', () => {
    const src = `const ok = filePath.startsWith(projectRoot)\n`
    const v = analyzeCliRealpathValidation(src, CLI_FILE)
    expect(v).toHaveLength(1)
    expect(v[0]?.message).toContain('projectRoot')
  })

  it('flags the symmetric projectRoot.startsWith(...)', () => {
    const src = `if (projectRoot.startsWith(other)) {}\n`
    const v = analyzeCliRealpathValidation(src, CLI_FILE)
    expect(v).toHaveLength(1)
    expect(v[0]?.message).toContain('projectRoot.startsWith')
  })

  it('flags all conventional root names', () => {
    for (const name of [
      'projectRoot',
      'rootDir',
      'repoRoot',
      'baseDir',
      'cwd',
      'workspaceRoot',
      'packageDir',
      'nodeModulesDir',
      'parent',
    ]) {
      const src = `x.startsWith(${name})\n`
      expect(analyzeCliRealpathValidation(src, CLI_FILE).length).toBeGreaterThanOrEqual(
        1,
      )
    }
  })

  it('flags inside packages/core/src/plugins/', () => {
    const src = `const child = full.startsWith(packageDir)\n`
    expect(analyzeCliRealpathValidation(src, PLUGIN_FILE)).toHaveLength(1)
  })

  it('does NOT flag in other packages', () => {
    const src = `x.startsWith(projectRoot)\n`
    expect(analyzeCliRealpathValidation(src, OTHER_FILE)).toHaveLength(0)
  })

  it('does NOT flag startsWith on non-root variable names', () => {
    const src = `if (route.startsWith(prefix)) {}\nfoo.startsWith(scheme)\n`
    expect(analyzeCliRealpathValidation(src, CLI_FILE)).toHaveLength(0)
  })

  it('skips test files', () => {
    const src = `x.startsWith(projectRoot)\n`
    expect(
      analyzeCliRealpathValidation(src, 'packages/cli/src/__tests__/x.test.ts'),
    ).toHaveLength(0)
  })

  it('honors the @fitness-ignore-file directive', () => {
    const src = `// @fitness-ignore-file cli-realpath-validation\nx.startsWith(projectRoot)\n`
    expect(analyzeCliRealpathValidation(src, CLI_FILE)).toHaveLength(0)
  })
})
