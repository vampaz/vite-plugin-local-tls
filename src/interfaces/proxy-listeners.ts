import type { Server } from 'node:net';

export interface ProxyListenerOptions {
  port?: number;
  createServer: () => Server;
}

export interface ProxyListenerSet {
  port: number;
  ipv4: Server;
  ipv6: Server;
  close: () => Promise<void>;
}
