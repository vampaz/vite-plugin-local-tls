import type { PluginOption } from 'vite';

export { resolveLocalTlsDomains, resolveLocalTlsUrl } from './domain-resolution.js';
export { resolveCheckout } from './checkout-resolution.js';
export type { CheckoutInfo } from './interfaces/checkout-info.js';
export type { LocalTlsDomainOptions, LoopbackDomain } from './interfaces/plugin-options.js';

export default function viteLocalTlsPlugin(): PluginOption {
  return {
    name: 'vite-plugin-local-tls',
  };
}
