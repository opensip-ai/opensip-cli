import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import test from 'node:test';

import {
  DISTRIBUTION_NODE_GYP_MAX_DEPTH,
  DISTRIBUTION_NODE_GYP_MAX_ENTRIES,
  DISTRIBUTION_NODE_GYP_MAX_FILE_BYTES,
  DISTRIBUTION_NODE_GYP_MAX_TOTAL_BYTES,
  cloneDistributionWindowsNodeGypDevDir,
  defaultDistributionWindowsNodeGypDevDir,
} from '../lib/distribution-node-gyp-devdir.mjs';

const VERSION = '24.16.0';
const LOCAL_APP_DATA = String.raw`C:\Users\person\AppData\Local`;
const SOURCE_DEVDIR = String.raw`C:\Users\person\AppData\Local\node-gyp\Cache`;
const DESTINATION_DEVDIR = String.raw`C:\measurement\node-gyp-devdir`;

function mappedWindowsFilesystem(root) {
  const physicalPath = (windowsPath) => {
    const normalized = win32.normalize(windowsPath);
    const parsed = win32.parse(normalized);
    if (!parsed.root) throw new Error(`Expected an absolute Windows path: ${windowsPath}`);
    const volume = parsed.root.replaceAll(/[^0-9A-Za-z]/gu, '_');
    const relative = win32.relative(parsed.root, normalized);
    return join(root, volume, ...relative.split('\\').filter(Boolean));
  };
  return {
    physicalPath,
    filesystem: {
      copyFile: async (source, destination, mode) =>
        await fs.copyFile(physicalPath(source), physicalPath(destination), mode),
      lstat: async (path) => await fs.lstat(physicalPath(path)),
      mkdir: async (path, options) => await fs.mkdir(physicalPath(path), options),
      opendir: async (path) => await fs.opendir(physicalPath(path)),
      readFile: async (path, encoding) => await fs.readFile(physicalPath(path), encoding),
      rm: async (path, options) => await fs.rm(physicalPath(path), options),
    },
  };
}

async function writeMappedFile(mapping, path, content) {
  const physical = mapping.physicalPath(path);
  await fs.mkdir(dirname(physical), { recursive: true });
  await fs.writeFile(physical, content);
  return physical;
}

function versionHeader(version = VERSION) {
  const [major, minor, patch] = version.split('.');
  return [
    `#define NODE_MAJOR_VERSION ${major}`,
    `#define NODE_MINOR_VERSION ${minor}`,
    `#define NODE_PATCH_VERSION ${patch}`,
    '',
  ].join('\n');
}

async function createValidFixture() {
  const root = mkdtempSync(join(tmpdir(), 'opensip-win-node-gyp-'));
  const mapping = mappedWindowsFilesystem(root);
  const versionRoot = win32.join(SOURCE_DEVDIR, VERSION);
  await Promise.all([
    writeMappedFile(mapping, win32.join(versionRoot, 'include', 'node', 'node.h'), 'node\n'),
    writeMappedFile(
      mapping,
      win32.join(versionRoot, 'include', 'node', 'node_version.h'),
      versionHeader(),
    ),
    writeMappedFile(mapping, win32.join(versionRoot, 'include', 'node', 'config.gypi'), '{}\n'),
    writeMappedFile(mapping, win32.join(versionRoot, 'include', 'node', 'common.gypi'), '{}\n'),
    writeMappedFile(mapping, win32.join(versionRoot, 'installVersion'), '11\n'),
    writeMappedFile(mapping, win32.join(versionRoot, 'x64', 'node.lib'), 'library\n'),
    writeMappedFile(
      mapping,
      win32.join(versionRoot, 'include', 'node', 'openssl', 'nested.h'),
      'header\n',
    ),
    writeMappedFile(
      mapping,
      win32.join(SOURCE_DEVDIR, '23.11.0', 'include', 'node', 'node.h'),
      'other-version\n',
    ),
    fs.mkdir(dirname(mapping.physicalPath(DESTINATION_DEVDIR)), {
      recursive: true,
    }),
  ]);
  return {
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    mapping,
    versionRoot,
  };
}

