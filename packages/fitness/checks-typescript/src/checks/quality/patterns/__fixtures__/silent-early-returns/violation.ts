export function run(input: { ready: boolean; value: string }) {
  const a = 1
  const b = 2
  const c = a + b
  const total = c + input.value.length
  if (!input.ready) return null
  return total
}
