/**
 * `graph-run-worker` sharded integration: exercise the real worker sharded
 * branch without mocking graph.js. The graph-run worker coordinates a fixture
 * `graph-shard-worker` CLI script, which proves the process nesting path:
 * render parent -> graph-run-worker -> shard workers.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runWithScope, runWithScopeSync } from "@opensip-cli/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeGraphTestScope } from "../../__tests__/test-utils/with-graph-scope.js";
import { currentAdapterRegistry } from "../../lang-adapter/registry.js";
import { executeGraphWorker } from "../graph-worker.js";

import type { GraphLanguageAdapter } from "../../lang-adapter/types.js";
import type { LiveGraphOutput } from "../graph.js";
import type { Shard } from "../orchestrate/shard-model.js";
import type { ProgressEvent } from "@opensip-cli/cli-ui";
import type { ToolCliContext, WorkerMessage } from "@opensip-cli/core";

type Msg = WorkerMessage<ProgressEvent, LiveGraphOutput>;

const SHARD_WORKER_SCRIPT = String.raw`
const { readFileSync } = require('node:fs');
const spec = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const id = spec.shard.id;
const name = id.replace(/[^a-zA-Z0-9]/g, '_');
const occ = {
  bodyHash: 'h-' + id,
  simpleName: name,
  qualifiedName: id + '.' + name,
  filePath: id + '/index.ts',
  line: 1,
  column: 0,
  endLine: 1,
  kind: 'function-declaration',
  params: [],
  returnType: null,
  enclosingClass: null,
  decorators: [],
  visibility: 'exported',
  inTestFile: false,
  definedInGenerated: false,
  calls: [],
};
const result = {
  shardId: id,
  fragment: {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: 'x',
    cacheKey: 'fixture-' + id,
    resolutionMode: 'exact',
    functions: { [name]: [occ] },
  },
  fingerprint: 'fp-' + id,
  boundaryCalls: [],
  parseErrors: [],
};
process.stdout.write(JSON.stringify(result));
process.exit(0);
`;

const adapter = {
  id: "typescript",
  fileExtensions: [".ts"],
  cacheKey: () => "unused-no-cache",
  ruleHints: undefined,
} as unknown as GraphLanguageAdapter;

function mockCli(): ToolCliContext {
  return { scope: { datastore: () => undefined } } as unknown as ToolCliContext;
}

describe("executeGraphWorker sharded integration", () => {
  let dir: string;
  let cliScript: string;
  let originalArgv1: string | undefined;
  let messages: Msg[];
  let scope: ReturnType<typeof makeGraphTestScope>;

  beforeEach(() => {
    scope = makeGraphTestScope();
    runWithScopeSync(scope, () => currentAdapterRegistry().register(adapter));
    dir = mkdtempSync(join(tmpdir(), "graph-worker-sharded-"));
    cliScript = join(dir, "fake-cli.cjs");
    writeFileSync(cliScript, SHARD_WORKER_SCRIPT, "utf8");
    originalArgv1 = process.argv[1];
    process.argv[1] = cliScript;
    messages = [];
    (process as { send?: unknown }).send = vi.fn((m: Msg) => {
      messages.push(m);
      return true;
    });
  });

  afterEach(() => {
    runWithScopeSync(scope, () => currentAdapterRegistry().clear());
    if (originalArgv1 === undefined) process.argv.splice(1, 1);
    else process.argv[1] = originalArgv1;
    delete (process as { send?: unknown }).send;
    rmSync(dir, { recursive: true, force: true });
  });

  function shard(id: string): Shard {
    return {
      id,
      rootDir: dir,
      files: [join(dir, `${id}.ts`)],
    };
  }

  it("coordinates real shard workers and returns a live output over IPC", async () => {
    const specPath = join(dir, "spec.json");
    writeFileSync(
      specPath,
      JSON.stringify({
        cwd: dir,
        noCache: true,
        resolution: "exact",
        exact: false,
        shards: [shard("pkg:a"), shard("pkg:b")],
      }),
      "utf8",
    );

    await runWithScope(scope, () => executeGraphWorker(specPath, mockCli()));

    const progress = messages.filter((m) => m.kind === "progress");
    expect(progress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "progress",
          event: expect.objectContaining({
            type: "stage-start",
            stage: "parse",
            label: "Build shards",
          }),
        }),
        expect.objectContaining({
          kind: "progress",
          event: expect.objectContaining({
            type: "stage-start",
            stage: "resolve",
            label: "Link cross-package",
          }),
        }),
      ]),
    );
    const result = messages.at(-1);
    expect(result?.kind).toBe("result");
    if (result?.kind !== "result") throw new Error("no result message");
    expect(result.value.reportLines.join("\n")).toContain("== Catalog ==");
    expect(Array.isArray(result.value.signals)).toBe(true);
  });
});
