export function notify(message: string): void {
  showToast(message)
}

declare function showToast(message: string): void
