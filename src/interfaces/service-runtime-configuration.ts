export interface ServiceRuntimeConfiguration {
  version: 1;
  owner: '@vampaz/vite-plugin-local-tls';
  namespace: string;
  controlSocket: string | null;
}
