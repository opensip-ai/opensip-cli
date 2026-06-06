export function build(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw: any = loadPlugin()
  return raw
}

declare function loadPlugin(): unknown
