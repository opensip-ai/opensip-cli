/**
 * Unit tests for the pure `analyzeEnvViaRegistry` detector (release 2.12.0,
 * §5.12). Operates on `strip-strings-and-comments`-filtered content; these tests
 * feed it real-code shapes. Path-based scope (check-pack / test / allowlist
 * exclusion) is exercised through the exported check elsewhere.
 */
import { describe, expect, it } from 'vitest'

import { analyzeEnvViaRegistry } from '../env-via-registry.js'

describe('analyzeEnvViaRegistry', () => {
  it('flags a member read of a specific variable', () => {
    const v = analyzeEnvViaRegistry('const k = process.env.OPENSIP_API_KEY')
    expect(v).toHaveLength(1)
    expect(v[0]?.severity).toBe('error')
    expect(v[0]?.message).toContain('EnvRegistry')
  })

  it('flags an index read of a specific variable', () => {
    expect(analyzeEnvViaRegistry('const v = process.env[name]')).toHaveLength(1)
  })

  it('does NOT flag whole-env passthrough to a subprocess', () => {
    // Forwarding the full environment to a child is legitimate, not a governed read.
    expect(analyzeEnvViaRegistry('spawn(bin, { env: process.env })')).toHaveLength(0)
    expect(analyzeEnvViaRegistry('const env = { ...process.env, X: 1 }')).toHaveLength(0)
    expect(analyzeEnvViaRegistry('function run(env = process.env) {}')).toHaveLength(0)
  })
})
