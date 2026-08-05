export interface ServiceState {
  version: 1;
  pid: number;
  namespace: string;
  socketPath: string;
  startedAt: string;
  protocolVersion: number;
  port: number;
  caFingerprint: string;
}