test('Windows node-gyp devdir cloning validates and copies only the exact version', async () => {
  const fixture = await createValidFixture();
  try {
    assert.equal(
      defaultDistributionWindowsNodeGypDevDir({
        environment: { LOCALAPPDATA: LOCAL_APP_DATA },
      }),
      SOURCE_DEVDIR,
    );
    assert.equal(
      defaultDistributionWindowsNodeGypDevDir({
        environment: {},
        homeDirectory: String.raw`C:\Users\person`,
      }),
      SOURCE_DEVDIR,
    );
    const result = await cloneDistributionWindowsNodeGypDevDir({
      architecture: 'x64',
      destinationRoot: DESTINATION_DEVDIR,
      environment: { LOCALAPPDATA: LOCAL_APP_DATA },
      filesystem: fixture.mapping.filesystem,
      nodeVersion: `v${VERSION}`,
    });
    assert.equal(result, DESTINATION_DEVDIR);
    assert.equal(
      await fs.readFile(
        fixture.mapping.physicalPath(
          win32.join(DESTINATION_DEVDIR, VERSION, 'include', 'node', 'node_version.h'),
        ),
        'utf8',
      ),
      versionHeader(),
    );
    await assert.rejects(
      () =>
        fs.access(
          fixture.mapping.physicalPath(
            win32.join(DESTINATION_DEVDIR, '23.11.0', 'include', 'node', 'node.h'),
          ),
        ),
      /ENOENT/u,
    );
  } finally {
    fixture.cleanup();
  }
});

test('Windows node-gyp devdir cloning rejects missing or mismatched required evidence', async (t) => {
  await t.test('missing architecture library', async () => {
    const fixture = await createValidFixture();
    try {
      await fs.rm(fixture.mapping.physicalPath(win32.join(fixture.versionRoot, 'x64', 'node.lib')));
      await assert.rejects(
        () =>
          cloneDistributionWindowsNodeGypDevDir({
            architecture: 'x64',
            destinationRoot: DESTINATION_DEVDIR,
            filesystem: fixture.mapping.filesystem,
            nodeVersion: VERSION,
            sourceDevDir: SOURCE_DEVDIR,
          }),
        /missing required x64\/node\.lib/u,
      );
    } finally {
      fixture.cleanup();
    }
  });

  await t.test('mismatched header version', async () => {
    const fixture = await createValidFixture();
    try {
      await writeMappedFile(
        fixture.mapping,
        win32.join(fixture.versionRoot, 'include', 'node', 'node_version.h'),
        versionHeader('24.15.0'),
      );
      await assert.rejects(
        () =>
          cloneDistributionWindowsNodeGypDevDir({
            architecture: 'x64',
            destinationRoot: DESTINATION_DEVDIR,
            filesystem: fixture.mapping.filesystem,
            nodeVersion: VERSION,
            sourceDevDir: SOURCE_DEVDIR,
          }),
        /headers do not match the exact Node version/u,
      );
    } finally {
      fixture.cleanup();
    }
  });

  await t.test('invalid installVersion', async () => {
    const fixture = await createValidFixture();
    try {
      await writeMappedFile(
        fixture.mapping,
        win32.join(fixture.versionRoot, 'installVersion'),
        'not-a-version\n',
      );
      await assert.rejects(
        () =>
          cloneDistributionWindowsNodeGypDevDir({
            architecture: 'x64',
            destinationRoot: DESTINATION_DEVDIR,
            filesystem: fixture.mapping.filesystem,
            nodeVersion: VERSION,
            sourceDevDir: SOURCE_DEVDIR,
          }),
        /installVersion is invalid/u,
      );
    } finally {
      fixture.cleanup();
    }
  });
});

