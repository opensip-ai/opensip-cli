import { defineCheck } from '@opensip-cli/fitness'

const PATTERN = /foo/

export const sampleCheck = defineCheck({
  id: 'aaaaaaaa-0000-0000-0000-000000000000',
  slug: 'sample-check',
  description: 'sample',
  analyze(content) {
    return PATTERN.test(content) ? [{ line: 1, message: 'found', severity: 'warning' }] : []
  },
})
