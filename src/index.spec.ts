import { describe, expect, it } from 'vitest';
import viteLocalTlsPlugin from './index.js';

describe('viteLocalTlsPlugin', () => {
  it('exposes the Vite plugin identity', () => {
    expect(viteLocalTlsPlugin()).toMatchObject({
      name: 'vite-plugin-local-tls',
    });
  });
});
