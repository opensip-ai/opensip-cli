import { posix } from 'node:path';

import { factBinding } from '../model/fact-binding.js';
import { deepFreeze, isUnknownRecord as isRecord } from '../model/value-helpers.js';

import { asNativeReadPayload } from './native-response.js';
import { responseDataRecord } from './task-response-extractors.js';

import type {
  AnswerFact,
  FactBinding,
  GoldTask,
  ResponseExtractor,
  StrategyStep,
} from '../model/task.js';

const CONTROL_STRATEGY_VERSION = 'control-native-v1';
const OPENSIP_STRATEGY_VERSION = 'opensip-mcp-epoch-4';
const MAX_SOURCE_BYTES = 65_536;
const ENTRY_FILE = 'src/index.ts';
const ENTRY_SYMBOL = 'main';
const FEATURE_SYMBOL = 'submitInvoice';
const IMPLEMENTATION_FILE = 'src/services/billing/calculate-invoice.ts';
const IMPLEMENTATION_SYMBOL = 'calculateInvoice';
const SYMBOL_HANDLE_KIND = 'symbol-handle';
const CALLED_IMPORT_ROLE = 'called-import';

interface SymbolProjection {
  readonly bodyHash: string;
  readonly column: number;
  readonly filePath: string;
  readonly inTestFile: boolean;
  readonly line: number;
  readonly package: string;
  readonly qualifiedName: string;
  readonly simpleName: string;
  readonly symbolId: string;
}

function sourceTargetPath(sourcePath: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const normalized = posix.normalize(posix.join(posix.dirname(sourcePath), specifier));
  if (normalized === '..' || normalized.startsWith('../') || posix.isAbsolute(normalized)) {
    return undefined;
  }
  return normalized.endsWith('.js') ? `${normalized.slice(0, -3)}.ts` : normalized;
}

function bindingNames(clause: string): readonly string[] {
  return clause.split(',').flatMap((rawBinding) => {
    const binding = rawBinding.trim().replace(/^type\s+/u, '');
    if (binding.length === 0) return [];
    const alias = binding.split(/\s+as\s+/u).map((part) => part.trim());
    const name = alias.at(-1);
    return name === undefined || name.length === 0 ? [] : [name];
  });
}

function moduleTargetFacts(
  content: string,
  sourcePath: string,
  direction: 'export' | 'import',
): readonly AnswerFact[] {
  const expression =
    direction === 'import'
      ? /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/gu
      : /export\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/gu;
  const facts: AnswerFact[] = [];
  for (const match of content.matchAll(expression)) {
    const clause = match[1];
    const specifier = match[2];
    if (clause === undefined || specifier === undefined) continue;
    const targetPath = sourceTargetPath(sourcePath, specifier);
    if (targetPath === undefined) continue;
    for (const name of bindingNames(clause)) {
      facts.push({
        kind: 'file',
        path: targetPath,
        role: `${direction}s:${name}`,
      });
    }
  }
  return facts;
}

function calledImportFacts(content: string, sourcePath: string): readonly AnswerFact[] {
  return moduleTargetFacts(content, sourcePath, 'import').flatMap((fact): readonly AnswerFact[] => {
    if (fact.kind !== 'file' || !fact.role?.startsWith('imports:')) return [];
    const importedName = fact.role.slice('imports:'.length);
    const escaped = importedName.replace(/[|\\{}()[\]^$+*?.]/gu, '\\$&');
    return new RegExp(`\\b${escaped}\\s*\\(`, 'u').test(content)
      ? [{ kind: 'file', path: fact.path, role: CALLED_IMPORT_ROLE }]
      : [];
  });
}

function declaredFunctionFacts(content: string, sourcePath: string): readonly AnswerFact[] {
  return [
    ...content.matchAll(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gu),
  ].flatMap((match): readonly AnswerFact[] => {
    const name = match[1];
    return name === undefined ? [] : [{ filePath: sourcePath, kind: 'symbol', name }];
  });
}

function extractSource(payload: unknown): readonly AnswerFact[] {
  const result = asNativeReadPayload(payload);
  if (result === undefined) return [];
  return [
    ...declaredFunctionFacts(result.content, result.path),
    ...moduleTargetFacts(result.content, result.path, 'import'),
    ...moduleTargetFacts(result.content, result.path, 'export'),
    ...calledImportFacts(result.content, result.path),
  ];
}

