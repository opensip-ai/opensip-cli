async function persist(): Promise<void> {
  await Promise.resolve()
}

export async function handler(): Promise<void> {
  persist()
}
