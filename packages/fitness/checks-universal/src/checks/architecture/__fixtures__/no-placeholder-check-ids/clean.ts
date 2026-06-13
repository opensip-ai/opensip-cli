// Sample of a check using a promoted real UUID (simulates a source file under packages/.../checks)
export const someGoodCheck = defineCheck({
  id: 'c9f2e1a3-7b5d-4f8e-9c1a-2d3e4f5a6b7c', // promoted stable ID (ref ADR-0046)
  slug: 'some-good-check',
  description: 'demo',
  scope: { languages: [], concerns: [] },
  tags: [],
  analyze: () => [],
});
