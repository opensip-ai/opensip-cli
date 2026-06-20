interface Row {
  payload: string
}

// Nullable return — accessing `.payload` on the result without a guard is unsafe.
// Flagged by the type-aware detector (receiver type includes null) and by the
// convention fallback (unknown call result).
declare function lookup(): Row | null

export function readPayload(): string {
  return lookup().payload
}
