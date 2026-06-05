/**
 * Coverage for `parseGraphDirectives` — the graph grammar of the
 * directive-audit parser family (`@graph-ignore-file`,
 * `@graph-ignore-next-line`). Graph rule ids are already `graph:`-namespaced,
 * so the parsed id is used verbatim as `rule` (unlike fitness's `fitness/<id>`
 * prefixing).
 */
import { describe, expect, it } from 'vitest'

import { parseGraphDirectives } from './graph.js'

const FILE = 'src/foo.ts'
const SHORT = 'foo.ts'

describe('parseGraphDirectives', () => {
  it('parses a next-line directive into a graph-sourced DirectiveInfo', () => {
    const content = ['// @graph-ignore-next-line graph:cycle -- intentional recursion', 'function visit() {}'].join('\n')
    const directives = parseGraphDirectives(content, FILE, SHORT)
    expect(directives).toHaveLength(1)
    const d = directives[0]
    expect(d?.source).toBe('graph')
    expect(d?.scope).toBe('next-line')
    expect(d?.rule).toBe('graph:cycle')
    expect(d?.reason).toBe('intentional recursion')
    expect(d?.file).toBe(SHORT)
    expect(d?.filePath).toBe(FILE)
    expect(d?.line).toBe(1)
  })

  it('parses a file-level directive with scope "file"', () => {
    const content = ['// @graph-ignore-file graph:wide-function -- generated code', 'export const x = 1'].join('\n')
    const directives = parseGraphDirectives(content, FILE, SHORT)
    expect(directives).toHaveLength(1)
    expect(directives[0]?.scope).toBe('file')
    expect(directives[0]?.rule).toBe('graph:wide-function')
    expect(directives[0]?.reason).toBe('generated code')
  })

  it('preserves the full reason text after the -- separator', () => {
    const content = '// @graph-ignore-next-line graph:large-function -- big switch is clearer inline'
    const directives = parseGraphDirectives(content, FILE, SHORT)
    expect(directives[0]?.reason).toBe('big switch is clearer inline')
  })

  it('skips a directive with no -- reason separator (audit requires a reason)', () => {
    const content = '// @graph-ignore-next-line graph:cycle'
    expect(parseGraphDirectives(content, FILE, SHORT)).toHaveLength(0)
  })

  it('returns no directives for content with no graph markers', () => {
    const content = ['function visit() {}', '// @fitness-ignore-next-line some-check -- nope'].join('\n')
    expect(parseGraphDirectives(content, FILE, SHORT)).toHaveLength(0)
  })
})
