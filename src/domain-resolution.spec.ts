import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  compactDomainLabel,
  normalizeBaseDomain,
  normalizeDomains,
  resolveBaseDomain,
  resolveLocalTlsDomains,
  resolveLocalTlsUrl,
  sanitizeDomainLabel,
} from './domain-resolution.js';

describe('domain resolution', () => {
  it('normalizes and deduplicates explicit domains', () => {
    expect(normalizeDomains([' One.Localhost ', '', 'two.localhost', 'one.localhost'])).toEqual([
      'one.localhost',
      'two.localhost',
    ]);
    expect(resolveLocalTlsDomains({ domain: '  ' })).toBeNull();
  });

  it('normalizes base and loopback domains', () => {
    expect(normalizeBaseDomain(' .Local.Example. ')).toBe('local.example');
    expect(resolveBaseDomain({})).toBe('localhost');
    expect(resolveBaseDomain({ loopbackDomain: 'localtest.me' })).toBe('localtest.me');
    expect(resolveBaseDomain({ loopbackDomain: 'lvh.me' })).toBe('lvh.me');
    expect(resolveBaseDomain({ loopbackDomain: 'nip.io' })).toBe('127.0.0.1.nip.io');
    expect(resolveBaseDomain({ baseDomain: '  ' })).toBeNull();
  });

  it('derives checkout-aware domains and optional instance labels', () => {
    expect(resolveLocalTlsDomains({ repo: 'My Repo', branch: 'feature/editor' })).toEqual([
      'my-repo.feature-editor.localhost',
    ]);
    expect(
      resolveLocalTlsDomains({
        repo: 'My Repo',
        branch: 'feature/editor',
        instanceLabel: 'Copy 2',
        baseDomain: '.Local.Example.',
      }),
    ).toEqual(['my-repo.feature-editor.copy-2.local.example']);
  });

  it('sanitizes labels and rejects empty derived labels', () => {
    expect(sanitizeDomainLabel(' Feature///ONE__ ')).toBe('feature-one');
    expect(resolveLocalTlsDomains({ repo: '---', branch: 'main' })).toBeNull();
    expect(resolveLocalTlsDomains({ repo: 'app', branch: 'main', instanceLabel: '__' })).toBeNull();
  });

  it('compacts long labels deterministically and collision-resistently', () => {
    const longLabel = `feature-${'tracking-'.repeat(12)}`;
    const expectedHash = createHash('sha1')
      .update(sanitizeDomainLabel(longLabel))
      .digest('hex')
      .slice(0, 10);
    const compacted = compactDomainLabel(longLabel);

    expect(compacted).toHaveLength(63);
    expect(compacted).toMatch(new RegExp(`-${expectedHash}$`));
    expect(compactDomainLabel(longLabel)).toBe(compacted);
    expect(compactDomainLabel(`${longLabel}different`)).not.toBe(compacted);
  });

  it('returns a URL only for one resolved domain', () => {
    expect(resolveLocalTlsUrl({ repo: 'app', branch: 'main' })).toBe('https://app.main.localhost');
    expect(resolveLocalTlsUrl({ domain: ['one.localhost', 'two.localhost'] })).toBeNull();
    expect(resolveLocalTlsUrl({ domain: [] })).toBeNull();
  });
});
