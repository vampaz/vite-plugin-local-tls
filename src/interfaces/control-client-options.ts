import type { RouteTakeover } from '../route-registry.js';

export interface ControlClientOptions {
  socketPath: string;
  ownerToken?: string;
  reconnectAttempts?: number;
  retryDelayMs?: number;
  requestTimeoutMs?: number;
  onRouteLost?: (takeover: RouteTakeover) => void;
  onDisconnect?: (error?: Error) => void;
}
