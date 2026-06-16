/**
 * Shard worker-boundary contract: a ShardBuildResult must be JSON-safe —
 * it round-trips losslessly through JSON.parse(JSON.stringify(...)). This
 * is what makes it transportable across a worker process boundary (no
 * ts.Node / ts.Program may ever appear in it).
 */

import { describe, expect, it } from "vitest";

import type { Shard, ShardBuildResult } from "../shard-model.js";

const SHARDS: readonly Shard[] = [
  {
    id: "pkg:core",
    rootDir: "/repo/packages/core",
    files: [
      "/repo/packages/core/src/index.ts",
      "/repo/packages/core/src/util.ts",
    ],
    configPathAbs: "/repo/packages/core/tsconfig.json",
  },
  {
    id: ":root",
    rootDir: "/repo",
    files: ["/repo/scripts/release.ts"],
  },
];

const RESULT: ShardBuildResult = {
  shardId: "pkg:core",
  fragment: {
    version: "3.0",
    tool: "graph",
    language: "typescript",
    builtAt: "2026-05-30T00:00:00.000Z",
    cacheKey: "ts-5-exact-abc",
    resolutionMode: "exact",
    functions: {
      main: [
        {
          bodyHash: "h1",
          simpleName: "main",
          qualifiedName: "core/main",
          filePath: "core/index.ts",
          line: 1,
          column: 0,
          endLine: 2,
          kind: "function-declaration",
          params: [],
          returnType: null,
          enclosingClass: null,
          decorators: [],
          visibility: "exported",
          inTestFile: false,
          definedInGenerated: false,
          calls: [
            {
              to: ["h2"],
              line: 1,
              column: 4,
              resolution: "static",
              confidence: "high",
              text: "foo()",
            },
          ],
        },
      ],
    },
  },
  fingerprint: "fp-abc",
  boundaryCalls: [
    {
      ownerHash: "h1",
      ownerFile: "core/index.ts",
      calleeName: "dep",
      importSpecifier: "@scope/dep",
      line: 3,
      column: 2,
      text: "dep()",
    },
  ],
  parseErrors: [],
};

describe("ShardBuildResult serialization", () => {
  it("round-trips the planned Shard[] through JSON for graph-run-worker specs", () => {
    // The live parent pre-plans shards to choose engine labels, then writes the
    // plan into the graph-run-worker spec. Keep Shard plain-data only.
    // eslint-disable-next-line unicorn/prefer-structured-clone -- testing JSON serialization specifically
    const roundTripped = JSON.parse(JSON.stringify(SHARDS)) as readonly Shard[];
    expect(roundTripped).toEqual(SHARDS);
  });

  it("round-trips losslessly through JSON (the worker-boundary contract)", () => {
    // Intentionally JSON, not structuredClone: the real worker boundary
    // serializes to JSON over stdout, so this is the exact contract.
    // eslint-disable-next-line unicorn/prefer-structured-clone -- testing JSON serialization specifically
    const roundTripped = JSON.parse(JSON.stringify(RESULT)) as ShardBuildResult;
    expect(roundTripped).toEqual(RESULT);
  });

  it("carries no non-serializable handles (deep equality after a clone proves it)", () => {
    const clone = structuredClone(RESULT);
    expect(clone.boundaryCalls[0]?.importSpecifier).toBe("@scope/dep");
    expect(clone.fragment.functions.main?.[0]?.calls[0]?.to).toEqual(["h2"]);
  });
});
