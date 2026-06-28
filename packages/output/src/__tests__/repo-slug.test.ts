import { describe, it, expect } from 'vitest';

import { repoSlugFromIdentity } from '../sink/repo-slug.js';

describe('repoSlugFromIdentity', () => {
  it('parses an scp-style remote (git@host:org/repo.git)', () => {
    expect(repoSlugFromIdentity({ remoteUrl: 'git@github.com:opensip-ai/opensip-cli.git' })).toBe(
      'opensip-ai/opensip-cli',
    );
  });

  it('parses an https URL-style remote (strips scheme + .git)', () => {
    expect(
      repoSlugFromIdentity({ remoteUrl: 'https://github.com/opensip-ai/opensip-cli.git' }),
    ).toBe('opensip-ai/opensip-cli');
  });

  it('parses an https remote without a .git suffix', () => {
    expect(repoSlugFromIdentity({ remoteUrl: 'https://github.com/org/repo' })).toBe('org/repo');
  });

  it('parses an ssh:// URL remote', () => {
    expect(repoSlugFromIdentity({ remoteUrl: 'ssh://git@github.com/org/repo.git' })).toBe(
      'org/repo',
    );
  });

  it('takes the last two path segments for nested (GitLab-style) groups', () => {
    expect(repoSlugFromIdentity({ remoteUrl: 'https://gitlab.com/group/subgroup/repo.git' })).toBe(
      'subgroup/repo',
    );
  });

  it('handles a trailing slash', () => {
    expect(repoSlugFromIdentity({ remoteUrl: 'https://github.com/org/repo/' })).toBe('org/repo');
  });

  it('prefers an explicit id that already looks like a slug', () => {
    expect(
      repoSlugFromIdentity({ id: 'org/repo', remoteUrl: 'git@github.com:other/thing.git' }),
    ).toBe('org/repo');
  });

  it('ignores a non-slug id and falls back to the remote', () => {
    expect(
      repoSlugFromIdentity({ id: 'not-a-slug', remoteUrl: 'git@github.com:org/repo.git' }),
    ).toBe('org/repo');
  });

  it('returns undefined when nothing parses', () => {
    expect(repoSlugFromIdentity({})).toBeUndefined();
    expect(repoSlugFromIdentity({ remoteUrl: '' })).toBeUndefined();
    expect(repoSlugFromIdentity({ remoteUrl: 'not a url' })).toBeUndefined();
    expect(repoSlugFromIdentity({ remoteUrl: 'https://github.com/onlyorg' })).toBeUndefined();
  });

  it('never throws on garbage input', () => {
    expect(() => repoSlugFromIdentity({ remoteUrl: ':::' })).not.toThrow();
    expect(() => repoSlugFromIdentity({ id: '' })).not.toThrow();
  });
});
