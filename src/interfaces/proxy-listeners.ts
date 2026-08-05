import type { Server } from 'node:net';
import type { CertificateContextOptions } from './certificate-context-options.js';

export type ProxyListenerServer = Server & {
  addContext?: (hostname: string, context: CertificateContextOptions) => void;
};

export interface ProxyListenerOptions {
  port?: number;
  createServer: () => ProxyListenerServer;
}

export interface ProxyListenerSet {
  port: number;
  ipv4: ProxyListenerServer;
  ipv6: ProxyListenerServer;
  close: () => Promise<void>;
}
