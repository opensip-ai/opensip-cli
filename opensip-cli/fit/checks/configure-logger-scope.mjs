/**
 * @fileoverview configure-logger-scope — production per-run paths must not
 * call configureLogger (ADR-0053). Per-run logging uses createRunLogger on
 * RunScope.logger; configureLogger is pre-scope compatibility only.
 */
import { defineCheck } from '@opensip-cli/fitness';

const ENFORCED = /packages\/cli\/src\/(bootstrap\/(?!pre-action-hook)|commands\/|cli-context)/;

const EXEMPT = /packages\/cli\/src\/bootstrap\/pre-action-hook\.ts$/;

const CALL = /\bconfigureLogger\s*\(/;

export const configureLoggerScope = defineCheck({
  id: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
  slug: 'configure-logger-scope',
  description: 'Per-run bootstrap must use createRunLogger, not configureLogger (ADR-0053)',
  scope: { languages: ['typescript'], concerns: ['architecture'] },
  tags: ['architecture'],
  analyze: (content, filePath) => {
    if (EXEMPT.test(filePath)) return [];
    if (!ENFORCED.test(filePath)) return [];
    if (!CALL.test(content)) return [];
    return [
      {
        message: 'configureLogger is process-wide; use createRunLogger for per-run scope logging',
        severity: 'error',
        suggestion:
          'Stamp a createRunLogger(...) instance on RunScope.logger in the post-bailout bootstrap executor.',
      },
    ];
  },
});
