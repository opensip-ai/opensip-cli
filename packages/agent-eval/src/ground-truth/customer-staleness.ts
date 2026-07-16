export const customerStalenessGroundTruth = {
  addCaller: {
    content: `import { quoteTotal } from './quote-total.js';

export function previewQuote(subtotalCents: number): number {
  return quoteTotal(subtotalCents);
}
`,
    filePath: 'src/quote-preview.ts',
    symbol: 'previewQuote',
  },
  deleteTarget: {
    filePath: 'src/quote-total.ts',
    symbolExpectedAbsent: 'quoteTotal',
  },
  fixture: 'customer-staleness',
  preEditCallers: [{ filePath: 'src/quote-controller.ts', symbol: 'quoteOrder' }],
  targetFile: 'src/quote-total.ts',
  targetSymbol: 'quoteTotal',
} as const;
