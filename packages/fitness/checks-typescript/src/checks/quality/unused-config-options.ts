// @fitness-ignore-file toctou-race-condition -- TOCTOU acceptable in this non-concurrent context
// @fitness-ignore-file unused-config-options -- Config options reserved for future use or environment-specific
/**
 * @fileoverview Unused Configuration Options Check
 *
 * Detects configuration properties that are defined but never accessed.
 */

import { logger } from '@opensip-tools/core/logger'
import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-tools/fitness'
import { getSharedSourceFile } from '@opensip-tools/lang-typescript'
import * as ts from 'typescript'

interface ConfigProperty {
  name: string
  interfaceName: string
  filePath: string
  line: number
  isOptional: boolean
}

/**
 * Common property names that are ubiquitous and would cause false positives
 */
const COMMON_PROPERTY_NAMES = new Set([
  // Very common config properties used everywhere
  'enabled',
  'disabled',
  'timeout',
  'retries',
  'debug',
  'verbose',
  'name',
  'type',
  'id',
  'key',
  'value',
  'data',
  'options',
  'config',
  'settings',
  'port',
  'host',
  'url',
  'path',
  'level',
  'mode',
])

/**
 * Paths where this check should not run (CLI, scripts, test utilities)
 */
const NON_CONFIG_CONSUMER_PATTERNS = [
  /\/cli\//,
  /\/scripts\//,
  /\/bin\//,
  /__tests__\//,
  /\.test\./,
  /\.spec\./,
  /\/testing\//,
  // Type definition files only
  /types\.ts$/,
  /interfaces\.ts$/,
  /index\.d\.ts$/,
]

/**
 * Check if a path should be excluded from analysis
 */
function shouldExcludePath(filePath: string): boolean {
  return NON_CONFIG_CONSUMER_PATTERNS.some((pattern) => pattern.test(filePath))
}

/**
 * Check if interface is a Config/Options interface.
 */
function isConfigInterface(interfaceName: string): boolean {
  return interfaceName.includes('Config') || interfaceName.includes('Options')
}

/**
 * Extract property from interface member.
 */
function extractPropertyFromMember(
  member: ts.TypeElement,
  sourceFile: ts.SourceFile,
  interfaceName: string,
  filePath: string,
): ConfigProperty | null {
  if (!ts.isPropertySignature(member)) return null
  if (!ts.isIdentifier(member.name)) return null

  const propName = member.name.text

  // Skip common property names that would cause many false positives
  if (COMMON_PROPERTY_NAMES.has(propName)) return null

  const { line } = sourceFile.getLineAndCharacterOfPosition(member.getStart())
  return {
    name: propName,
    interfaceName,
    filePath,
    line: line + 1,
    isOptional: member.questionToken !== undefined,
  }
}

/**
 * Extract config properties from interface members
 */
function extractInterfaceProperties(
  node: ts.InterfaceDeclaration,
  sourceFile: ts.SourceFile,
  filePath: string,
): ConfigProperty[] {
  const properties: ConfigProperty[] = []
  const interfaceName = node.name.text

  for (const member of node.members) {
    const prop = extractPropertyFromMember(member, sourceFile, interfaceName, filePath)
    if (!prop) continue
    properties.push(prop)
  }

  return properties
}

function isConfigFilePath(filePath: string): boolean {
  return filePath.includes('config') || filePath.includes('Config')
}

async function extractConfigPropertiesFromFile(
  filePath: string,
  files: FileAccessor,
): Promise<ConfigProperty[]> {
  // @lazy-ok -- visit function's conditionals are not pre-await validation guards
  const content = await files.read(filePath)
  const sourceFile = getSharedSourceFile(filePath, content)
    if (!sourceFile) return []
  const properties: ConfigProperty[] = []

  const visit = (node: ts.Node): void => {
    ts.forEachChild(node, visit)
    if (!ts.isInterfaceDeclaration(node)) return
    if (!isConfigInterface(node.name.text)) return
    properties.push(...extractInterfaceProperties(node, sourceFile, filePath))
  }

  void visit(sourceFile)
  return properties
}

