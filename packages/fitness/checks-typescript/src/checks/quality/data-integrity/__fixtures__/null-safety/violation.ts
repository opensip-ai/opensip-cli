interface Row {
  payload: string
}

declare function lookup(): Row

export function readPayload(): string {
  return lookup().payload
}
