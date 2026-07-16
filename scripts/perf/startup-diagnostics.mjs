const MAX_DIAGNOSTIC_EVENTS = 256;
const MAX_PHASES_PER_SOURCE = 64;
const MAX_PHASE_NAME_LENGTH = 80;

/** Parse a bounded JSON command document and retain only startup timing data. */
export function extractStartupDiagnostics(stdoutDocument, options = {}) {
  if (options.truncated === true || typeof stdoutDocument !== 'string') return;
  let parsed;
  try {
    parsed = JSON.parse(stdoutDocument);
  } catch {
    return;
  }
  const events = parsed?.diagnostics?.events;
  if (!Array.isArray(events) || events.length > MAX_DIAGNOSTIC_EVENTS) return;

  const bySource = { startup: [], 'pre-action': [] };
  for (const event of events) {
    const data = event?.data;
    const source = data?.source;
    if (source !== 'startup' && source !== 'pre-action') continue;
    if (bySource[source].length >= MAX_PHASES_PER_SOURCE) continue;
    const phase = boundedPhase(data.phase);
    const durationMs = timingValue(data.durationMs);
    const sinceStartMs = timingValue(data.sinceStartMs);
    if (phase === undefined || durationMs === undefined || sinceStartMs === undefined) continue;
    bySource[source].push({
      phase,
      durationMs,
      sinceStartMs,
      ...(typeof data.skipped === 'boolean' ? { skipped: data.skipped } : {}),
    });
  }

  const startup = summarizeSource(bySource.startup);
  const preAction = summarizeSource(bySource['pre-action']);
  if (startup === undefined && preAction === undefined) return;
  return { startup, preAction };
}

function summarizeSource(phases) {
  if (phases.length === 0) return;
  return {
    elapsedMs: Math.max(...phases.map((phase) => phase.sinceStartMs)),
    phases,
  };
}

function boundedPhase(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PHASE_NAME_LENGTH) {
    return;
  }
  return value;
}

function timingValue(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return;
  return value;
}
