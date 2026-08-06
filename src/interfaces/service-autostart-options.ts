export interface ServiceAutoStartOptions {
  interactive?: boolean;
  onAuthorizationWait?: () => void;
  isTrusted: () => Promise<boolean>;
  trust: () => Promise<void>;
  isServiceCurrent?: () => Promise<boolean>;
  installService: () => Promise<void>;
}
