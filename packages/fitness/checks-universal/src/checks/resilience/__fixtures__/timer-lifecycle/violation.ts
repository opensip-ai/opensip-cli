export function startHeartbeat(): void {
  setInterval(() => beat(), 1000)
}

declare function beat(): void
