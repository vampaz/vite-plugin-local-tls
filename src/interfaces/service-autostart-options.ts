export interface ServiceAutoStartOptions {
  interactive?: boolean;
  authorizationTimeoutMs?: number;
  isTrusted: () => Promise<boolean>;
  trust: () => Promise<void>;
  isServiceCurrent?: () => Promise<boolean>;
  installService: () => Promise<void>;
}
