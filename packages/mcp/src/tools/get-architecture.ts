/**
 * `get_architecture` — labelled, bounded codebase orientation overview.
 */

import {
  architectureSections,
  architectureTopN,
  exactFilePath,
  filePrefix,
  packageArray,
  pageFields,
  productionGeneratedPolicy,
  productionSourceScope,
  strictInput,
} from './schemas.js';
import { errorResult, jsonResult } from './tool-result.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

export function registerGetArchitecture(server: McpStdioServer, deps: McpToolDeps): void {
  server.register(
    'get_architecture',
    {
      title: 'Architecture overview',
      description:
        'Labelled orientation view. Default sections=["metrics"] returns occurrence/body counts, ' +
        'call evidence, package counts, and bounded target convention counts when configured. ' +
        'Add "packageEdges" and/or "hotspots" to request ranked families; topN (default 20, max 100) ' +
        'selects the deterministic global window and limit pages inside it. Unselected families are ' +
        'omitted (not empty arrays). Defaults to production/non-generated. Use ' +
        'package_dependencies / package_cycles for exhaustive package evidence.',
      inputSchema: strictInput({
        packages: packageArray(),
        filePath: exactFilePath().optional(),
        filePrefix: filePrefix().optional(),
        sourceScope: productionSourceScope(),
        generated: productionGeneratedPolicy(),
        sections: architectureSections(),
        topN: architectureTopN(),
        ...pageFields(),
      }),
    },
    async (args) => {
      const outcome = await deps.graph.architectureSummary({
        limit: args.limit,
        cursor: args.cursor,
        groupBy: args.groupBy,
        sections: args.sections,
        topN: args.topN,
        filter: {
          packages: args.packages,
          filePath: args.filePath,
          filePrefix: args.filePrefix,
          sourceScope: args.sourceScope,
          generated: args.generated,
        },
      });
      if (!outcome.ok) return errorResult(outcome.error);
      const targetConventions = deps.targetConventions ?? [];
      // targetConventions only when metrics section is included (summary section).
      if (
        targetConventions.length === 0 ||
        !outcome.value.data.includedSections.includes('metrics')
      ) {
        return jsonResult(outcome.value);
      }
      return jsonResult({
        ...outcome.value,
        data: {
          ...outcome.value.data,
          targetConventions,
        },
      });
    },
  );
}
