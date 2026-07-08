import { render } from 'ink';

export function badRunner(): void {
  render(null as never);
}