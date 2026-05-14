import { describe, it, expect } from 'vitest'
import { validateCheckConfig } from '../check-config.js'

const BASE_CONFIG = {
  id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  slug: 'test-check',
  description: 'A test check',
  tags: ['quality'],
  analyze: () => [],
}

describe('validateCheckConfig', () => {
  it('accepts a check with tags array', () => {
    expect(() => validateCheckConfig(BASE_CONFIG)).not.toThrow()
  })

  it('rejects a check without tags', () => {
    const config = { ...BASE_CONFIG, tags: undefined }
    expect(() => validateCheckConfig(config)).toThrow()
  })

  it('rejects a check with empty tags array', () => {
    const config = { ...BASE_CONFIG, tags: [] }
    expect(() => validateCheckConfig(config)).toThrow()
  })

  it('accepts arbitrary tag strings', () => {
    const config = { ...BASE_CONFIG, tags: ['custom-tag', 'another-one', 'cwe-89'] }
    expect(() => validateCheckConfig(config)).not.toThrow()
  })

  it('validates all three analysis modes with tags', () => {
    // analyze mode
    expect(() => validateCheckConfig({
      ...BASE_CONFIG,
      analyze: (_content: string) => [],
    })).not.toThrow()

    // analyzeAll mode
    const { analyze: _, ...noAnalyze } = BASE_CONFIG
    expect(() => validateCheckConfig({
      ...noAnalyze,
      analyzeAll: async () => [],
    })).not.toThrow()

    // command mode
    expect(() => validateCheckConfig({
      ...noAnalyze,
      command: {
        bin: 'echo',
        args: [],
        parseOutput: () => [],
      },
    })).not.toThrow()
  })

  it('rejects config without any analysis mode', () => {
    const { analyze: _, ...noMode } = BASE_CONFIG
    expect(() => validateCheckConfig(noMode)).toThrow()
  })
})