test('Windows node-gyp devdir cloning rejects links and special files', async (t) => {
  await t.test('case-insensitive directory collision', async () => {
    const fixture = await createValidFixture();
    try {
      const collisionPath = win32.join(fixture.versionRoot, 'INCLUDE');
      const includePath = win32.join(fixture.versionRoot, 'include');
      // The synthetic `INCLUDE` entry — AND everything beneath it — resolves to
      // the real `include` directory. A case-INSENSITIVE filesystem (macOS)
      // does this silently, so the original mock only redirected the exact
      // `INCLUDE` path; on a case-SENSITIVE FS (Linux CI) the walk descends into
      // `INCLUDE/node`, `INCLUDE/…`, etc., so the whole subtree must be
      // redirected or lstat/opendir throw ENOENT before the case-collision is
      // detected. Handle either path separator (win32 `\` and posix `/`).
      const toIncludeSubtree = (path) => {
        if (path === collisionPath) return includePath;
        for (const sep of ['/', '\\']) {
          if (path.startsWith(collisionPath + sep)) {
            return includePath + path.slice(collisionPath.length);
          }
        }
        return path;
      };
      const filesystem = {
        ...fixture.mapping.filesystem,
        lstat: async (path) => await fixture.mapping.filesystem.lstat(toIncludeSubtree(path)),
        opendir: async (path) => {
          const handle = await fixture.mapping.filesystem.opendir(toIncludeSubtree(path));
          if (path !== fixture.versionRoot) return handle;
          return {
            async *[Symbol.asyncIterator]() {
              for await (const entry of handle) yield entry;
              yield {
                isDirectory: () => true,
                isFile: () => false,
                isSymbolicLink: () => false,
                name: 'INCLUDE',
              };
            },
          };
        },
      };
      await assert.rejects(
        () =>
          cloneDistributionWindowsNodeGypDevDir({
            architecture: 'x64',
            destinationRoot: DESTINATION_DEVDIR,
            filesystem,
            nodeVersion: VERSION,
            sourceDevDir: SOURCE_DEVDIR,
          }),
        /case-insensitive path collisions/u,
      );
    } finally {
      fixture.cleanup();
    }
  });

  await t.test('symbolic link', async () => {
    const fixture = await createValidFixture();
    try {
      const outside = await writeMappedFile(
        fixture.mapping,
        String.raw`C:\outside\secret.h`,
        'outside\n',
      );
      const link = fixture.mapping.physicalPath(
        win32.join(fixture.versionRoot, 'include', 'node', 'escape.h'),
      );
      await fs.symlink(outside, link);
      await assert.rejects(
        () =>
          cloneDistributionWindowsNodeGypDevDir({
            architecture: 'x64',
            destinationRoot: DESTINATION_DEVDIR,
            filesystem: fixture.mapping.filesystem,
            nodeVersion: VERSION,
            sourceDevDir: SOURCE_DEVDIR,
          }),
        /must not contain symbolic links or junctions/u,
      );
    } finally {
      fixture.cleanup();
    }
  });

  await t.test('special or inconsistent entry', async () => {
    const fixture = await createValidFixture();
    try {
      const special = win32.join(fixture.versionRoot, 'include', 'node', 'special.pipe');
      await writeMappedFile(fixture.mapping, special, 'placeholder\n');
      const filesystem = {
        ...fixture.mapping.filesystem,
        lstat: async (path) => {
          if (path === special) {
            return {
              isDirectory: () => false,
              isFile: () => false,
              isSymbolicLink: () => false,
              size: 0,
            };
          }
          return await fixture.mapping.filesystem.lstat(path);
        },
      };
      await assert.rejects(
        () =>
          cloneDistributionWindowsNodeGypDevDir({
            architecture: 'x64',
            destinationRoot: DESTINATION_DEVDIR,
            filesystem,
            nodeVersion: VERSION,
            sourceDevDir: SOURCE_DEVDIR,
          }),
        /special or inconsistent entry/u,
      );
    } finally {
      fixture.cleanup();
    }
  });
});

