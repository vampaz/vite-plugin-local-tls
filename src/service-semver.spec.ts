import { describe, expect, it } from 'vitest';
import { compareServiceVersions } from './service-version.js';

describe('service version ordering', () => {
  it.each([
    ['1.2.3', '1.2.3', 0],
    ['1.2.4', '1.2.3', 1],
    ['1.3.0', '1.2.99', 1],
    ['2.0.0', '1.99.99', 1],
    ['1.0.0-beta.2', '1.0.0-beta.10', -1],
    ['1.0.0-beta.10', '1.0.0', -1],
    ['1.0.0-99999999999999999999', '1.0.0-100000000000000000000', -1],
    ['1.0.0', '1.0.0-rc.1', 1],
    ['1.0.0+build.2', '1.0.0+build.1', 0],
  ] as const)('compares %s with %s', (left, right, expected) => {
    expect(compareServiceVersions(left, right)).toBe(expected);
  });

  it.each(['1', '1.2', 'v1.2.3', '1.2.3.4', '1.02.3', '1.2.3-01', 'not-a-version'])(
    'rejects an invalid version instead of guessing: %s',
    (version) => {
      expect(compareServiceVersions(version, '1.2.3')).toBeNull();
      expect(compareServiceVersions('1.2.3', version)).toBeNull();
    },
  );
});
