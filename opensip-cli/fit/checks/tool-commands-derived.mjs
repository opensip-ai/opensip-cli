/**
 * @fileoverview tool-commands-derived — first-party tools must use a canonical
 *               Tool factory and must not hand-maintain a commands[] list that
 *               diverges from commandSpecs. Project-local SELF-check.
 */
import { defineCheck } from '@opensip-cli/fitness';

import { toolDescriptorPathRe } from './tool-engine-paths.mjs';

const TOOL_PATH = toolDescriptorPathRe();
const DIRECT_TOOL_FACTORY = /\bdefineTool\s*\(/;
const EXTERNAL_ADAPTER_FACTORY = /\bdefineExternalToolAdapter\s*\(/;

/** Hand-maintained command descriptor constants (pre-defineTool pattern). */
const HAND_COMMAND_DESCRIPTOR = /:\s*ToolCommandDescriptor\s*=/;

/** Top-level hook fields that belong in extensionPoints after defineTool migration. */
const TOP_LEVEL_HOOK =
  /^\s*(?:initialize|contributeScope|collectReportData|sessionReplay|config|capabilityRegistrars|fingerprintStrategy|scaffoldExamples|stableExampleIds|scaffoldConfigBlock)\s*[,:]/;

export function analyzeToolCommandsDerived(content, filePath) {
  if (!TOOL_PATH.test(filePath.replaceAll('\\', '/'))) return [];

  const violations = [];
  const lines = content.split('\n');

  const usesDirectFactory = DIRECT_TOOL_FACTORY.test(content);
  const usesExternalAdapterFactory = EXTERNAL_ADAPTER_FACTORY.test(content);
  if (!usesDirectFactory && !usesExternalAdapterFactory) {
    violations.push({
      message:
        'First-party tool registration must use defineTool() or defineExternalToolAdapter() so commands[] is derived from commandSpecs.',
      severity: 'error',
      line: 1,
      suggestion:
        'Export the tool via defineTool({ metadata, commandSpecs, extensionPoints }) or the external adapter factory.',
    });
    return violations;
  }

  if (HAND_COMMAND_DESCRIPTOR.test(content)) {
    const line = lines.findIndex((l) => HAND_COMMAND_DESCRIPTOR.test(l));
    violations.push({
      message:
        'Hand-maintained ToolCommandDescriptor constants are obsolete; defineTool derives commands[] from commandSpecs.',
      severity: 'error',
      line: line + 1,
      suggestion: 'Delete the descriptor constants and declare commands only as CommandSpecs.',
    });
  }

  // The adapter factory owns its Tool lifecycle mapping. Fields such as config
  // and fingerprintStrategy belong to ExternalToolAdapterSpec, not Tool itself.
  if (usesExternalAdapterFactory) return violations;

  let inExtensionPoints = false;
  let braceDepth = 0;
  for (const [i, line] of lines.entries()) {
    if (/\bextensionPoints\s*:\s*\{/.test(line)) {
      inExtensionPoints = true;
      braceDepth = (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
      continue;
    }
    if (inExtensionPoints) {
      braceDepth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
      if (braceDepth <= 0) {
        inExtensionPoints = false;
      }
      continue;
    }
    if (/\bdefineTool\s*\(/.test(line) || /^\s*extensionPoints\s*:/.test(line)) continue;
    if (TOP_LEVEL_HOOK.test(line) && !inExtensionPoints) {
      violations.push({
        message:
          'Tool lifecycle hooks must live in extensionPoints; top-level hook fields are legacy.',
        severity: 'error',
        line: i + 1,
        suggestion: 'Move the hook into defineTool({ extensionPoints: { ... } }).',
      });
    }
  }

  return violations;
}

export const checks = [
  defineCheck({
    id: 'c4e8f1a2-9b3d-4e5f-a6c7-8d9e0f1a2b3c',
    slug: 'tool-commands-derived',
    description: 'First-party tools use canonical Tool factories; no hand-maintained commands[]',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture'],
    fileTypes: ['ts'],
    contentFilter: 'raw',
    analyze: (content, filePath) => analyzeToolCommandsDerived(content, filePath),
  }),
];
