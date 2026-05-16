// Fixture for the polymorphic resolver: an interface with two implementations.

export interface Notifier {
  notify(message: string): void;
}

export class EmailNotifier implements Notifier {
  notify(message: string): void {
    console.log(`email: ${message}`);
  }
}

export class SlackNotifier implements Notifier {
  notify(message: string): void {
    console.log(`slack: ${message}`);
  }
}

export function dispatchAlert(notifier: Notifier, message: string): void {
  notifier.notify(message);
}
