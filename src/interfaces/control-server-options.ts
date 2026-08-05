import type { RouteRegistry } from '../route-registry.js';
import type { RouteRegistration } from './route-registration.js';

export interface ControlServerOptions {
  socketPath: string;
  registry: RouteRegistry;
  validateRoutes?: (routes: RouteRegistration[]) => Promise<void> | void;
  onStopRequested?: () => void;
}
