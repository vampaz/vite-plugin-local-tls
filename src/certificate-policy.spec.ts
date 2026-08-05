import { describe, expect, it } from 'vitest';
import { internalTlsCompatibilityCases } from '../tests/fixtures/current-contract.js';
import { resolveCertificatePolicy } from './certificate-policy.js';

describe('internalTls compatibility policy', () => {
  it.each(internalTlsCompatibilityCases)(
    'maps $input.kind with internalTls=$input.internalTls to $outcome',
    ({ input, outcome }) => {
      const hostname =
        input.kind === 'local'
          ? 'app.localhost'
          : input.kind === 'loopback'
            ? 'app.localtest.me'
            : 'app.example.test';
      if (outcome === 'import-required') {
        expect(() => resolveCertificatePolicy(hostname, input.internalTls)).toThrow(/cert import/);
        return;
      }
      expect(resolveCertificatePolicy(hostname, input.internalTls)).toBe('local-ca');
    },
  );

  it('selects an imported exact-host certificate for a custom domain with internal TLS disabled', () => {
    expect(resolveCertificatePolicy('app.example.test', false, true)).toBe('imported');
  });
});
