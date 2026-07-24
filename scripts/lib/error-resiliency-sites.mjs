/**
 * @fileoverview Deterministic structural error/resiliency site extractor.
 *
 * Uses the repository TypeScript compiler API (not regex) for TS/JS sources.
 * Declares detector/language coverage explicitly — never claims semantic
 * completeness for unsupported languages or human-only flow sites.
 */

import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import ts from 'typescript';

import {
  BOUNDS,
  DETECTOR_VERSION,
  InventoryError,
  assertSafeRepoRelativePath,
  defaultDetectorCoverage,
} from './error-resiliency-inventory.mjs';

const STRUCTURAL_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);

/**
 * @param {string} relativePath
 * @returns {boolean}
 */
export function isStructurallySupportedPath(relativePath) {
  return STRUCTURAL_EXTENSIONS.has(extname(relativePath).toLowerCase());
}

/**
 * @param {string} relativePath
 * @param {string} sourceText
 * @returns {{ sites: ReturnType<typeof buildSite>[], coverage: ReturnType<typeof defaultDetectorCoverage>, truncated: boolean }}
 */
export function extractStructuralSites(relativePath, sourceText) {
  const pathValue = assertSafeRepoRelativePath(relativePath);
  if (!isStructurallySupportedPath(pathValue)) {
    return { sites: [], coverage: defaultDetectorCoverage(), truncated: false };
  }
  if (typeof sourceText !== 'string') {
    throw new InventoryError('INVENTORY.SITE.SOURCE', 'sourceText must be a string');
  }
  if (Buffer.byteLength(sourceText, 'utf8') > BOUNDS.maxSourceFileBytes) {
    throw new InventoryError(
      'INVENTORY.SITE.SOURCE_TOO_LARGE',
      `${pathValue} exceeds maxSourceFileBytes`,
    );
  }

  const scriptKind = scriptKindForPath(pathValue);
  const sourceFile = ts.createSourceFile(
    pathValue,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );

  /** @type {ReturnType<typeof buildSite>[]} */
  const sites = [];
  let truncated = false;

  /**
   * @param {ts.Node} node
   */
  function visit(node) {
    if (sites.length >= BOUNDS.maxSitesPerFile) {
      truncated = true;
      return;
    }

    if (ts.isThrowStatement(node)) {
      pushSite(sites, pathValue, sourceFile, node, 'throw', structuralSnippet(node, sourceFile));
    } else if (ts.isCatchClause(node)) {
      pushSite(sites, pathValue, sourceFile, node, 'catch', 'catch');
    } else if (ts.isCallExpression(node)) {
      const name = callName(node.expression);
      if (name && isRetryCall(name)) {
        pushSite(sites, pathValue, sourceFile, node, 'retry', name);
      } else if (name && isTimerCall(name)) {
        pushSite(sites, pathValue, sourceFile, node, 'timer', name);
      } else if (name && isSignalCall(name)) {
        pushSite(sites, pathValue, sourceFile, node, 'signal-listener', name);
      } else if (name && isErrorConstruction(name)) {
        pushSite(sites, pathValue, sourceFile, node, 'error-construction', name);
      } else if (name && isWorkerBoundaryCall(name)) {
        pushSite(sites, pathValue, sourceFile, node, 'worker-boundary', name);
      }
    } else if (ts.isNewExpression(node)) {
      const name = callName(node.expression);
      if (name && isErrorConstruction(name)) {
        pushSite(sites, pathValue, sourceFile, node, 'error-construction', `new ${name}`);
      }
    } else // Common fallback: expr || default
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
      (ts.isPropertyAccessExpression(node.left) || ts.isIdentifier(node.left))
    ) {
      pushSite(sites, pathValue, sourceFile, node, 'fallback', '||');
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return {
    sites: sites.slice(0, BOUNDS.maxSitesPerFile),
    coverage: defaultDetectorCoverage(),
    truncated,
  };
}

/**
 * Stable site id: path + detector + kind + structural fingerprint (not line).
 * @param {string} relativePath
 * @param {string} kind
 * @param {string} fingerprint
 */
export function makeStructuralSiteId(relativePath, kind, fingerprint) {
  const material = `${relativePath}\0${DETECTOR_VERSION}\0${kind}\0${fingerprint}`;
  const hash = createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 24);
  return `s1:${hash}`;
}

