let activeCount = 0

export function enter(): void {
  activeCount++
}

export function leave(): void {
  activeCount--
}
