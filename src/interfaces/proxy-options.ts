import type { RouteRegistry } from '../route-registry.js';

export interface ProxyOptions {
  registry: RouteRegistry;
  publicProtocol?: 'http' | 'https';
  publicPort?: number;
  proxyMarker?: string;
}
