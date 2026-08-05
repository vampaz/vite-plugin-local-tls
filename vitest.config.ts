import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.spec.ts',
      'tests/contract/**/*.spec.ts',
      'tests/package/**/*.spec.ts',
      'tests/release/**/*.spec.ts',
    ],
  },
});
