import { test as base, expect } from '@playwright/test';
import {
  disposeE2eContext,
  prepareE2eContext,
  type E2eContext,
} from '../fixtures/server-process.js';

export const test = base.extend<{}, { e2e: E2eContext }>({
  e2e: [
    async ({ browserName }, use): Promise<void> => {
      void browserName;
      const context = await prepareE2eContext();
      await use(context);
      await disposeE2eContext(context);
    },
    { scope: 'worker' },
  ],
});

export { expect };
