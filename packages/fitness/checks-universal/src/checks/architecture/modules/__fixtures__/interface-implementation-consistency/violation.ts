interface Greeter {
  greet(name: string): string
}

export class EnglishGreeter implements Greeter {
  greet(name: string): string {
    return `Hello, ${name}`
  }

  shoutGreeting(name: string): string {
    return this.greet(name).toUpperCase()
  }
}
