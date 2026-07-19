import { vi } from 'vitest';

vi.mock('@opensip-cli/contracts', () => ({
  loadCliDefaults: vi.fn(),
}));

export const subject = 1;
