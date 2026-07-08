import { describe, expect, it } from 'vitest';

import { analyzeExternalAdapterProgressPrivateBridge as analyze } from '../checks/external-adapter-progress-private-bridge.js';

const IMPORT =
  "import { EXTERNAL_ADAPTER_PROGRESS, externalAdapterProgressOf } from '@opensip-cli/external-tool-adapter';\n";

describe('external-adapter-progress-private-bridge', () => {
  it('allows the CLI worker shim to import the private bridge', () => {
    expect(
      analyze(IMPORT, '/repo/packages/cli/src/bootstrap/tool-command-worker-context.ts'),
    ).toEqual([]);
  });

  it('allows the external-tool-adapter substrate to own the private bridge', () => {
    expect(analyze(IMPORT, '/repo/packages/external-tool-adapter/src/progress.ts')).toEqual([]);
  });

  it('flags other packages importing the private progress bridge', () => {
    const violations = analyze(IMPORT, '/repo/packages/tool-gitleaks/src/tool.ts');
    expect(violations).toHaveLength(1);
    expect(violations[0]?.type).toBe('external-adapter-progress-private-bridge');
    expect(violations[0]?.severity).toBe('error');
  });

  it('does not flag ordinary external-tool-adapter imports', () => {
    expect(
      analyze(
        "import { defineExternalToolAdapter } from '@opensip-cli/external-tool-adapter';\n",
        '/repo/packages/tool-gitleaks/src/tool.ts',
      ),
    ).toEqual([]);
  });

  it('skips tests', () => {
    expect(analyze(IMPORT, '/repo/packages/tool-gitleaks/src/__tests__/tool.test.ts')).toEqual([]);
  });
});
