import { describe, expect, it } from 'vitest';

import {
  encodeAuthoredReplayManifest,
  parseAuthoredReplayManifest,
} from '../init-authored-plan-manifest.js';
import {
  AUTHORED_REPLAY_MANIFEST_KIND,
  AUTHORED_REPLAY_MANIFEST_VERSION,
  INIT_AUTHORED_PLAN_CAPS,
} from '../init-authored-plan-types.js';

import type {
  AuthoredReplayManifest,
  InitAuthoredMutation,
  InitAuthoredPathState,
} from '../init-authored-plan-types.js';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DIGEST_C = 'c'.repeat(64);
const DIGEST_D = 'd'.repeat(64);

interface MutableMutation {
  sequence: unknown;
  action: unknown;
  path: unknown;
  targetType: unknown;
  targetMode: unknown;
  preimage: Record<string, unknown>;
  desired: Record<string, unknown>;
  desiredBlob: unknown;
  preimageBlob: unknown;
  [key: string]: unknown;
}

interface MutableManifest {
  kind: unknown;
  version: unknown;
  inputs: {
    languages: unknown;
    mode: unknown;
    tools: Record<string, unknown>[];
    [key: string]: unknown;
  };
  mutations: MutableMutation[];
  [key: string]: unknown;
}

interface InvalidManifestCase {
  readonly name: string;
  readonly mutate: (manifest: MutableManifest) => void;
  readonly message: RegExp;
}

function absentState(): InitAuthoredPathState {
  return { exists: false, type: null, mode: null, digest: null };
}

function fileState(digest: string): InitAuthoredPathState {
  return { exists: true, type: 'file', mode: 0o644, digest };
}

function directoryState(): InitAuthoredPathState {
  return { exists: true, type: 'directory', mode: 0o755, digest: DIGEST_C };
}

function validMutationMatrix(): readonly InitAuthoredMutation[] {
  const directory = directoryState();
  return [
    {
      sequence: 0,
      action: 'create',
      path: 'a-create.txt',
      targetType: 'file',
      targetMode: 0o644,
      preimage: absentState(),
      desired: fileState(DIGEST_A),
      desiredBlob: 'desired/0000.blob',
      preimageBlob: null,
    },
    {
      sequence: 1,
      action: 'delete',
      path: 'b-delete.txt',
      targetType: 'file',
      targetMode: 0o644,
      preimage: fileState(DIGEST_B),
      desired: absentState(),
      desiredBlob: null,
      preimageBlob: 'preimage/0001.blob',
    },
    {
      sequence: 2,
      action: 'preserve',
      path: 'c-directory',
      targetType: 'directory',
      targetMode: 0o755,
      preimage: directory,
      desired: { ...directory },
      desiredBlob: null,
      preimageBlob: null,
    },
    {
      sequence: 3,
      action: 'replace',
      path: 'd-replace.txt',
      targetType: 'file',
      targetMode: 0o644,
      preimage: fileState(DIGEST_C),
      desired: fileState(DIGEST_D),
      desiredBlob: 'desired/0003.blob',
      preimageBlob: 'preimage/0003.blob',
    },
  ];
}

function validManifest(overrides: Partial<AuthoredReplayManifest> = {}): AuthoredReplayManifest {
  return {
    kind: AUTHORED_REPLAY_MANIFEST_KIND,
    version: AUTHORED_REPLAY_MANIFEST_VERSION,
    inputs: {
      languages: ['typescript'],
      mode: 'fresh',
      tools: [
        {
          stableId: '00000000-0000-4000-8000-0000000000f1',
          name: 'fitness',
          version: '1.0.0',
        },
      ],
    },
    mutations: validMutationMatrix(),
    ...overrides,
  };
}

function mutableManifest(): MutableManifest {
  return JSON.parse(encodeAuthoredReplayManifest(validManifest())) as MutableManifest;
}

