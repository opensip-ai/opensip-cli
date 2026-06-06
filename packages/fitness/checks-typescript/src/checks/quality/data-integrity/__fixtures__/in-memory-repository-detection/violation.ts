export class UserRepository {
  private records = new Map<string, string>()

  save(id: string, name: string): void {
    this.records.set(id, name)
  }
}

// implementation: UserRepository