/**
 * @param {string} relativePath
 * @param {string} kind
 * @param {string} normalizedStructure
 */
export function fingerprintStructure(relativePath, kind, normalizedStructure) {
  const material = `${kind}\0${normalizedStructure}`;
  return createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 32);
}

/**
 * @param {ReturnType<typeof buildSite>[]} sites
 * @param {string} pathValue
 * @param {ts.SourceFile} sourceFile
 * @param {ts.Node} node
 * @param {string} kind
 * @param {string} structure
 */
function pushSite(sites, pathValue, sourceFile, node, kind, structure) {
  if (sites.length >= BOUNDS.maxSitesPerFile) return;
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const fingerprint = fingerprintStructure(pathValue, kind, structure);
  // Disambiguate same structure at different ordinals within a file without using line in the id.
  const ordinal = sites.filter((s) => s.kind === kind && s.fingerprint === fingerprint).length;
  const ordinalFingerprint =
    ordinal === 0 ? fingerprint : fingerprintStructure(pathValue, kind, `${structure}#${ordinal}`);
  sites.push(
    buildSite({
      pathValue,
      kind,
      fingerprint: ordinalFingerprint,
      line: line + 1,
      column: character,
      structure,
    }),
  );
}

/**
 * @param {{ pathValue: string, kind: string, fingerprint: string, line: number, column: number, structure: string }} args
 */
function buildSite(args) {
  return {
    siteId: makeStructuralSiteId(args.pathValue, args.kind, args.fingerprint),
    kind: args.kind,
    source: /** @type {const} */ ('structural'),
    fingerprint: args.fingerprint,
    line: args.line,
    column: args.column,
    // disposition is reviewer-owned; structural extract only proposes candidates
    disposition: /** @type {const} */ ('needs-decision'),
    rationale: `structural:${args.structure}`,
  };
}

/**
 * @param {string} pathValue
 */
function scriptKindForPath(pathValue) {
  const ext = extname(pathValue).toLowerCase();
  switch (ext) {
    case '.tsx': {
      return ts.ScriptKind.TSX;
    }
    case '.jsx': {
      return ts.ScriptKind.JSX;
    }
    case '.js':
    case '.mjs':
    case '.cjs': {
      return ts.ScriptKind.JS;
    }
    case '.cts': {
      return ts.ScriptKind.TS;
    }
    default: {
      return ts.ScriptKind.TS;
    }
  }
}

/**
 * @param {ts.Expression} expression
 * @returns {string | undefined}
 */
function callName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const right = expression.name.text;
    if (ts.isIdentifier(expression.expression)) {
      return `${expression.expression.text}.${right}`;
    }
    return right;
  }
  return '';
}

/**
 * @param {string} name
 */
function isRetryCall(name) {
  return /^(withRetry|retry|retryAsync|runWithRetry)$/u.test(name) || /\.retry$/u.test(name);
}

/**
 * @param {string} name
 */
function isTimerCall(name) {
  return /^(setTimeout|setInterval|setImmediate)$/u.test(name);
}

/**
 * @param {string} name
 */
function isSignalCall(name) {
  return (
    /^(abort|AbortController|AbortSignal)$/u.test(name) ||
    /\.(abort|addEventListener|throwIfAborted)$/u.test(name) ||
    name === 'process.on' ||
    name === 'process.once'
  );
}

/**
 * @param {string} name
 */
function isErrorConstruction(name) {
  return (
    name.endsWith('Error') ||
    /^(ToolError|ValidationError|SystemError|NotFoundError|NetworkError|TimeoutError|ConfigurationError|PluginIncompatibleError|BootstrapError)$/u.test(
      name,
    )
  );
}

/**
 * @param {string} name
 */
function isWorkerBoundaryCall(name) {
  return (
    /^(postMessage|worker_threads|fork|spawn|execFile)$/u.test(name) ||
    name.includes('toWorkerError') ||
    name.includes('getWorkerErrorFailureClass')
  );
}

/**
 * @param {ts.Node} node
 * @param {ts.SourceFile} sourceFile
 */
function structuralSnippet(node, sourceFile) {
  const text = node.getText(sourceFile).replace(/\s+/gu, ' ').trim();
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

/**
 * Coverage manifest for CI ratchet honesty.
 */
export function getDetectorCoverageManifest() {
  return defaultDetectorCoverage();
}

export { DETECTOR_VERSION } from './error-resiliency-inventory.mjs';
