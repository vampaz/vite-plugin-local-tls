import { expect, test } from './fixtures.js';
import { resolveE2eAuthority, verifyE2eAuthorityTrust } from '../fixtures/server-process.js';

test('the shared e2e certificate authority is trusted by the operating system', async () => {
  const authority = await resolveE2eAuthority({ interactive: true });
  await expect(verifyE2eAuthorityTrust(authority.record)).resolves.toBe(true);
});
