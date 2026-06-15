interface Service {
  run: () => void
}

export function makeService(): Service {
  return {
    run: () => {
      // performs the real work
    },
  }
}
