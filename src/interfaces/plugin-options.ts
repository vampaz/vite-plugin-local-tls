export type LoopbackDomain = 'localtest.me' | 'lvh.me' | 'nip.io';

export interface LocalTlsDomainOptions {
  domain?: string | string[];
  baseDomain?: string;
  loopbackDomain?: LoopbackDomain;
  repo?: string;
  branch?: string;
  instanceLabel?: string;
}

export interface LocalTlsPluginOptions extends LocalTlsDomainOptions {
  cors?: string;
  controlSocket?: string;
  serviceNamespace?: string;
  /** @deprecated Use serviceNamespace. */
  serverName?: string;
  /** @deprecated The local TLS service has no HTTP Admin API. Use controlSocket if needed. */
  caddyApiUrl?: string;
  /** @deprecated The local TLS service has no HTTP Admin API or Origin policy. */
  caddyAdminOrigin?: string;
  internalTls?: boolean;
  upstreamHostHeader?: string;
}

/** @deprecated Use LocalTlsPluginOptions. */
export type ViteCaddyTlsPluginOptions = LocalTlsPluginOptions;
