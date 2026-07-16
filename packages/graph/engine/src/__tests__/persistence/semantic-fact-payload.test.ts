import { describe, expect, it } from 'vitest';

import { validateSemanticFactBundle } from '../../persistence/semantic-fact-payload.js';
import { emptySemanticFactBundle } from '../../semantic-facts.js';

import type { SemanticFactBundle } from '../../types.js';

function validBundle(over: Partial<SemanticFactBundle> = {}): SemanticFactBundle {
  const base = emptySemanticFactBundle();
  return {
    ...base,
    ...over,
    coverage: {
      ...base.coverage,
      ...over.coverage,
      emittedDeclarations: over.declarations?.length ?? base.declarations.length,
      emittedReferences: over.references?.length ?? base.references.length,
      reasons: over.coverage?.reasons ?? base.coverage.reasons,
    },
  };
}

describe('validateSemanticFactBundle', () => {
  it('accepts present-empty complete bundle', () => {
    expect(() => validateSemanticFactBundle(validBundle())).not.toThrow();
  });

  it('rejects wrong referenceScope', () => {
    expect(() =>
      validateSemanticFactBundle({
        ...validBundle(),
        referenceScope: 'all' as 'cross-file',
      }),
    ).toThrow(/referenceScope/);
  });

  it('rejects dangling targetDeclarationId', () => {
    expect(() =>
      validateSemanticFactBundle(
        validBundle({
          declarations: [],
          references: [
            {
              referenceId: 'r1|x',
              kind: 'type',
              filePath: 'src/a.ts',
              line: 1,
              column: 0,
              endLine: 1,
              endColumn: 1,
              package: 'pkg',
              targetDeclarationId: 'missing',
              basis: 'compiler-declaration',
              confidence: 'high',
              inTestFile: false,
              definedInGenerated: false,
            },
          ],
        }),
      ),
    ).toThrow(/dangling/);
  });

  it('rejects unsorted reasons', () => {
    expect(() =>
      validateSemanticFactBundle(
        validBundle({
          coverage: {
            ...emptySemanticFactBundle().coverage,
            status: 'partial',
            reasons: ['z-reason', 'a-reason'],
          },
        }),
      ),
    ).toThrow();
  });

  it('rejects unknown keys', () => {
    expect(() =>
      validateSemanticFactBundle({
        ...validBundle(),
        extra: true,
      }),
    ).toThrow(/Malformed/);
  });
});
