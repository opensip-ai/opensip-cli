import { line, group, type Tone, type ViewNode } from '@opensip-cli/cli-ui';

import type { ConfigMigrateResult } from '@opensip-cli/contracts';

export function viewConfigValidate(result: {
  readonly configPath: string;
  readonly namespaces: readonly string[];
  readonly warnings?: readonly string[];
}): ViewNode {
  const children: ViewNode[] = [
    line([
      { text: '✓', tone: 'success' },
      { text: ' Configuration valid: ' },
      { text: result.configPath, bold: true },
      {
        text: ` (${String(result.namespaces.length)} namespace${result.namespaces.length === 1 ? '' : 's'})`,
      },
    ]),
  ];
  if (result.warnings !== undefined) {
    for (const warning of result.warnings) {
      children.push(line([{ text: `  ${warning}`, dim: true }]));
    }
  }
  return group(children, 2);
}

export function viewConfigSchema(result: { readonly outPath?: string }): ViewNode {
  if (result.outPath !== undefined) {
    return group(
      [
        line([
          { text: '✓', tone: 'success' },
          { text: ' Wrote JSON Schema to ' },
          { text: result.outPath, bold: true },
        ]),
      ],
      2,
    );
  }
  return group(
    [
      line([
        {
          text: 'Use --json to print the schema or --out <path> to write it to a file.',
          dim: true,
        },
      ]),
    ],
    2,
  );
}

export function viewConfigMigrate(result: ConfigMigrateResult): ViewNode {
  if (!result.changed) {
    return group(
      [
        line([
          { text: '✓', tone: 'success' },
          { text: ' Configuration already current: ' },
          { text: result.configPath, bold: true },
        ]),
      ],
      2,
    );
  }

  let action = 'Migrated configuration';
  if (result.check) {
    action = 'Configuration migration required';
  } else if (result.dryRun) {
    action = 'Configuration migration available';
  }
  const tone: Tone = result.wrote ? 'success' : 'warning';
  const children: ViewNode[] = [
    line([
      { text: result.wrote ? '✓' : '!', tone },
      { text: ` ${action}: ` },
      { text: result.configPath, bold: true },
      {
        text: ` (${String(result.fromVersion)} -> ${String(result.targetVersion)})`,
        dim: true,
      },
    ]),
  ];
  for (const operation of result.operations) {
    children.push(line([{ text: `  ${operation.message}`, dim: true }]));
  }
  return group(children, 2);
}
