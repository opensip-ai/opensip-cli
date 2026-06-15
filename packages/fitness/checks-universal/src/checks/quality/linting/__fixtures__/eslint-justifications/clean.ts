export function build(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- third-party type is untyped and cannot be narrowed here
  const raw: any = loadPlugin()
  return raw
}

declare function loadPlugin(): unknown
