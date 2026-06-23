async function fetchRemote(): Promise<void> {
  await Promise.resolve()
}

export async function handler(): Promise<void> {
  await fetchRemote()
}