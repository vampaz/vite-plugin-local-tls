import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.spec.ts',
      'tests/contract/**/*.spec.ts',
      'tests/package/**/*.spec.ts',
      'tests/release/**/*.spec.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/interfaces/**/*.ts'],
    },
  },
});
