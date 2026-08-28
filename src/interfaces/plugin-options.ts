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
  /** @deprecated The ordinary port-443 runtime always uses its canonical control channel. */
  controlSocket?: string;
  /** @deprecated The ordinary port-443 runtime always uses the canonical service namespace. */
  serviceNamespace?: string;
  /** @deprecated The ordinary port-443 runtime always uses the canonical service namespace. */
  serverName?: string;
  /** @deprecated The local TLS service has no HTTP Admin API. */
  caddyApiUrl?: string;
  /** @deprecated The local TLS service has no HTTP Admin API or Origin policy. */
  caddyAdminOrigin?: string;
  internalTls?: boolean;
  upstreamHostHeader?: string;
}

/** @deprecated Use LocalTlsPluginOptions. */
export type ViteCaddyTlsPluginOptions = LocalTlsPluginOptions;