function extractTraceTerminalSource(payload: unknown): readonly AnswerFact[] {
  const facts = extractSource(payload);
  const symbols = facts.filter(
    (fact): fact is Extract<AnswerFact, { readonly kind: 'symbol' }> => fact.kind === 'symbol',
  );
  return [
    ...facts,
    ...symbols.map((symbol): AnswerFact => ({
      evidenceKind: 'manual-source-trace',
      filePath: symbol.filePath,
      kind: 'evidence',
      subject: `terminal:${symbol.name}`,
    })),
  ];
}

function asSymbolProjection(value: unknown): SymbolProjection | undefined {
  const stringFields = [
    'bodyHash',
    'filePath',
    'package',
    'qualifiedName',
    'simpleName',
    'symbolId',
  ] as const;
  if (
    !isRecord(value) ||
    stringFields.some((field) => typeof value[field] !== 'string') ||
    typeof value.column !== 'number' ||
    typeof value.line !== 'number' ||
    typeof value.inTestFile !== 'boolean'
  ) {
    return undefined;
  }
  return value as unknown as SymbolProjection;
}

function factsForSymbol(symbol: SymbolProjection): readonly AnswerFact[] {
  return [
    {
      bodyHash: symbol.bodyHash,
      column: symbol.column,
      filePath: symbol.filePath,
      inTestFile: symbol.inTestFile,
      kind: SYMBOL_HANDLE_KIND,
      line: symbol.line,
      name: symbol.simpleName,
      package: symbol.package,
      qualifiedName: symbol.qualifiedName,
      symbolId: symbol.symbolId,
    },
    {
      filePath: symbol.filePath,
      kind: 'symbol',
      name: symbol.simpleName,
    },
  ];
}

function symbolsFromArray(value: unknown): readonly SymbolProjection[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): readonly SymbolProjection[] => {
    const symbol = asSymbolProjection(candidate);
    return symbol === undefined ? [] : [symbol];
  });
}

function extractSymbolSearch(payload: unknown): readonly AnswerFact[] {
  const data = responseDataRecord(payload);
  if (data === undefined) return [];
  return symbolsFromArray(data.symbols).flatMap(factsForSymbol);
}

function extractGetSymbol(payload: unknown): readonly AnswerFact[] {
  if (!isRecord(payload)) return [];
  const direct = asSymbolProjection(payload.data);
  const symbols = direct === undefined ? symbolsFromArray(payload.candidates) : [direct];
  return symbols.flatMap(factsForSymbol);
}

function extractDirectCalleeSymbols(payload: unknown): readonly AnswerFact[] {
  const data = responseDataRecord(payload);
  if (data === undefined || !Array.isArray(data.nodes)) return [];
  const symbols = data.nodes.flatMap((node): readonly SymbolProjection[] => {
    if (!isRecord(node) || node.depth !== 1) return [];
    const symbol = asSymbolProjection(node.symbol);
    return symbol === undefined ? [] : [symbol];
  });
  return symbols.flatMap(factsForSymbol);
}

function extractTracePath(payload: unknown): readonly AnswerFact[] {
  const data = responseDataRecord(payload);
  if (data?.found !== true) return [];
  const path = symbolsFromArray(data.path);
  const terminal = path.at(-1);
  if (terminal === undefined) return [];
  return [
    {
      evidenceKind: 'call-path',
      filePath: terminal.filePath,
      kind: 'evidence',
      subject: `terminal:${terminal.simpleName}`,
    },
  ];
}

function handleBinding(
  field: FactBinding['$fact']['field'],
  stepId: string,
  target: 'entry' | 'implementation' = 'entry',
): FactBinding {
  return factBinding(
    field,
    {
      filePath: target === 'entry' ? ENTRY_FILE : IMPLEMENTATION_FILE,
      kind: SYMBOL_HANDLE_KIND,
      name: target === 'entry' ? 'main' : IMPLEMENTATION_SYMBOL,
    },
    stepId,
  );
}

function soleHandleBinding(field: FactBinding['$fact']['field'], stepId: string): FactBinding {
  return factBinding(field, { kind: SYMBOL_HANDLE_KIND }, stepId);
}

function controlReadStep(
  id: string,
  priorStepId: string,
  role: string,
  extract: ResponseExtractor = extractSource,
): StrategyStep {
  return {
    arguments: {
      maxBytes: MAX_SOURCE_BYTES,
      path: factBinding('path', { kind: 'file', role }, priorStepId),
    },
    expectedNonEmpty: true,
    extract,
    id,
    rationale: 'Follow the response-derived source path and normalize its declarations.',
    tool: 'readFile',
  };
}