async function collectConfigProperties(files: FileAccessor): Promise<ConfigProperty[]> {
  logger.debug({
    evt: 'fitness.collect_config_properties.start',
    msg: 'Collecting config properties',
  })
  const configProperties: ConfigProperty[] = []

  for (const filePath of files.paths) {
    if (shouldExcludePath(filePath) || !isConfigFilePath(filePath)) continue

    try {
      // @fitness-ignore-next-line performance-anti-patterns -- sequential file reading to control memory; FileAccessor is lazy
      const props = await extractConfigPropertiesFromFile(filePath, files)
      configProperties.push(...props)
    } catch {
      // @swallow-ok Skip unreadable files
    }
  }

  logger.debug({
    evt: 'fitness.collect_config_properties.complete',
    count: configProperties.length,
    msg: 'Config properties collected',
  })
  return configProperties
}

async function countPropertyAccesses(files: FileAccessor): Promise<Map<string, number>> {
  logger.debug({
    evt: 'fitness.count_property_accesses.start',
    msg: 'Counting property accesses across files',
  })
  const accessCounts = new Map<string, number>()

  for (const filePath of files.paths) {
    try {
      // @fitness-ignore-next-line performance-anti-patterns -- sequential file reading to control memory; FileAccessor is lazy
      const content = await files.read(filePath)
      const sourceFile = getSharedSourceFile(filePath, content)
      if (!sourceFile) continue

      const visit = (node: ts.Node): void => {
        if (ts.isPropertyAccessExpression(node)) {
          const propertyName = node.name.text
          accessCounts.set(propertyName, (accessCounts.get(propertyName) ?? 0) + 1)
        }

        if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
          const propertyName = node.name.text
          accessCounts.set(propertyName, (accessCounts.get(propertyName) ?? 0) + 1)
        }

        ts.forEachChild(node, visit)
      }

      void visit(sourceFile)
    } catch {
      // @swallow-ok Skip unreadable files
    }
  }

  return accessCounts
}

function createViolationForUnusedProperty(prop: ConfigProperty): CheckViolation {
  return {
    line: prop.line,
    column: 0,
    message: `Config property '${prop.name}' in ${prop.interfaceName} is never accessed`,
    severity: 'warning',
    suggestion: `Remove unused config property '${prop.name}' from ${prop.interfaceName}, or implement code that uses this configuration option`,
    match: prop.name,
    filePath: prop.filePath,
  }
}

function findUnusedProperties(
  configProperties: ConfigProperty[],
  accessCounts: Map<string, number>,
): CheckViolation[] {
  const violations: CheckViolation[] = []

  for (const prop of configProperties) {
    if (prop.isOptional) continue
    const count = accessCounts.get(prop.name) ?? 0
    if (count === 0) {
      violations.push(createViolationForUnusedProperty(prop))
    }
  }

  return violations
}

/**
 * Check: quality/unused-config-options
 *
 * Detects configuration properties defined but never accessed.
 */
export const unusedConfigOptions = defineCheck({
  id: '09006e97-77fd-4a75-9a9a-d5ed0abb9d9f',
  slug: 'unused-config-options',
  scope: { languages: ['json', 'typescript', 'yaml'], concerns: ['config'] },
  contentFilter: 'raw',

  confidence: 'high',
  description: 'Detects configuration properties defined but never accessed',
  longDescription: `**Purpose:** Detects configuration properties that are defined in Config/Options interfaces but never accessed anywhere in the codebase.

**Detects:**
- Required (non-optional) properties in interfaces containing \`Config\` or \`Options\` in their name
- Properties with zero \`PropertyAccessExpression\` or \`BindingElement\` references across all scanned files
- Excludes common property names (\`enabled\`, \`timeout\`, \`port\`, \`host\`, etc.) to reduce false positives

**Why it matters:** Unused config properties add cognitive overhead and suggest incomplete implementations or abandoned features that should be cleaned up.

**Scope:** General best practice. Cross-file analysis (\`analyzeAll\`). Scans config files for property definitions, then counts access patterns across all production files.`,
  tags: ['quality', 'code-quality', 'maintainability'],
  fileTypes: ['ts', 'tsx'],

  async analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
    // @fitness-ignore-next-line async-waterfall-detection -- Both scan all files independently; parallelizing would double peak memory by loading file contents twice concurrently
    const configProperties = await collectConfigProperties(files)
    const accessCounts = await countPropertyAccesses(files)
    return findUnusedProperties(configProperties, accessCounts)
  },
})
