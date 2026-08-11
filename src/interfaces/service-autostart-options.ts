export interface ServiceAutoStartOptions {
  interactive?: boolean;
  onAuthorizationWait?: () => void;
  isTrusted: () => Promise<boolean>;
  trust: () => Promise<void>;
  installService: () => Promise<void>;
}
