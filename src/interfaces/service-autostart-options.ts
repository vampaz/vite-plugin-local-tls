export interface ServiceAutoStartOptions {
  interactive?: boolean;
  authorizationTimeoutMs?: number;
  isTrusted: () => Promise<boolean>;
  trust: () => Promise<void>;
  installService: () => Promise<void>;
}
