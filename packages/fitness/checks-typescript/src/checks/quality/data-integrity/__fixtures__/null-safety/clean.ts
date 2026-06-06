interface Row {
  payload: string
}

declare function lookup(): Row | undefined

export function readPayload(): string {
  return lookup()?.payload ?? ''
}
