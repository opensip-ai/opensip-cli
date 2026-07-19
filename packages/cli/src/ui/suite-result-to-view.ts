import { viewSuiteAdd, viewSuiteList, viewSuiteRun } from './views/suite-views.js';

import type { ViewNode } from '@opensip-cli/cli-ui';
import type { CommandResult } from '@opensip-cli/contracts';

type SuiteCommandResult = Extract<
  CommandResult,
  { type: 'suite-run' | 'suite-list' | 'suite-add' }
>;

/** Map the closed suite result family into its dedicated terminal views. */
export function suiteResultToView(result: SuiteCommandResult): ViewNode {
  switch (result.type) {
    case 'suite-run': {
      return viewSuiteRun(result);
    }
    case 'suite-list': {
      return viewSuiteList(result);
    }
    case 'suite-add': {
      return viewSuiteAdd(result);
    }
  }
}
