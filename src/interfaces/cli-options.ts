export interface CliContext {
  namespace: string;
}

export interface CliCertificateImportRequest extends CliContext {
  hostname: string;
  certificatePath: string;
  keyPath: string;
  chainPath?: string;
}

export interface CliCertificateRequest extends CliContext {
  hostname: string;
}

export interface CliCleanRequest extends CliContext {
  removeAuthority: boolean;
}

export interface CliProxyStartRequest extends CliContext {
  serviceMode: boolean;
}

export interface CliActions {
  trust: (context: CliContext) => Promise<unknown>;
  untrust: (context: CliContext) => Promise<unknown>;
  certificateImport: (request: CliCertificateImportRequest) => Promise<unknown>;
  certificateList: (context: CliContext) => Promise<unknown>;
  certificateRemove: (request: CliCertificateRequest) => Promise<unknown>;
  doctor: (context: CliContext) => Promise<unknown>;
  proxyStart: (request: CliProxyStartRequest) => Promise<unknown>;
  proxyStop: (context: CliContext) => Promise<unknown>;
  proxyStatus: (context: CliContext) => Promise<unknown>;
  serviceInstall: (context: CliContext) => Promise<unknown>;
  serviceUninstall: (context: CliContext) => Promise<unknown>;
  clean: (request: CliCleanRequest) => Promise<unknown>;
}

export interface CliIo {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
}

export interface RunCliOptions {
  actions?: CliActions;
  io?: CliIo;
}
