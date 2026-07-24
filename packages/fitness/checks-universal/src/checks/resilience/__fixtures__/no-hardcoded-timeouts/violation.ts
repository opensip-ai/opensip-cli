export const httpConfig = {
  timeout: 30000,
}

export function scheduleRetry(): void {
  setTimeout(() => {
    retry()
  }, 10000)
}

declare function retry(): void
