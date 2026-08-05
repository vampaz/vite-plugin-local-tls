export { resolveLocalTlsDomains, resolveLocalTlsUrl } from './domain-resolution.js';
export { resolveCheckout } from './checkout-resolution.js';
export type { CheckoutInfo } from './interfaces/checkout-info.js';
export type {
  LocalTlsDomainOptions,
  LocalTlsPluginOptions,
  LoopbackDomain,
} from './interfaces/plugin-options.js';
export { createViteLocalTlsPlugin, viteLocalTlsPlugin } from './plugin.js';

export { viteLocalTlsPlugin as default } from './plugin.js';
