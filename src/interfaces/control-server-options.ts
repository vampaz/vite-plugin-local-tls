import type { RouteRegistry } from '../route-registry.js';

export interface ControlServerOptions {
  socketPath: string;
  registry: RouteRegistry;
}
