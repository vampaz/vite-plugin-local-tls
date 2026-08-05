import { describe, expect, it } from 'vitest';
import {
  featureParityCases,
  internalTlsCompatibilityCases,
  legacyOptionContract,
} from '../fixtures/current-contract.js';
import { domainCases } from '../fixtures/domain-cases.js';

describe('legacy feature contract', () => {
  it('contains a unique evidence case for every parity-ledger capability', () => {
    const identifiers = featureParityCases.map(({ id }) => id);

    expect(identifiers).toHaveLength(32);
    expect(new Set(identifiers).size).toBe(identifiers.length);
    expect(featureParityCases.every(({ evidence }) => evidence.length > 8)).toBe(true);
  });

  it('preserves or explicitly maps every public legacy option', () => {
    expect(legacyOptionContract.map(({ name }) => name)).toEqual([
      'domain',
      'baseDomain',
      'loopbackDomain',
      'repo',
      'branch',
      'instanceLabel',
      'cors',
      'internalTls',
      'upstreamHostHeader',
      'caddyApiUrl',
      'serverName',
      'caddyAdminOrigin',
    ]);
    expect(legacyOptionContract.filter(({ outcome }) => outcome === 'removed')).toEqual([
      { name: 'caddyAdminOrigin', outcome: 'removed', replacement: null },
    ]);
  });

  it('freezes all internal TLS input and hostname combinations', () => {
    expect(internalTlsCompatibilityCases).toHaveLength(9);
    expect(
      internalTlsCompatibilityCases.find(
        ({ input }) => input.kind === 'custom' && input.internalTls === false,
      ),
    ).toMatchObject({ outcome: 'import-required', legacyForcedPolicy: false });
  });

  it('keeps representative domain outcomes as backend-neutral data', () => {
    expect(domainCases.map(({ name }) => name)).toEqual([
      'explicit domain normalization',
      'default checkout domain',
      'custom base domain normalization',
      'same branch instance label',
      'localtest.me loopback',
      'lvh.me loopback',
      'nip.io loopback',
    ]);
  });
});
