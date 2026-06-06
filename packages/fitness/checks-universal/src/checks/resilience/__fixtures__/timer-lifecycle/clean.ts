export function startHeartbeat(): () => void {
  const timer = setInterval(() => beat(), 1000)
  return () => clearInterval(timer)
}

declare function beat(): void
