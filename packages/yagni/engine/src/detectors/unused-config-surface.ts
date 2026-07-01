/**
 * unused-config-surface — flags required config properties on the public API
 * surface that are never read anywhere in the project.
 *
 * Subsumes the fitness `unused-config-options` check by scoping definitions to
 * files reachable from `package.json#exports` via re-export chains.
 */

import { readFileSync, statSync } from 'node:fs';
import { relative } from 'node:path';

import { isInPublicApiSurface, namespacedRuleId, withSpan } from '@opensip-cli/core';
import { getSharedSourceFile } from '@opensip-cli/lang-typescript';
import * as ts from 'typescript';

import { walkTypeScriptFiles } from '../lib/walk-typescript-files.js';
import { severityForConfidence } from '../scoring/confidence.js';

import { createYagniSignal } from './create-yagni-signal.js';
import { defineDetector } from './define-detector.js';

import type { YagniDetectorContext, YagniDetectorResult } from './types.js';

const DETECTOR_ID = 'unused-config-surface';
const SLUG = namespacedRuleId('yagni', DETECTOR_ID);
const MAX_SOURCE_FILE_BYTES = 1_000_000;

const COMMON_PROPERTY_NAMES = new Set([
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
]);

interface ConfigProperty {
  readonly name: string;
  readonly interfaceName: string;
  readonly filePath: string;
  readonly line: number;
  readonly isOptional: boolean;
}

function isPublicConfigSurfaceInterface(interfaceName: string): boolean {
  return /\b(?:\w*Config|\w*Options)\b/.test(interfaceName);
}

function mayContainConfigSurface(filePath: string): boolean {
  return filePath.toLowerCase().includes('config');
}

function readBoundedSourceFile(filePath: string): string | undefined {
  try {
    const stats = statSync(filePath);
    if (!stats.isFile() || stats.size > MAX_SOURCE_FILE_BYTES) return undefined;
    return readFileSync(filePath, 'utf8');
  } catch {
    // @swallow-ok unreadable files are skipped; callers treat undefined as "no source available".
    return undefined;
  }
}

function extractPropertyFromMember(
  member: ts.TypeElement,
  sourceFile: ts.SourceFile,
  interfaceName: string,
  filePath: string,
): ConfigProperty | null {
  if (!ts.isPropertySignature(member) || !ts.isIdentifier(member.name)) return null;
  const propName = member.name.text;
  if (COMMON_PROPERTY_NAMES.has(propName)) return null;
  const { line } = sourceFile.getLineAndCharacterOfPosition(member.getStart());
  return {
    name: propName,
    interfaceName,
    filePath,
    line: line + 1,
    isOptional: member.questionToken !== undefined,
  };
}

function extractInterfaceProperties(
  node: ts.InterfaceDeclaration,
  sourceFile: ts.SourceFile,
  filePath: string,
): ConfigProperty[] {
  const properties: ConfigProperty[] = [];
  for (const member of node.members) {
    const prop = extractPropertyFromMember(member, sourceFile, node.name.text, filePath);
    if (prop) properties.push(prop);
  }
  return properties;
}

function collectConfigProperties(filePaths: readonly string[]): ConfigProperty[] {
  const properties: ConfigProperty[] = [];
  for (const filePath of filePaths) {
    if (!mayContainConfigSurface(filePath) || !isInPublicApiSurface(filePath)) continue;
    const content = readBoundedSourceFile(filePath);
    if (content === undefined) continue;
    const sourceFile = getSharedSourceFile(filePath, content);
    if (!sourceFile) continue;
    const visit = (node: ts.Node): void => {
      ts.forEachChild(node, visit);
      if (!ts.isInterfaceDeclaration(node) || !isPublicConfigSurfaceInterface(node.name.text))
        return;
      properties.push(...extractInterfaceProperties(node, sourceFile, filePath));
    };
    visit(sourceFile);
  }
  return properties;
}

function countPropertyAccesses(filePaths: readonly string[]): Map<string, number> {
  const accessCounts = new Map<string, number>();
  for (const filePath of filePaths) {
    const content = readBoundedSourceFile(filePath);
    if (content === undefined) continue;
    const sourceFile = getSharedSourceFile(filePath, content);
    if (!sourceFile) continue;
    // eslint-disable-next-line unicorn/consistent-function-scoping -- closes over per-file sourceFile; hoisting would thread extra params through every callsite
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node)) {
        const propertyName = node.name.text;
        accessCounts.set(propertyName, (accessCounts.get(propertyName) ?? 0) + 1);
      }
      if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
        const propertyName = node.name.text;
        accessCounts.set(propertyName, (accessCounts.get(propertyName) ?? 0) + 1);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return accessCounts;
}

function runUnusedConfigSurface(ctx: YagniDetectorContext): Promise<YagniDetectorResult> {
  const result = withSpan(
    'opensip-cli-yagni',
    'yagni.unused_config_surface',
    () => {
      const started = Date.now();
      const filePaths = walkTypeScriptFiles(ctx.cwd, ctx.includeTests, ctx.pathRoots);
      const configProperties = collectConfigProperties(filePaths);
      const accessCounts = countPropertyAccesses(filePaths);

      const signals = [];
      for (const prop of configProperties) {
        if (prop.isOptional) continue;
        if ((accessCounts.get(prop.name) ?? 0) > 0) continue;
        const relPath = relative(ctx.cwd, prop.filePath).split('\\').join('/');
        const confidence = 'high' as const;
        const evidenceId = `unused-config:${relPath}:${String(prop.line)}:${prop.name}`;
        signals.push(
          createYagniSignal({
            source: SLUG,
            ruleId: SLUG,
            severity: severityForConfidence(confidence),
            category: 'quality',
            message: `Unused public config key '${prop.name}' in ${prop.interfaceName} (${confidence} confidence)`,
            suggestion: `Remove '${prop.name}' from ${prop.interfaceName} or wire it into runtime behavior`,
            code: { file: prop.filePath, line: prop.line, column: 0 },
            repair: {
              repairKind: 'manual',
              autofixable: false,
              confidence: 0.9,
              patchHint: {
                kind: 'text',
                summary: `Remove unused key \`${prop.name}\` from ${prop.interfaceName}.`,
                target: prop.filePath,
              },
            },
            yagni: {
              detector: DETECTOR_ID,
              reductionCategory: 'config',
              confidence,
              locDelta: {
                remove: 1,
                add: 0,
                netEstimate: 1,
                estimateKind: 'exact',
              },
              preservationArgument:
                'The property is declared on a public config interface but has zero read sites in the project.',
              validationRequired: [
                'Confirm no dynamic property access reads this key.',
                'Run the package test suite after removal.',
              ],
              riskTags: ['public-api-surface'],
              evidence: [
                {
                  id: evidenceId,
                  kind: 'unused-config-property',
                  summary: `Required property '${prop.name}' on ${prop.interfaceName} has no read sites.`,
                  data: {
                    property: prop.name,
                    interfaceName: prop.interfaceName,
                    filePath: relPath,
                    line: prop.line,
                    publicApiSurface: true,
                  },
                },
              ],
            },
          }),
        );
      }

      return { signals, durationMs: Date.now() - started };
    },
    { 'yagni.detector': DETECTOR_ID },
  );

  return Promise.resolve(result);
}

export const unusedConfigSurfaceDetector = defineDetector({
  id: DETECTOR_ID,
  slug: SLUG,
  description: 'Unused required config properties on the public API surface',
  run: runUnusedConfigSurface,
});
