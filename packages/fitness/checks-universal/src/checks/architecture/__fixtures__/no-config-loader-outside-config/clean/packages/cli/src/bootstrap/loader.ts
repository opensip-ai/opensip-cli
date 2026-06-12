// CLEAN: reads the targeting document THROUGH the config-owned schema. The
// parsed-doc binding is handed to .safeParse, and fields are read off the parse
// RESULT (`result.data.targets`), never off the raw doc — the allowed path.
import { targetsRecordSchema } from '@opensip-cli/config'

export function loadTargets(configPath: string) {
  const parsed = readYamlFileOrThrow(configPath)
  const result = targetsRecordSchema.safeParse(parsed)
  if (!result.success) throw new Error('invalid')
  const targets = result.data
  return Object.keys(targets)
}
