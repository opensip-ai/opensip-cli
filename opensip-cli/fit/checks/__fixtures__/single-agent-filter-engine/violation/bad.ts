export function filterErrorsOnly(signals: { severity: string }[]) {
  return signals.filter((s) => 'errors-only' && s.severity === 'high');
}