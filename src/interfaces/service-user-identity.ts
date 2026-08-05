export interface ServiceUserIdentity {
  uid: number;
  gid: number;
}

export type DropServicePrivileges = (
  identity: ServiceUserIdentity,
  ownedPaths: string[],
) => Promise<void>;

export type TransferServiceOwnership = (
  identity: ServiceUserIdentity,
  ownedPaths: string[],
) => Promise<void>;
