export type TrustTool =
  | 'security'
  | 'update-ca-certificates'
  | 'update-ca-trust'
  | 'trust'
  | 'certutil';

export interface SystemRequirements {
  platform: NodeJS.Platform;
  isWsl: boolean;
  opensslPath: string | null;
  gitPath: string | null;
  trustTool: TrustTool | null;
  trustToolPath: string | null;
  missing: string[];
}
