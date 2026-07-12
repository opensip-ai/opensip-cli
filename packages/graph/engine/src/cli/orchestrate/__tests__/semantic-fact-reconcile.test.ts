import { describe, expect, it } from 'vitest';

import { emptySemanticFactBundle } from '../../../semantic-facts.js';
import { reconcileSemanticFacts } from '../semantic-fact-reconcile.js';

import type { PackageManifestIndex } from '../../../cross-package/export-index.js';
import type { CrossFileReferenceFact, DeclarationFact, SemanticFactBundle } from '../../../types.js';

function manifestIndex(
  entries: readonly { name: string; dir: string }[],
): PackageManifestIndex {
  const map = new Map();
  for (const e of entries) {
    map.set(e.name, { name: e.name, dir: e.dir, exportsMap: { '.': './src/index.ts' } });
  }
  return map;
}

function decl(over: Partial<DeclarationFact> & Pick<DeclarationFact, 'declarationId' | 'name' | 'filePath' | 'package'>): DeclarationFact {
  return {
    kind: 'interface',
    qualifiedName: `${over.filePath}.${over.name}`,
    line: 1,
    column: 0,
    endLine: 1,
    endColumn: 5,
    visibility: 'exported',
    exportRole: 'named-export',
    inTestFile: false,
    definedInGenerated: false,
    ...over,
  };
}

function ref(over: Partial<CrossFileReferenceFact> & Pick<CrossFileReferenceFact, 'referenceId' | 'filePath'>): CrossFileReferenceFact {
  return {
    kind: 'type',
    line: 2,
    column: 0,
    endLine: 2,
    endColumn: 3,
    package: 'app',
    basis: 'unresolved',
    confidence: 'low',
    inTestFile: false,
    definedInGenerated: false,
    ...over,
  };
}

describe('reconcileSemanticFacts', () => {
  it('returns undefined for absent bundles', () => {
    expect(reconcileSemanticFacts(undefined, manifestIndex([]))).toBeUndefined();
  });

  it('preserves present-empty', () => {
    const empty = emptySemanticFactBundle();
    const out = reconcileSemanticFacts(empty, manifestIndex([]));
    expect(out?.declarations).toEqual([]);
    expect(out?.references).toEqual([]);
  });

  it('joins unresolved import-specifier refs to a unique exported declaration', () => {
    const target = decl({
      declarationId: 'd-core-foo',
      name: 'Foo',
      filePath: 'packages/core/src/index.ts',
      package: '@scope/core',
      kind: 'interface',
      exportRole: 'named-export',
    });
    const unresolved = ref({
      referenceId: 'r-app',
      filePath: 'packages/app/src/use.ts',
      package: '@scope/app',
      targetName: 'Foo',
      targetKind: 'interface',
      importSpecifier: '@scope/core',
      basis: 'unresolved',
      confidence: 'low',
    });
    const bundle: SemanticFactBundle = {
      referenceScope: 'cross-file',
      declarations: [target],
      references: [unresolved],
      coverage: {
        status: 'complete',
        inspectedDeclarations: 1,
        emittedDeclarations: 1,
        omittedDeclarations: 0,
        inspectedReferences: 1,
        emittedReferences: 1,
        omittedReferences: 0,
        reasons: [],
      },
    };
    const out = reconcileSemanticFacts(
      bundle,
      manifestIndex([
        { name: '@scope/core', dir: 'packages/core' },
        { name: '@scope/app', dir: 'packages/app' },
      ]),
    );
    expect(out).toBeDefined();
    const joined = out!.references.find((r) => r.filePath === unresolved.filePath);
    expect(joined?.targetDeclarationId).toBe(target.declarationId);
    expect(joined?.basis).toBe('workspace-export-index');
    expect(joined?.confidence).toBe('high');
  });

  it('downgrades resolved refs whose target vanished after merge', () => {
    const dangling = ref({
      referenceId: 'r-dangle',
      filePath: 'src/a.ts',
      targetDeclarationId: 'gone',
      targetName: 'Gone',
      targetKind: 'interface',
      basis: 'compiler-declaration',
      confidence: 'high',
    });
    const bundle: SemanticFactBundle = {
      referenceScope: 'cross-file',
      declarations: [],
      references: [dangling],
      coverage: emptySemanticFactBundle().coverage,
    };
    // Fix coverage counts for validator-like consistency in reconcile path.
    bundle.coverage.emittedReferences; // present
    const out = reconcileSemanticFacts(
      {
        ...bundle,
        coverage: {
          ...bundle.coverage,
          emittedDeclarations: 0,
          emittedReferences: 1,
          inspectedReferences: 1,
        },
      },
      manifestIndex([]),
    );
    expect(out!.references[0]?.targetDeclarationId).toBeUndefined();
    expect(out!.references[0]?.reason).toBe('target-missing-after-merge');
  });
});
