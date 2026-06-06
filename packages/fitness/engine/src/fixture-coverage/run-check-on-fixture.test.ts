/**
 * Unit tests for the in-process fixture harness (gap P0).
 *
 * Drives `runCheckOnFixture` with a real `defineCheck` that flags the literal
 * `BANNED`: clean fixture → 0 findings, violation → ≥1, multi-file fixtures
 * write siblings, and findings are filtered to the check's own ruleId.
 */

import { describe, expect, it } from 'vitest'

import { defineCheck } from '../framework/define-check.js'

import { runCheckOnFixture } from './run-check-on-fixture.js'

import type { CheckViolation } from '../framework/check-config.js'

const bannedCheck = defineCheck({
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'banned-token',
  description: 'flags the literal BANNED',
  tags: ['test'],
  analyze: (content: string, filePath: string): CheckViolation[] =>
    content.includes('BANNED') ? [{ message: 'found BANNED', severity: 'error', filePath, line: 1 }] : [],
})

describe('runCheckOnFixture', () => {
  it('clean fixture → zero findings', async () => {
    const run = await runCheckOnFixture(bannedCheck, {
      files: [{ path: 'fixture.ts', content: 'export const ok = 1\n' }],
    })
    expect(run.findings).toHaveLength(0)
  })

  it('violation fixture → at least one finding, all this check’s ruleId', async () => {
    const run = await runCheckOnFixture(bannedCheck, {
      files: [{ path: 'fixture.ts', content: 'export const x = "BANNED"\n' }],
    })
    expect(run.findings.length).toBeGreaterThanOrEqual(1)
    expect(run.findings.every((s) => s.ruleId === 'fit:banned-token')).toBe(true)
  })

  it('multi-file fixture: writes siblings and targets all of them', async () => {
    const run = await runCheckOnFixture(bannedCheck, {
      files: [
        { path: 'a.ts', content: 'export const a = 1\n' },
        { path: 'nested/b.ts', content: 'export const b = "BANNED"\n' },
      ],
    })
    expect(run.findings.length).toBeGreaterThanOrEqual(1)
  })

  it('targetPaths narrows which files the check sees', async () => {
    const run = await runCheckOnFixture(bannedCheck, {
      files: [
        { path: 'seen.ts', content: 'export const ok = 1\n' },
        { path: 'ignored.ts', content: 'export const x = "BANNED"\n' },
      ],
      targetPaths: ['seen.ts'],
    })
    expect(run.findings).toHaveLength(0)
  })
})
