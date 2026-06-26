import type { FunctionOccurrence } from '../types.js';
import type { GraphLookupMatch, GraphLookupResult } from '@opensip-cli/contracts';

function toLookupMatch(occ: FunctionOccurrence): GraphLookupMatch {
  return {
    bodyHash: occ.bodyHash,
    ...(occ.bodySize === undefined ? {} : { bodySize: occ.bodySize }),
    simpleName: occ.simpleName,
    qualifiedName: occ.qualifiedName,
    filePath: occ.filePath,
    ...(occ.package === undefined ? {} : { package: occ.package }),
    line: occ.line,
    column: occ.column,
    endLine: occ.endLine,
    kind: occ.kind,
    params: occ.params.map((p) => ({
      name: p.name,
      optional: p.optional,
      rest: p.rest,
    })),
    returnType: occ.returnType,
    enclosingClass: occ.enclosingClass,
    decorators: [...occ.decorators],
    visibility: occ.visibility,
    inTestFile: occ.inTestFile,
    definedInGenerated: occ.definedInGenerated,
    ...(occ.calls.length > 0
      ? {
          calls: occ.calls.map((c) => structuredClone(c) as unknown as Record<string, unknown>),
        }
      : {}),
    ...(occ.dependencies !== undefined && occ.dependencies.length > 0
      ? {
          dependencies: occ.dependencies.map(
            (d) => structuredClone(d) as unknown as Record<string, unknown>,
          ),
        }
      : {}),
  };
}

export function buildLookupResult(
  name: string,
  matches: readonly FunctionOccurrence[],
  resolutionMode: 'exact' | 'fast',
): GraphLookupResult {
  return {
    type: 'graph-lookup',
    name,
    resolutionMode,
    matches: matches.map(toLookupMatch),
  };
}