test('Windows node-gyp devdir inventory enforces entry, depth, and byte bounds', async (t) => {
  await t.test('entry count', async () => {
    const sourceVersionRoot = win32.join(SOURCE_DEVDIR, VERSION);
    const absent = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const directoryStats = {
      isDirectory: () => true,
      isFile: () => false,
      isSymbolicLink: () => false,
      size: 0,
    };
    const filesystem = {
      lstat: async (path) => {
        if (path === DESTINATION_DEVDIR) throw absent;
        return directoryStats;
      },
      opendir: async (path) => {
        assert.equal(path, sourceVersionRoot);
        return {
          async *[Symbol.asyncIterator]() {
            for (let index = 0; index <= DISTRIBUTION_NODE_GYP_MAX_ENTRIES; index += 1) {
              yield {
                isDirectory: () => false,
                isFile: () => true,
                isSymbolicLink: () => false,
                name: `entry-${String(index).padStart(5, '0')}.h`,
              };
            }
          },
        };
      },
    };
    await assert.rejects(
      () =>
        cloneDistributionWindowsNodeGypDevDir({
          architecture: 'x64',
          destinationRoot: DESTINATION_DEVDIR,
          filesystem,
          nodeVersion: VERSION,
          sourceDevDir: SOURCE_DEVDIR,
        }),
      /bounded entry limit/u,
    );
  });

  await t.test('depth', async () => {
    const fixture = await createValidFixture();
    try {
      const segments = Array.from(
        { length: DISTRIBUTION_NODE_GYP_MAX_DEPTH + 1 },
        (_, index) => `depth-${String(index)}`,
      );
      await writeMappedFile(
        fixture.mapping,
        win32.join(fixture.versionRoot, ...segments, 'too-deep.h'),
        'deep\n',
      );
      await assert.rejects(
        () =>
          cloneDistributionWindowsNodeGypDevDir({
            architecture: 'x64',
            destinationRoot: DESTINATION_DEVDIR,
            filesystem: fixture.mapping.filesystem,
            nodeVersion: VERSION,
            sourceDevDir: SOURCE_DEVDIR,
          }),
        /bounded depth limit/u,
      );
    } finally {
      fixture.cleanup();
    }
  });

  await t.test('per-file bytes', async () => {
    const fixture = await createValidFixture();
    try {
      const oversized = await writeMappedFile(
        fixture.mapping,
        win32.join(fixture.versionRoot, 'oversized.bin'),
        '',
      );
      await fs.truncate(oversized, DISTRIBUTION_NODE_GYP_MAX_FILE_BYTES + 1);
      await assert.rejects(
        () =>
          cloneDistributionWindowsNodeGypDevDir({
            architecture: 'x64',
            destinationRoot: DESTINATION_DEVDIR,
            filesystem: fixture.mapping.filesystem,
            nodeVersion: VERSION,
            sourceDevDir: SOURCE_DEVDIR,
          }),
        /contains an oversized file/u,
      );
    } finally {
      fixture.cleanup();
    }
  });

  await t.test('total bytes', async () => {
    const fixture = await createValidFixture();
    try {
      for (let index = 0; index < 5; index += 1) {
        const sparse = await writeMappedFile(
          fixture.mapping,
          win32.join(fixture.versionRoot, `sparse-${String(index)}.bin`),
          '',
        );
        await fs.truncate(sparse, Math.floor(DISTRIBUTION_NODE_GYP_MAX_TOTAL_BYTES / 5) + 1);
      }
      await assert.rejects(
        () =>
          cloneDistributionWindowsNodeGypDevDir({
            architecture: 'x64',
            destinationRoot: DESTINATION_DEVDIR,
            filesystem: fixture.mapping.filesystem,
            nodeVersion: VERSION,
            sourceDevDir: SOURCE_DEVDIR,
          }),
        /bounded byte limit/u,
      );
    } finally {
      fixture.cleanup();
    }
  });
});

test('Windows node-gyp devdir cloning removes partial destinations after copy failure', async () => {
  const fixture = await createValidFixture();
  try {
    let copies = 0;
    const filesystem = {
      ...fixture.mapping.filesystem,
      copyFile: async (...arguments_) => {
        copies += 1;
        if (copies === 2) throw new Error('copy failed');
        return await fixture.mapping.filesystem.copyFile(...arguments_);
      },
    };
    await assert.rejects(
      () =>
        cloneDistributionWindowsNodeGypDevDir({
          architecture: 'x64',
          destinationRoot: DESTINATION_DEVDIR,
          filesystem,
          nodeVersion: VERSION,
          sourceDevDir: SOURCE_DEVDIR,
        }),
      /copy failed/u,
    );
    await assert.rejects(
      () => fs.access(fixture.mapping.physicalPath(DESTINATION_DEVDIR)),
      /ENOENT/u,
    );
  } finally {
    fixture.cleanup();
  }
});
