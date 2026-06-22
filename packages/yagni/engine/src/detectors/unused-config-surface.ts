/**
 * unused-config-surface — flags required config properties on the public API
 * surface that are never read anywhere in the project.
 *
 * Subsumes the fitness `unused-config-options` check by scoping definitions to
 * files reachable from `package.json#exports` via re-export chains.
 */

import { readFileSync } from 'node:fs';

import { isInPublicApiSurface } from '@opensip-cli/core';
import { getSharedSourceFile } from '@opensip-cli/lang-typescript';
import * as ts from 'typescript';

import { createYagniSignal } from './create-yagni-signal.js';
import { walkTypeScriptFiles } from '../lib/walk-typescript-files.js';

import type { YagniDetector, YagniDetectorContext, YagniDetectorResult } from './types.js';

const DETECTOR_ID = 'unused-config-surface';
const SLUG = 'yagni:unused-config-surface';

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

function isConfigInterface(name: string): boolean {
  return name.includes('Config') || name.includes('Options');
}

function isConfigFilePath(filePath: string): boolean {
  return filePath.includes('config') || filePath.includes('Config');
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
    if (!isConfigFilePath(filePath) || !isInPublicApiSurface(filePath)) continue;
    let content: string;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    const sourceFile = getSharedSourceFile(filePath, content);
    if (!sourceFile) continue;
    const visit = (node: ts.Node): void => {
      ts.forEachChild(node, visit);
      if (!ts.isInterfaceDeclaration(node) || !isConfigInterface(node.name.text)) return;
      properties.push(...extractInterfaceProperties(node, sourceFile, filePath));
    };
    visit(sourceFile);
  }
  return properties;
}

function countPropertyAccesses(filePaths: readonly string[]): Map<string, number> {
  const accessCounts = new Map<string, number>();
  for (const filePath of filePaths) {
    let content: string;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    const sourceFile = getSharedSourceFile(filePath, content);
    if (!sourceFile) continue;
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

async function runUnusedConfigSurface(ctx: YagniDetectorContext): Promise<YagniDetectorResult> {
  const started = Date.now();
  const filePaths = walkTypeScriptFiles(ctx.cwd, ctx.includeTests);
  const configProperties = collectConfigProperties(filePaths);
  const accessCounts = countPropertyAccesses(filePaths);

  const signals = [];
  for (const prop of configProperties) {
    if (prop.isOptional) continue;
    if ((accessCounts.get(prop.name) ?? 0) > 0) continue;
    signals.push(
      createYagniSignal({
        source: SLUG,
        ruleId: SLUG,
        severity: 'low',
        category: 'quality',
        message: `Public config property '${prop.name}' in ${prop.interfaceName} is never accessed`,
        suggestion: `Remove '${prop.name}' from ${prop.interfaceName} or implement code that reads it`,
        code: { file: prop.filePath, line: prop.line, column: 0 },
        yagni: {
          detector: DETECTOR_ID,
          confidence: 0.85,
          category: 'config-surface',
          evidenceKind: 'unused-config-property',
          evidence: {
            property: prop.name,
            interfaceName: prop.interfaceName,
            filePath: prop.filePath,
            line: prop.line,
            publicApiSurface: true,
          },
          recommendation: 'Delete the unused public config knob or wire it into runtime behavior.',
        },
      }),
    );
  }

  return { signals, durationMs: Date.now() - started };
}

export const unusedConfigSurfaceDetector: YagniDetector = {
  id: DETECTOR_ID,
  slug: SLUG,
  description: 'Unused required config properties on the public API surface',
  requiresGraph: false,
  run: runUnusedConfigSurface,
};