const INVALID_CASES: readonly InvalidManifestCase[] = [
  {
    name: 'unknown envelope fields',
    mutate: (manifest) => {
      manifest.extra = true;
    },
    message: /unknown or missing fields/u,
  },
  {
    name: 'unsupported manifest kind',
    mutate: (manifest) => {
      manifest.kind = 'other-kind';
    },
    message: /manifest\.kind is unsupported/u,
  },
  {
    name: 'unsupported manifest version',
    mutate: (manifest) => {
      manifest.version = 2;
    },
    message: /manifest\.version is unsupported/u,
  },
  {
    name: 'unknown input fields',
    mutate: (manifest) => {
      manifest.inputs.extra = true;
    },
    message: /inputs has unknown or missing fields/u,
  },
  {
    name: 'non-string mode',
    mutate: (manifest) => {
      manifest.inputs.mode = 1;
    },
    message: /inputs\.mode must be a string/u,
  },
  {
    name: 'unsupported mode',
    mutate: (manifest) => {
      manifest.inputs.mode = 'upgrade';
    },
    message: /unsupported authored mode/u,
  },
  {
    name: 'non-array languages',
    mutate: (manifest) => {
      manifest.inputs.languages = 'typescript';
    },
    message: /inputs\.languages must be an array/u,
  },
  {
    name: 'non-string language',
    mutate: (manifest) => {
      manifest.inputs.languages = [1];
    },
    message: /inputs\.languages\[0\] must be a string/u,
  },
  {
    name: 'noncanonical language order',
    mutate: (manifest) => {
      manifest.inputs.languages = ['rust', 'typescript'];
    },
    message: /canonical order/u,
  },
  {
    name: 'non-array tools',
    mutate: (manifest) => {
      manifest.inputs.tools = null as never;
    },
    message: /inputs\.tools must be an array/u,
  },
  {
    name: 'tool identity fields',
    mutate: (manifest) => {
      manifest.inputs.tools[0].extra = true;
    },
    message: /inputs\.tools\[0\] has unknown or missing fields/u,
  },
  {
    name: 'non-string tool identity',
    mutate: (manifest) => {
      manifest.inputs.tools[0].version = 1;
    },
    message: /values must be strings/u,
  },
  {
    name: 'invalid tool identity',
    mutate: (manifest) => {
      manifest.inputs.tools[0].name = ' fitness';
    },
    message: /inputs\.tools\[0\]\.name is invalid/u,
  },
  {
    name: 'duplicate tool identities',
    mutate: (manifest) => {
      manifest.inputs.tools.push({ ...manifest.inputs.tools[0] });
    },
    message: /identities must be unique/u,
  },
  {
    name: 'non-array mutations',
    mutate: (manifest) => {
      manifest.mutations = null as never;
    },
    message: /manifest\.mutations must be an array/u,
  },
  {
    name: 'unknown mutation fields',
    mutate: (manifest) => {
      manifest.mutations[0].extra = true;
    },
    message: /mutations\[0\] has unknown or missing fields/u,
  },
  {
    name: 'noncanonical mutation sequence',
    mutate: (manifest) => {
      manifest.mutations[0].sequence = 1;
    },
    message: /sequence is noncanonical/u,
  },
  {
    name: 'out-of-range mutation sequence',
    mutate: (manifest) => {
      manifest.mutations[0].sequence = INIT_AUTHORED_PLAN_CAPS.maxMutations + 1;
    },
    message: /must be an integer/u,
  },
  {
    name: 'unsupported mutation action',
    mutate: (manifest) => {
      manifest.mutations[0].action = 'move';
    },
    message: /action is unsupported/u,
  },
  {
    name: 'non-string mutation path',
    mutate: (manifest) => {
      manifest.mutations[0].path = 1;
    },
    message: /path must be a string/u,
  },
  {
    name: 'unsafe mutation path',
    mutate: (manifest) => {
      manifest.mutations[0].path = '../escape';
    },
    message: /unsafe or noncanonical/u,
  },
  {
    name: 'unsupported target type',
    mutate: (manifest) => {
      manifest.mutations[0].targetType = 'link';
    },
    message: /targetType is unsupported/u,
  },
  {
    name: 'unsafe target mode',
    mutate: (manifest) => {
      manifest.mutations[0].targetMode = 0o666;
    },
    message: /targetMode is unsafe/u,
  },
  {
    name: 'non-boolean state existence',
    mutate: (manifest) => {
      manifest.mutations[0].preimage.exists = 'no';
    },
    message: /preimage\.exists must be boolean/u,
  },
  {
    name: 'unsupported state type',
    mutate: (manifest) => {
      manifest.mutations[0].desired.type = 'socket';
    },
    message: /desired\.type is unsupported/u,
  },
  {
    name: 'out-of-range state mode',
    mutate: (manifest) => {
      manifest.mutations[0].desired.mode = -1;
    },
    message: /desired\.mode must be an integer/u,
  },
  {
    name: 'invalid state digest',
    mutate: (manifest) => {
      manifest.mutations[0].desired.digest = DIGEST_A.toUpperCase();
    },
    message: /lowercase SHA-256 digest/u,
  },
  {
    name: 'identified absent state',
    mutate: (manifest) => {
      manifest.mutations[0].preimage.type = 'file';
    },
    message: /absent state must have null identity/u,
  },
  {
    name: 'incomplete existing state',
    mutate: (manifest) => {
      manifest.mutations[0].desired.digest = null;
    },
    message: /existing state requires type, mode, and digest/u,
  },
  {
    name: 'writable existing state',
    mutate: (manifest) => {
      manifest.mutations[0].desired.mode = 0o666;
    },
    message: /desired\.mode is group\/world writable/u,
  },
  {
    name: 'target identity disagreement',
    mutate: (manifest) => {
      manifest.mutations[0].targetMode = 0o600;
    },
    message: /target identity disagrees/u,
  },
  {
    name: 'action disagreement',
    mutate: (manifest) => {
      manifest.mutations[0].action = 'replace';
    },
    message: /action disagrees/u,
  },
  {
    name: 'non-null absent blob',
    mutate: (manifest) => {
      manifest.mutations[1].desiredBlob = 'desired/0001.blob';
    },
    message: /desired directory\/absent blob must be null/u,
  },
  {
    name: 'non-null directory blob',
    mutate: (manifest) => {
      manifest.mutations[2].preimageBlob = 'preimage/0002.blob';
    },
    message: /preimage directory\/absent blob must be null/u,
  },
  {
    name: 'noncanonical file blob',
    mutate: (manifest) => {
      manifest.mutations[3].desiredBlob = 'desired/3.blob';
    },
    message: /canonical host-generated name/u,
  },
  {
    name: 'noncanonical path order',
    mutate: (manifest) => {
      manifest.mutations[0].path = 'z-create.txt';
    },
    message: /canonical UTF-8 path order/u,
  },
  {
    name: 'case-folding path collision',
    mutate: (manifest) => {
      manifest.mutations[0].path = 'A';
      manifest.mutations[1].path = 'a';
    },
    message: /collide under case folding/u,
  },
];

