/**
 * ADR-0058: tool live views must route through @opensip-cli/cli-live — never
 * import ink's `render` or hand-roll live chrome in tool engine packages.
 */
// @fitness-ignore-file shipped-checks-must-be-generic -- opensip-internal dogfood guard for the shared live-run shell; path-gated to first-party tool engines.
import { defineCheck, isTestFile, type CheckViolation } from '@opensip-cli/fitness';

const TOOL_ENGINE_PATH =
  /packages\/(fitness\/engine|graph\/engine|simulation\/engine|yagni\/engine)\/src\//;

const INK_RENDER_IMPORT = /import\s*\{[^}]*\brender\b[^}]*\}\s*from\s*['"]ink['"]/;

const GUIDANCE =
  'Tool live views must route through runToolLiveView (@opensip-cli/cli-live); do not import ink render in tool engines (ADR-0058).';

export function analyzeLiveViewThroughCliLive(content: string, filePath: string): CheckViolation[] {
  const normalized = filePath.replaceAll('\\', '/');
  if (!TOOL_ENGINE_PATH.test(normalized) || isTestFile(filePath)) return [];
  if (!INK_RENDER_IMPORT.test(content)) return [];
  return [
    {
      filePath,
      line: 1,
      message: `Direct ink render import in a tool engine. ${GUIDANCE}`,
      severity: 'error',
      suggestion: 'Use runToolLiveView from @opensip-cli/cli-live instead of ink render.',
    },
  ];
}

export const liveViewThroughCliLive = defineCheck({
  id: 'f8c2a1d0-4e5b-4a9c-8d7e-6f3b2a1c0d94',
  slug: 'live-view-through-cli-live',
  description: 'Tool engine live views route through cli-live (no direct ink render imports)',
  longDescription: `**Purpose:** Prevent tool engines from hand-rolling Ink live views.

**Detects:** A direct \`import { render } from 'ink'\` in fitness/graph/simulation/yagni engine source.

**Why it matters:** ADR-0058 centralizes live-run chrome in cli-ui + cli-live so fit/graph/sim/yagni cannot diverge again.

**Scope:** First-party tool engine packages only; test files exempt.`,
  scope: { languages: ['typescript'], concerns: ['backend'] },
  tags: ['architecture'],
  fileTypes: ['ts', 'tsx'],
  analyze: (content, filePath) => analyzeLiveViewThroughCliLive(content, filePath),
});
