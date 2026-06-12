import { describe, it, expect } from 'vitest';

import { analyzeNoConfigLoaderOutsideConfig } from '../no-config-loader-outside-config.js';

const CLI_PATH = 'packages/cli/src/bootstrap/some-loader.ts';
const FIT_PATH = 'packages/fitness/engine/src/targets/loader.ts';
const CONFIG_PATH = 'packages/config/src/document/cli-config.ts';

describe('no-config-loader-outside-config', () => {
  it('flags a hand-rolled projection of a document-level block outside config', () => {
    const content = `
      const doc = readYamlFile(p);
      const t = doc.targets;
      const names = Object.keys(t.backend);
      const x = t.frontend;
    `;
    const v = analyzeNoConfigLoaderOutsideConfig(content, CLI_PATH);
    expect(v).toHaveLength(1);
    expect(v[0]?.type).toBe('no-config-loader-outside-config');
    expect(v[0]?.message).toContain("'targets:'");
  });

  it('does NOT flag a schema-routed read (binding handed to .safeParse)', () => {
    const content = `
      const doc = readYamlFileOrThrow(p);
      const cli = doc.cli;
      const result = CliSchema.safeParse(cli);
    `;
    expect(analyzeNoConfigLoaderOutsideConfig(content, CLI_PATH)).toHaveLength(0);
  });

  it('does NOT flag a read off the PARSE RESULT (the allowed fitness loader pattern)', () => {
    // reads `result.data.targets`, never `parsed.targets` directly.
    const content = `
      const parsed = readYamlFileOrThrow(p);
      const result = TargetsFileSchema.safeParse(parsed);
      const targets = result.data.targets;
      const ge = result.data.globalExcludes;
    `;
    expect(analyzeNoConfigLoaderOutsideConfig(content, FIT_PATH)).toHaveLength(0);
  });

  it('exempts the @opensip-cli/config package itself', () => {
    const content = `
      const doc = readYamlFile(p);
      const cli = doc.cli;
      const v = cli.verbose;
    `;
    expect(analyzeNoConfigLoaderOutsideConfig(content, CONFIG_PATH)).toHaveLength(0);
  });

  it('ignores a tool reading its OWN namespace block (that is one-config-document’s job)', () => {
    const content = `
      const doc = readYamlFile(p);
      const g = doc.graph;
      const knob = g.minDuplicateBodyLines;
    `;
    expect(
      analyzeNoConfigLoaderOutsideConfig(content, 'packages/graph/engine/src/cli/graph-config.ts'),
    ).toHaveLength(0);
  });

  it('ignores a non-yaml-doc member access named like a block key', () => {
    const content = `
      const scope = getScope();
      const t = scope.targets;
      const x = t.foo;
    `;
    expect(analyzeNoConfigLoaderOutsideConfig(content, CLI_PATH)).toHaveLength(0);
  });
});
