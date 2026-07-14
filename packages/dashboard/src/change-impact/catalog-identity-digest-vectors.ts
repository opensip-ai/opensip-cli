/**
 * Frozen SHA-256(utf8) vectors for catalog identity digests.
 *
 * Graph impact and the Change Impact report both digest raw filesFingerprint
 * and cacheKey values with the same algorithm. Keep these vectors identical to
 * `packages/graph/engine/src/__tests__/catalog-identity-digest-vectors.ts` so
 * package-local implementations cannot drift silently.
 */
export const CATALOG_IDENTITY_DIGEST_VECTORS = [
  {
    input: '1\nsrc/a.ts|1|1',
    digest: 'fc2fdf9367f2f317d5724dc1b784f319205afe1539cca44744aed6e1f8b81789',
  },
  {
    input: 'catalog-key',
    digest: '7891d0288d76e1d056182084697860a3019f60e16d256f3f4eef878805c7a188',
  },
  {
    input: 'files',
    digest: '3d7db37d08f9140fd09f12b9621cd0954b6d56a9d2f357fb2c7f5d62636d2fd1',
  },
  {
    input: 'cache-key',
    digest: '89dd5bff4fb6fd83ee0679edfb07756d0d22222a414f0c3ac6fd92c120e4fe4f',
  },
  {
    input: 'opensip-catalog-identity-digest-v1',
    digest: '82945247f4e0081eed3e0b0303b302e01c51092d81cf14860f0a033a86b172fe',
  },
] as const;
