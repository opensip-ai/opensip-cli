interface Service {
  run: () => void
}

export function makeService(): Service {
  return {} as Service
}
