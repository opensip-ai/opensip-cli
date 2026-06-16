/**
 * @fileoverview raw-stream-output-guarded — primary tool command specs that
 * declare `output: 'raw-stream'` must document the exception in-file.
 *
 * `raw-stream` is a sanctioned escape hatch (handler owns full IO). Fitness,
 * graph, and simulation all use it for multi-mode primary commands. This
 * check prevents silent spread: any production command-spec file with
 * `raw-stream` must carry an explanatory block comment or `@fitness-ignore`.
 */
import { defineCheck } from '@opensip-cli/fitness';

const TOOL_COMMAND_SPEC =
  /packages\/(fitness|graph|simulation)\/engine\/src\/cli\/.*command-spec.*\.ts$/;

const RAW_STREAM = /output:\s*['"]raw-stream['"]/;

const DOCUMENTED =
  /raw-stream|RAW_STREAM|handler owns|owns its (entire )?output|documented.*exception/i;

export const rawStreamOutputGuarded = defineCheck({
  id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  slug: 'raw-stream-output-guarded',
  description:
    'Primary tool command specs using raw-stream must document the exception in the same file',
  scope: { languages: ['typescript'], concerns: ['architecture'] },
  tags: ['architecture'],
  analyze: (content, filePath) => {
    if (!TOOL_COMMAND_SPEC.test(filePath)) return [];
    if (!RAW_STREAM.test(content)) return [];
    if (DOCUMENTED.test(content)) return [];
    return [
      {
        message:
          'Command spec declares output: raw-stream without an in-file justification comment',
        severity: 'error',
        suggestion:
          'Add a block comment explaining why the handler owns IO (multi-mode dispatch), or use signal-envelope dispatch via the host.',
      },
    ];
  },
});
