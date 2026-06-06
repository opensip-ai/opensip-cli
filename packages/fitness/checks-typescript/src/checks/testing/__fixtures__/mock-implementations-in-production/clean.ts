export class UserService {
  constructor(private readonly source: { getUser: () => string }) {}

  getUser(): string {
    return this.source.getUser()
  }
}
