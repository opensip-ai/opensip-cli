/**
 * @fileoverview Unit tests for typescript-frontend's command-mode output parser.
 * The check shells out to `tsc --noEmit` per `apps/*` dir; `parseTscOutput`
 * turns the marker-delimited combined output into violations. Driving the parser
 * directly avoids spawning tsc (which is toolchain/network dependent).
 */

import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseTscOutput } from '../checks/quality/linting/typescript-frontend.js'

const CWD = '/repo'

describe('typescript-frontend · parseTscOutput', () => {
  it('returns no violations when every app exits 0', () => {
    const out = ['::app::apps/web/', '::exit::0', '::app::apps/admin/', '::exit::0'].join('\n')
    expect(parseTscOutput(out, CWD)).toEqual([])
  })

  it('maps tsc diagnostics to violations with app-relative paths', () => {
    const out = [
      '::app::apps/web/',
      "src/main.ts(12,5): error TS2345: Argument of type 'number' is not assignable.",
      '::exit::2',
    ].join('\n')
    const v = parseTscOutput(out, CWD)
    expect(v).toHaveLength(1)
    expect(v[0]?.filePath).toBe(join(CWD, 'apps/web/', 'src/main.ts'))
    expect(v[0]?.line).toBe(12)
    expect(v[0]?.message).toContain('TS2345')
  })

  it('emits a generic failure when an app fails with no parseable diagnostics', () => {
    const out = ['::app::apps/web/', 'error TS18003: No inputs were found.', '::exit::1'].join('\n')
    const v = parseTscOutput(out, CWD)
    // The "No inputs" line lacks the file(line,col) prefix, so no structured
    // diagnostic is parsed — a single generic failure stands in.
    expect(v).toHaveLength(1)
    expect(v[0]?.message).toBe('App web compilation failed')
    expect(v[0]?.filePath).toBe(join(CWD, 'apps/web/'))
  })

  it('attributes diagnostics to the correct app across multiple apps', () => {
    const out = [
      '::app::apps/web/',
      '::exit::0',
      '::app::apps/admin/',
      'src/x.ts(1,1): error TS1005: ; expected.',
      '::exit::2',
    ].join('\n')
    const v = parseTscOutput(out, CWD)
    expect(v).toHaveLength(1)
    expect(v[0]?.filePath).toBe(join(CWD, 'apps/admin/', 'src/x.ts'))
  })

  it('caps reported diagnostics at 10 per app', () => {
    const lines = ['::app::apps/web/']
    for (let i = 1; i <= 15; i++) lines.push(`src/f${i}.ts(${i},1): error TS2304: Cannot find name.`)
    lines.push('::exit::2')
    expect(parseTscOutput(lines.join('\n'), CWD)).toHaveLength(10)
  })
})
