/**
 * Suite authoring, run history, report composition and stored run evidence.
 *
 * One of the host catalog's definition modules. They are separate files because the catalog
 * outgrew the file-length bound as a single unit, not because the groups are independent —
 * `host-error-catalog.ts` assembles them into one catalog with one owner and one head.
 */

import { HOST_WIRING, USER_INPUT } from './axes.js';

export const suiteAndRunsDefinitions = {
  /**
   * A suite step is not usable: a bad option value, a missing required option, an
   * unsupported selector or evidence mode, a reserved `cwd`, or an argument the command
   * does not accept.
   *
   * `metadata.condition` carries which of those it was — the detail an agent branches on
   * without needing 12 separate codes to enumerate.
   */
  'CLI.SUITE.INVALID': {
    ...USER_INPUT,
    code: 'CLI.SUITE.INVALID',
    operatorAction:
      'Correct the named suite step in opensip-cli.config.yml; the message names the offending field and value.',
    publicMetadataKeys: ['condition', 'field', 'value'],
  },

  /**
   * A suite step names a tool, command or capability that does not exist — or names one
   * ambiguously.
   *
   * Separated from `INVALID` because the KIND differs and that changes the advice: the fix
   * is to look up what is actually available (`opensip tools list`), not to correct a value.
   */
  'CLI.SUITE.UNKNOWN_REFERENCE': {
    ...USER_INPUT,
    code: 'CLI.SUITE.UNKNOWN_REFERENCE',
    kind: 'not-found',
    operatorAction:
      'The suite step names something that does not exist or is ambiguous. Run `opensip tools list` and use an exact tool and command name.',
    publicMetadataKeys: ['condition', 'value'],
  },

  /**
   * `suite add` refuses to edit `opensip-cli.config.yml` because the file is not in a shape
   * it can safely modify — not a YAML map, malformed, over the editable size bound, or with
   * a `suites` block it cannot merge into without losing content.
   *
   * `integrity` kind: refusing is protecting the user's file. Editing a document we cannot
   * fully parse would silently drop the parts we did not understand.
   */
  'CLI.SUITE.EDIT_REFUSED': {
    ...USER_INPUT,
    code: 'CLI.SUITE.EDIT_REFUSED',
    kind: 'integrity',
    operatorAction:
      'opensip cannot safely edit this config file. Fix the reported problem in opensip-cli.config.yml, or add the suite block by hand.',
    publicMetadataKeys: ['condition', 'path'],
  },

  /**
   * A run-history read argument is unusable: a bad run id, or a limit/offset that is not a
   * non-negative integer.
   *
   * `tool-author` and `runtime`, not `user` and `configuration`: these arrive from a
   * programmatic caller (MCP, an agent) rather than being typed into a config file, so the
   * fix is in the caller's request.
   */
  'CLI.RUN_READ.INPUT_INVALID': {
    ...HOST_WIRING,
    code: 'CLI.RUN_READ.INPUT_INVALID',
    kind: 'validation',
    exposure: 'public',
    operatorAction:
      'Correct the named run-read argument: run ids are 1-128 word characters, and limits and offsets are non-negative integers.',
    publicMetadataKeys: ['field', 'condition'],
  },

  /**
   * A `report` run selector names something the store does not have: an unknown run, or a run
   * with no change-impact data to render.
   *
   * `user` / `not-found`: the user typed or pasted a run id, and the fix is to pick one that
   * exists. The retired `CONFIGURATION.REPORT.*` literals resolved to nothing, so what is
   * plainly a "no such run" answer arrived as an internal fatal.
   */
  'CLI.REPORT.RUN_UNAVAILABLE': {
    ...USER_INPUT,
    code: 'CLI.REPORT.RUN_UNAVAILABLE',
    kind: 'not-found',
    operatorAction:
      'Pick a run that exists — `opensip runs list` shows them — and one that recorded the data this report needs.',
    publicMetadataKeys: ['condition', 'runId'],
  },

  /** A run-history read names a run the store does not have. */
  'CLI.RUNS.NOT_FOUND': {
    ...USER_INPUT,
    code: 'CLI.RUNS.NOT_FOUND',
    kind: 'not-found',
    operatorAction: 'Pick a run id that exists; `opensip runs list` shows the recorded runs.',
    publicMetadataKeys: ['runId'],
  },

  /**
   * An evidence snapshot a tool contributed is not a usable shape.
   *
   * `tool-author` and `runtime`: the snapshot comes from a tool's `collectReportData`, not
   * from anything the user wrote.
   */
  'CLI.RUN_EVIDENCE.INVALID': {
    ...HOST_WIRING,
    code: 'CLI.RUN_EVIDENCE.INVALID',
    kind: 'validation',
    exposure: 'public',
    operatorAction:
      'The tool contributed an evidence snapshot the host cannot store. Report it to the tool author with the run id.',
    publicMetadataKeys: ['field'],
  },

  /**
   * A suite step returned output outside the evidence/verdict capability it declared.
   *
   * Host-detected, and it fails the step — so it belongs in the same `errorCode` field that
   * otherwise carries registered codes lifted from tool failures. It was written
   * `RUN.CAPABILITY.MISMATCH`, a head no catalog declared, which made a host-detected
   * contract breach report as an unknown internal failure.
   */
  'CLI.SUITE.CAPABILITY_MISMATCH': {
    ...HOST_WIRING,
    code: 'CLI.SUITE.CAPABILITY_MISMATCH',
    kind: 'invariant',
    exposure: 'public',
    operatorAction:
      'The step produced output its declared capability does not allow. Report it to the tool author; the suite definition cannot fix it.',
    publicMetadataKeys: ['condition'],
  },

  /**
   * A step that must produce evidence or a verdict completed with neither.
   *
   * Distinct from `CAPABILITY_MISMATCH`: there the step produced the wrong KIND of output,
   * here it produced none at all, and a suite that reported a pass on it would be a false
   * green — the exact failure this plan exists to remove.
   */
  'CLI.SUITE.EVIDENCE_MISSING': {
    ...HOST_WIRING,
    code: 'CLI.SUITE.EVIDENCE_MISSING',
    kind: 'invariant',
    exposure: 'public',
    operatorAction:
      'The step completed without the evidence or verdict it is required to produce. Re-run with --verbose; if it repeats, report it to the tool author.',
    publicMetadataKeys: ['condition'],
  },
} as const;
