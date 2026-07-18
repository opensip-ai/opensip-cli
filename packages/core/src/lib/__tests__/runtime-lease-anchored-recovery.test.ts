import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  anchoredRecordTemporaryBasename,
  ANCHORED_CREATE_RECOVERY_MAX_ENTRIES,
  ANCHORED_RECORD_MAX_BYTES,
  mutateAnchoredRecord,
  readAnchoredRecord,
} from '../runtime-lease.js';

const CREATE_IDENTITY = 'operation.abc_123-XYZ9';
const OTHER_CREATE_IDENTITY = 'operation.other_456-XYZ8';

const roots: string[] = [];

function makeAnchor(mode = 0o700): string {
  const root = mkdtempSync(join(tmpdir(), 'opensip-anchored-recovery-'));
  roots.push(root);
  if (process.platform !== 'win32') chmodSync(root, mode);
  return root;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function writePrivate(path: string, content: string): void {
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

function createLinkedCrash(input: {
  readonly anchor: string;
  readonly basename: string;
  readonly temporaryBasename: string;
  readonly content: string;
}): { readonly target: string; readonly temporary: string } {
  const target = join(input.anchor, input.basename);
  const temporary = join(input.anchor, input.temporaryBasename);
  writePrivate(temporary, input.content);
  linkSync(temporary, target);
  return { target, temporary };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('general anchored-record bounds and postures', () => {
  it('accepts the exact 4 MiB cap and rejects caller bounds or content above it', () => {
    const anchor = makeAnchor();
    const content = 'x'.repeat(ANCHORED_RECORD_MAX_BYTES);
    mutateAnchoredRecord({
      trustedAnchorDir: anchor,
      parentDir: anchor,
      basename: 'maximum.bin',
      operation: 'create',
      content,
      maxBytes: ANCHORED_RECORD_MAX_BYTES,
    });
    expect(
      readAnchoredRecord({
        trustedAnchorDir: anchor,
        parentDir: anchor,
        basename: 'maximum.bin',
        maxBytes: ANCHORED_RECORD_MAX_BYTES,
      }),
    ).toMatchObject({ status: 'present', content });

    for (const operation of [
      () =>
        mutateAnchoredRecord({
          trustedAnchorDir: anchor,
          parentDir: anchor,
          basename: 'invalid-bound.bin',
          operation: 'create',
          content: '',
          maxBytes: ANCHORED_RECORD_MAX_BYTES + 1,
        }),
      () =>
        readAnchoredRecord({
          trustedAnchorDir: anchor,
          parentDir: anchor,
          basename: 'maximum.bin',
          maxBytes: ANCHORED_RECORD_MAX_BYTES + 1,
        }),
      () =>
        mutateAnchoredRecord({
          trustedAnchorDir: anchor,
          parentDir: anchor,
          basename: 'oversize.bin',
          operation: 'create',
          content: `${content}x`,
          maxBytes: ANCHORED_RECORD_MAX_BYTES,
        }),
    ]) {
      expect(operation).toThrow(
        expect.objectContaining({ code: 'SYSTEM.RUNTIME_COORDINATION.UNSAFE' }),
      );
    }
    expect(existsSync(join(anchor, 'invalid-bound.bin'))).toBe(false);
    expect(existsSync(join(anchor, 'oversize.bin'))).toBe(false);
  });

  it('accepts the exact recovery scan cap and rejects a requested cap above it', () => {
    const anchor = makeAnchor();
    const expectedContentSha256 = sha256('{}');
    expect(
      readAnchoredRecord({
        trustedAnchorDir: anchor,
        parentDir: anchor,
        basename: 'absent.json',
        linkedCreateRecovery: {
          effect: 'settle-linked-create',
          expectedContentSha256,
          maxEntries: ANCHORED_CREATE_RECOVERY_MAX_ENTRIES,
        },
      }),
    ).toEqual({ status: 'absent' });
    expect(() =>
      readAnchoredRecord({
        trustedAnchorDir: anchor,
        parentDir: anchor,
        basename: 'absent.json',
        linkedCreateRecovery: {
          effect: 'settle-linked-create',
          expectedContentSha256,
          maxEntries: ANCHORED_CREATE_RECOVERY_MAX_ENTRIES + 1,
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'SYSTEM.RUNTIME_COORDINATION.UNSAFE' }));
  });

  it('keeps records private inside an owner-controlled 0755 parent', () => {
    const anchor = makeAnchor(0o755);
    const content = '{"private":true}';
    mutateAnchoredRecord({
      trustedAnchorDir: anchor,
      parentDir: anchor,
      basename: 'private.json',
      operation: 'create',
      content,
      permissionPosture: 'owner-controlled',
      recordPosture: 'private',
      createIdentity: CREATE_IDENTITY,
    });
    if (process.platform !== 'win32') {
      expect(lstatSync(join(anchor, 'private.json')).mode & 0o777).toBe(0o600);
    }
    expect(
      readAnchoredRecord({
        trustedAnchorDir: anchor,
        parentDir: anchor,
        basename: 'private.json',
        permissionPosture: 'owner-controlled',
        recordPosture: 'private',
      }),
    ).toMatchObject({ status: 'present', content });
  });

  it('validates parent and record postures before target I/O', () => {
    const missing = join(makeAnchor(), 'missing');
    for (const operation of [
      () =>
        mutateAnchoredRecord({
          trustedAnchorDir: missing,
          parentDir: missing,
          basename: 'record.json',
          operation: 'create',
          content: '{}',
          permissionPosture: 'invalid' as never,
        }),
      () =>
        readAnchoredRecord({
          trustedAnchorDir: missing,
          parentDir: missing,
          basename: 'record.json',
          recordPosture: 'invalid' as never,
        }),
    ]) {
      expect(operation).toThrow(
        expect.objectContaining({ code: 'SYSTEM.RUNTIME_COORDINATION.UNSAFE' }),
      );
    }
  });
});

describe('operation-bound anchored create recovery', () => {
  it('uses a portable deterministic temporary basename grammar', () => {
    expect(anchoredRecordTemporaryBasename('record.json', CREATE_IDENTITY)).toBe(
      `.record.json.tmp-${CREATE_IDENTITY}`,
    );
    for (const identity of [
      'too-short',
      'operation:abc_123-XYZ9',
      'operation/abc_123-XYZ9',
      'operation.abc_123-XYZ.',
      'operation.abc_123-XYZ-',
      'operation.abc_123-XYZ_',
    ]) {
      expect(() => anchoredRecordTemporaryBasename('record.json', identity)).toThrow(
        expect.objectContaining({ code: 'SYSTEM.RUNTIME_COORDINATION.UNSAFE' }),
      );
    }
  });

  it('discards only the exact unlinked temporary owned by the operation', () => {
    const anchor = makeAnchor();
    const basename = 'record.json';
    const content = '{"prepared":true}';
    const owned = join(anchor, anchoredRecordTemporaryBasename(basename, CREATE_IDENTITY));
    const foreign = join(anchor, anchoredRecordTemporaryBasename(basename, OTHER_CREATE_IDENTITY));
    writePrivate(owned, content);
    writePrivate(foreign, '{"foreign":true}');

    expect(
      readAnchoredRecord({
        trustedAnchorDir: anchor,
        parentDir: anchor,
        basename,
        linkedCreateRecovery: {
          effect: 'settle-or-discard-owned-temporary',
          expectedContentSha256: sha256(content),
          createIdentity: CREATE_IDENTITY,
        },
      }),
    ).toEqual({ status: 'absent' });
    expect(existsSync(owned)).toBe(false);
    expect(readFileSync(foreign, 'utf8')).toBe('{"foreign":true}');

    expect(
      readAnchoredRecord({
        trustedAnchorDir: anchor,
        parentDir: anchor,
        basename,
        linkedCreateRecovery: {
          effect: 'settle-or-discard-owned-temporary',
          expectedContentSha256: sha256(content),
          createIdentity: CREATE_IDENTITY,
        },
      }),
    ).toEqual({ status: 'absent' });
  });

  it('settles an exact linked create and re-proves its private final record', () => {
    const anchor = makeAnchor(0o755);
    const basename = 'record.json';
    const content = '{"linked":true}';
    const temporaryBasename = anchoredRecordTemporaryBasename(basename, CREATE_IDENTITY);
    const { target, temporary } = createLinkedCrash({
      anchor,
      basename,
      temporaryBasename,
      content,
    });

    expect(
      readAnchoredRecord({
        trustedAnchorDir: anchor,
        parentDir: anchor,
        basename,
        permissionPosture: 'owner-controlled',
        recordPosture: 'private',
        linkedCreateRecovery: {
          effect: 'settle-or-discard-owned-temporary',
          expectedContentSha256: sha256(content),
          createIdentity: CREATE_IDENTITY,
        },
      }),
    ).toMatchObject({ status: 'present', content });
    expect(existsSync(temporary)).toBe(false);
    expect(lstatSync(target).nlink).toBe(1);
    if (process.platform !== 'win32') {
      expect(lstatSync(target).mode & 0o777).toBe(0o600);
    }

    expect(
      readAnchoredRecord({
        trustedAnchorDir: anchor,
        parentDir: anchor,
        basename,
        permissionPosture: 'owner-controlled',
        recordPosture: 'private',
        linkedCreateRecovery: {
          effect: 'settle-or-discard-owned-temporary',
          expectedContentSha256: sha256(content),
          createIdentity: CREATE_IDENTITY,
        },
      }),
    ).toMatchObject({ status: 'present', content });
  });

  it('preserves both links when the operation-bound digest mismatches', () => {
    const anchor = makeAnchor();
    const basename = 'record.json';
    const temporaryBasename = anchoredRecordTemporaryBasename(basename, CREATE_IDENTITY);
    const { target, temporary } = createLinkedCrash({
      anchor,
      basename,
      temporaryBasename,
      content: '{"actual":true}',
    });

    expect(() =>
      readAnchoredRecord({
        trustedAnchorDir: anchor,
        parentDir: anchor,
        basename,
        linkedCreateRecovery: {
          effect: 'settle-or-discard-owned-temporary',
          expectedContentSha256: sha256('{"expected":true}'),
          createIdentity: CREATE_IDENTITY,
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'SYSTEM.RUNTIME_COORDINATION.UNSAFE' }));
    expect(existsSync(target)).toBe(true);
    expect(existsSync(temporary)).toBe(true);
    expect(lstatSync(target).nlink).toBe(2);
  });
});

describe('bounded random-UUID linked-create recovery', () => {
  const uuidTemporary = (basename: string, suffix: string): string => `.${basename}.tmp-${suffix}`;

  it('finds a proven peer after more than the former 512-entry scan bound', () => {
    const anchor = makeAnchor();
    const basename = 'record.json';
    for (let index = 0; index < 600; index += 1) {
      writePrivate(join(anchor, `unrelated-${String(index).padStart(4, '0')}`), '');
    }
    const content = '{"late":true}';
    const { target, temporary } = createLinkedCrash({
      anchor,
      basename,
      temporaryBasename: uuidTemporary(basename, '00000000-0000-4000-8000-000000000001'),
      content,
    });
    expect(
      readAnchoredRecord({
        trustedAnchorDir: anchor,
        parentDir: anchor,
        basename,
        linkedCreateRecovery: {
          effect: 'settle-linked-create',
          expectedContentSha256: sha256(content),
        },
      }),
    ).toMatchObject({ status: 'present', content });
    expect(existsSync(temporary)).toBe(false);
    expect(lstatSync(target).nlink).toBe(1);
  });

  it('fails closed at a caller scan cap and preserves both links', () => {
    const anchor = makeAnchor();
    const basename = 'record.json';
    for (let index = 0; index < 20; index += 1) {
      writePrivate(join(anchor, `unrelated-${String(index).padStart(2, '0')}`), '');
    }
    const content = '{"bounded":true}';
    const { target, temporary } = createLinkedCrash({
      anchor,
      basename,
      temporaryBasename: uuidTemporary(basename, '00000000-0000-4000-8000-000000000002'),
      content,
    });
    expect(() =>
      readAnchoredRecord({
        trustedAnchorDir: anchor,
        parentDir: anchor,
        basename,
        linkedCreateRecovery: {
          effect: 'settle-linked-create',
          expectedContentSha256: sha256(content),
          maxEntries: 10,
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'SYSTEM.RUNTIME_COORDINATION.UNSAFE' }));
    expect(existsSync(temporary)).toBe(true);
    expect(lstatSync(target).nlink).toBe(2);
  });

  it('rejects invalid peer grammar, ambiguous links, and digest mismatch without unlinking', () => {
    const run = (
      build: (anchor: string, basename: string, target: string, content: string) => string[],
      expectedDigest: (content: string) => string = sha256,
    ): void => {
      const anchor = makeAnchor();
      const basename = 'record.json';
      const target = join(anchor, basename);
      const content = '{"proof":true}';
      const peers = build(anchor, basename, target, content);
      expect(() =>
        readAnchoredRecord({
          trustedAnchorDir: anchor,
          parentDir: anchor,
          basename,
          linkedCreateRecovery: {
            effect: 'settle-linked-create',
            expectedContentSha256: expectedDigest(content),
          },
        }),
      ).toThrow(expect.objectContaining({ code: 'SYSTEM.RUNTIME_COORDINATION.UNSAFE' }));
      expect(existsSync(target)).toBe(true);
      for (const peer of peers) expect(existsSync(peer)).toBe(true);
    };

    run((anchor, basename, target, content) => {
      const invalid = join(anchor, uuidTemporary(basename, 'not-a-uuid'));
      writePrivate(invalid, content);
      linkSync(invalid, target);
      return [invalid];
    });
    run((anchor, basename, target, content) => {
      const first = join(anchor, uuidTemporary(basename, '00000000-0000-4000-8000-000000000003'));
      const second = join(anchor, uuidTemporary(basename, '00000000-0000-4000-8000-000000000004'));
      writePrivate(first, content);
      linkSync(first, target);
      linkSync(first, second);
      return [first, second];
    });
    run(
      (anchor, basename, target, content) => {
        const temporary = join(
          anchor,
          uuidTemporary(basename, '00000000-0000-4000-8000-000000000005'),
        );
        writePrivate(temporary, content);
        linkSync(temporary, target);
        return [temporary];
      },
      () => sha256('{"different":true}'),
    );
  });

  it('ignores a colliding valid-prefix file with a different inode', () => {
    const anchor = makeAnchor();
    const basename = 'record.json';
    const collision = join(anchor, uuidTemporary(basename, '00000000-0000-4000-8000-000000000006'));
    writePrivate(collision, '{"collision":true}');
    const content = '{"actual":true}';
    const { target, temporary } = createLinkedCrash({
      anchor,
      basename,
      temporaryBasename: uuidTemporary(basename, '00000000-0000-4000-8000-000000000007'),
      content,
    });
    expect(
      readAnchoredRecord({
        trustedAnchorDir: anchor,
        parentDir: anchor,
        basename,
        linkedCreateRecovery: {
          effect: 'settle-linked-create',
          expectedContentSha256: sha256(content),
        },
      }),
    ).toMatchObject({ status: 'present', content });
    expect(existsSync(temporary)).toBe(false);
    expect(readFileSync(collision, 'utf8')).toBe('{"collision":true}');
    expect(lstatSync(target).nlink).toBe(1);
  });
});
