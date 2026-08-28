import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';

const packageVersion = (
  JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts', 'src/testing.ts'],
  format: ['esm'],
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  target: 'node22',
  define: {
    __VITE_LOCAL_TLS_PACKAGE_VERSION__: JSON.stringify(packageVersion),
  },
});