function controlSteps(): readonly StrategyStep[] {
  return [
    {
      arguments: {
        maxBytes: MAX_SOURCE_BYTES,
        path: ENTRY_FILE,
      },
      expectedNonEmpty: true,
      extract: extractSource,
      id: 'control-read-entry',
      rationale: 'Read the task-disclosed public entry and derive its invoked import target.',
      tool: 'readFile',
    },
    controlReadStep('control-read-hop-1', 'control-read-entry', CALLED_IMPORT_ROLE),
    controlReadStep('control-read-hop-2', 'control-read-hop-1', CALLED_IMPORT_ROLE),
    controlReadStep('control-read-hop-3', 'control-read-hop-2', CALLED_IMPORT_ROLE),
    controlReadStep(
      'control-read-implementation',
      'control-read-hop-3',
      CALLED_IMPORT_ROLE,
      extractTraceTerminalSource,
    ),
  ];
}

function directCalleeStep(id: string, priorStepId: string): StrategyStep {
  return {
    arguments: {
      depth: 1,
      detail: 'nodes',
      generated: 'exclude',
      identity: 'occurrence',
      limit: 20,
      sourceScope: 'production',
      symbolId: soleHandleBinding('symbolId', priorStepId),
    },
    expectedNonEmpty: true,
    extract: extractDirectCalleeSymbols,
    id,
    rationale: 'Follow the sole direct callee identity returned by the preceding graph response.',
    tool: 'callees_of',
  };
}

function opensipSteps(): readonly StrategyStep[] {
  return [
    {
      arguments: {
        detail: 'nodes',
        filePath: ENTRY_FILE,
        generated: 'exclude',
        limit: 20,
        match: 'exact',
        query: ENTRY_SYMBOL,
        sourceScope: 'production',
      },
      expectedNonEmpty: true,
      extract: extractSymbolSearch,
      id: 'opensip-find-entry',
      rationale: 'Resolve the named root entrypoint to a stable graph symbol handle.',
      tool: 'search_symbols',
    },
    {
      arguments: {
        file: handleBinding('filePath', 'opensip-find-entry'),
        line: handleBinding('line', 'opensip-find-entry'),
      },
      expectedNonEmpty: true,
      extract: extractGetSymbol,
      id: 'opensip-resolve-entry',
      rationale: 'Confirm the discovered file/line identity before traversing its calls.',
      tool: 'get_symbol',
    },
    directCalleeStep('opensip-follow-hop-1', 'opensip-resolve-entry'),
    directCalleeStep('opensip-follow-hop-2', 'opensip-follow-hop-1'),
    directCalleeStep('opensip-follow-hop-3', 'opensip-follow-hop-2'),
    directCalleeStep('opensip-follow-hop-4', 'opensip-follow-hop-3'),
    {
      arguments: {
        depth: 5,
        fromSymbolId: handleBinding('symbolId', 'opensip-resolve-entry'),
        generated: 'exclude',
        identity: 'occurrence',
        limit: 100,
        sourceScope: 'production',
        toSymbolId: soleHandleBinding('symbolId', 'opensip-follow-hop-4'),
      },
      expectedNonEmpty: true,
      extract: extractTracePath,
      id: 'opensip-trace-entry-to-implementation',
      rationale: 'Prove the shortest call path between the two response-derived symbol identities.',
      tool: 'trace_path',
    },
  ];
}

export const entrypointTraceCustomerTsTask = deepFreeze({
  assertions: {
    mustInclude: [
      { filePath: ENTRY_FILE, kind: 'symbol', name: 'main' },
      {
        filePath: IMPLEMENTATION_FILE,
        kind: 'symbol',
        name: IMPLEMENTATION_SYMBOL,
      },
      {
        kind: 'evidence',
        subject: `terminal:${IMPLEMENTATION_SYMBOL}`,
      },
    ],
  },
  fixture: 'customer-ts',
  id: 'entrypoint-trace.customer-ts',
  question: `Starting from the public ${FEATURE_SYMBOL} feature reached by ${ENTRY_SYMBOL} in ${ENTRY_FILE}, locate the implementation responsible for calculating the invoice total and prove the call path.`,
  strategies: {
    control: {
      arm: 'control',
      steps: controlSteps(),
      version: CONTROL_STRATEGY_VERSION,
    },
    opensip: {
      arm: 'opensip',
      steps: opensipSteps(),
      version: OPENSIP_STRATEGY_VERSION,
    },
  },
  tags: ['entrypoint', 'call-path', 'barrel-reexport'],
} as const satisfies GoldTask);

export const entrypointTraceTasks = Object.freeze([entrypointTraceCustomerTsTask] as const);
