import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { walkProgram } from '../walk.js';

import type { FunctionOccurrence } from '@opensip-cli/graph';

function occurrencesOf(source: string): FunctionOccurrence[] {
  const fileName = '/project/source.ts';
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const walked = walkProgram({
    sourceFiles: [sourceFile],
    files: [fileName],
    projectDirAbs: '/project',
  });
  return Object.values(walked.functions).flat();
}

describe('callable visibility', () => {
  it('marks a local function exported through an export list as exported', () => {
    const occurrences = occurrencesOf(`function helper() { return 1; }\nexport { helper };\n`);

    expect(occurrences.find((occurrence) => occurrence.simpleName === 'helper')?.visibility).toBe(
      'exported',
    );
  });

  it('marks a local function exported with TypeScript `export =` as exported', () => {
    const occurrences = occurrencesOf(`function helper() { return 1; }\nexport = helper;\n`);

    expect(occurrences.find((occurrence) => occurrence.simpleName === 'helper')?.visibility).toBe(
      'exported',
    );
  });

  it('marks ECMAScript private methods and private callable fields as private', () => {
    const occurrences = occurrencesOf(
      `class Service {\n` + `  #method() { return 1; }\n` + `  #handler = () => 2;\n` + `}\n`,
    );

    expect(occurrences.find((occurrence) => occurrence.simpleName === '#method')?.visibility).toBe(
      'private',
    );
    expect(occurrences.find((occurrence) => occurrence.simpleName === '#handler')?.visibility).toBe(
      'private',
    );
  });

  it('marks a directly default-exported anonymous arrow as exported', () => {
    const occurrences = occurrencesOf(`export default () => 1;\n`);
    const arrow = occurrences.find((occurrence) => occurrence.kind === 'arrow');

    expect(arrow?.visibility).toBe('exported');
  });

  it('does not inherit an outer exported variable across a callable boundary', () => {
    const occurrences = occurrencesOf(
      `export const outer = () => {\n` + `  return function inner() { return 1; };\n` + `};\n`,
    );
    const inner = occurrences.find((occurrence) => occurrence.simpleName === 'inner');

    expect(inner?.visibility).toBe('module-local');
  });
});