describe('Init authored replay manifest codec', () => {
  it('round-trips the canonical create, delete, preserve, and replace matrix', () => {
    const manifest = validManifest();
    const encoded = encodeAuthoredReplayManifest(manifest);

    expect(encoded.endsWith('\n')).toBe(false);
    expect(parseAuthoredReplayManifest(encoded)).toEqual(manifest);
  });

  it('allows the canonical empty language set only for refresh replay', () => {
    const manifest = validManifest({
      inputs: {
        languages: [],
        mode: 'refresh',
        tools: [],
      },
      mutations: [],
    });

    expect(parseAuthoredReplayManifest(encodeAuthoredReplayManifest(manifest))).toEqual(manifest);
  });

  it.each(INVALID_CASES)('fails closed for $name', ({ mutate, message }) => {
    const manifest = mutableManifest();
    mutate(manifest);

    expect(() => parseAuthoredReplayManifest(JSON.stringify(manifest))).toThrow(message);
  });

  it('rejects malformed, noncanonical, oversized, and non-object bytes', () => {
    const canonical = encodeAuthoredReplayManifest(validManifest());
    const parsed = JSON.parse(canonical) as MutableManifest;
    const reordered = JSON.stringify({
      version: parsed.version,
      kind: parsed.kind,
      inputs: parsed.inputs,
      mutations: parsed.mutations,
    });

    expect(() => parseAuthoredReplayManifest('{')).toThrow(/not valid JSON/u);
    expect(() => parseAuthoredReplayManifest(` ${canonical}`)).toThrow(/not canonical/u);
    expect(() => parseAuthoredReplayManifest(reordered)).toThrow(/not canonical/u);
    expect(() =>
      parseAuthoredReplayManifest(' '.repeat(INIT_AUTHORED_PLAN_CAPS.maxManifestBytes + 1)),
    ).toThrow(/exceeds/u);
    expect(() => parseAuthoredReplayManifest('[]')).toThrow(/plain object/u);
    expect(() => encodeAuthoredReplayManifest(new Date() as never)).toThrow(/plain object/u);
  });

  it('rejects a mutation count above the closed cap before parsing entries', () => {
    const manifest = mutableManifest();
    manifest.mutations = Array.from(
      { length: INIT_AUTHORED_PLAN_CAPS.maxMutations + 1 },
      () => null as never,
    );

    expect(() => parseAuthoredReplayManifest(JSON.stringify(manifest))).toThrow(
      /mutation count exceeds/u,
    );
  });
});
