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
  internalTls?: boolean;
  upstreamHostHeader?: string;
}
