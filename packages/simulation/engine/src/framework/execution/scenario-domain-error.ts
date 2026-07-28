/**
 * Domain failures that public scenario authoring seams raise as values (C5 D6).
 *
 * These are NOT catalogued ToolError codes: scenario drivers and fault models
 * catch them by identity / message as part of the scenario contract. They still
 * must not be bare `Error` — that would redact to "The operation failed." if they
 * ever escaped, and the bare-throw ratchet would treat the package as unfinished.
 */

/** A deliberate fault-model injection (`fault:abort` / `fault:drop`). */
export class ScenarioFaultError extends Error {
  override readonly name = 'ScenarioFaultError';

  constructor(message: 'fault:abort' | 'fault:drop') {
    super(message);
  }
}

/** An HTTP target observed a non-OK status (scenario-visible domain failure). */
export class ScenarioHttpTargetError extends Error {
  override readonly name = 'ScenarioHttpTargetError';
  readonly status: number;
  readonly url: string;

  constructor(url: string, status: number) {
    super(`httpTarget: ${url} returned ${String(status)}`);
    this.url = url;
    this.status = status;
  }
}
