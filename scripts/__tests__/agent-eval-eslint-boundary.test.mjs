import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { ESLint } from 'eslint';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const eslint = new ESLint({
  cwd: REPO_ROOT,
  overrideConfigFile: join(REPO_ROOT, '.config/eslint.config.mjs'),
});

const FORWARD_PROBE = [
  "import '@opensip-cli/core';",
  "import '@opensip-cli/core/deep';",
  "import 'opensip-cli/deep';",
  "import '../../../core/src/index.js';",
  "void import('@opensip-cli/core');",
  "void import('@opensip-cli/core/deep');",
  "void import('opensip-cli/deep');",
  "void import('../../../core/src/index.js');",
].join('\n');

const REVERSE_PROBE = [
  "import '@opensip-cli/agent-eval';",
  "import '@opensip-cli/agent-eval/deep';",
  "import '../../../../agent-eval/src/index.js';",
  "void import('@opensip-cli/agent-eval');",
  "void import('@opensip-cli/agent-eval/deep');",
  "void import('../../../../agent-eval/src/index.js');",
].join('\n');

const OVERLAPPING_REVERSE_PROBE = REVERSE_PROBE.replaceAll('../../../../', '../../../');

function boundaryMessages(result) {
  return result.messages.filter(
    ({ ruleId, message }) =>
      (ruleId === 'no-restricted-imports' ||
        ruleId === 'no-restricted-syntax' ||
        ruleId === 'import-x/no-relative-packages') &&
      (message.includes('agent-eval') || message.includes('another package')),
  );
}

async function lintProbe(relativeFile, source) {
  const [result] = await eslint.lintText(source, {
    filePath: join(REPO_ROOT, relativeFile),
  });
  assert.ok(result);
  return boundaryMessages(result);
}

test('agent-eval test sources reject static and dynamic workspace imports', async () => {
  const messages = await lintProbe('packages/agent-eval/src/model/task.test.ts', FORWARD_PROBE);

  assert.deepEqual(
    messages.map(({ line }) => line),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
});

test('ordinary package tests reject static and dynamic agent-eval imports', async () => {
  const messages = await lintProbe(
    'packages/core/src/tools/__tests__/manifest-assert.test.ts',
    REVERSE_PROBE,
  );

  assert.deepEqual(
    messages.map(({ line }) => line),
    [1, 2, 3, 4, 5, 6],
  );
});

test('overlapping tool test configs retain their own import guard and the agent-eval guard', async () => {
  for (const relativeFile of [
    'packages/tool-gitleaks/src/__tests__/tool.test.ts',
    'packages/external-tool-adapter/src/__tests__/define-external-tool-adapter.test.ts',
  ]) {
    const config = await eslint.calculateConfigForFile(join(REPO_ROOT, relativeFile));
    assert.match(
      JSON.stringify(config?.rules?.['no-restricted-imports']),
      /configureLogger/u,
      `${relativeFile} must retain the existing host-seam import restriction`,
    );

    const messages = await lintProbe(relativeFile, OVERLAPPING_REVERSE_PROBE);
    assert.deepEqual(
      messages.map(({ line }) => line),
      [1, 2, 3, 4, 5, 6],
      `${relativeFile} must reject every static and dynamic agent-eval probe`,
    );
  }
});
