export interface ServicePrivilegeOperations {
  changeOwnership: (filePath: string, uid: number, gid: number) => Promise<void>;
  getUserId: () => number;
  getGroupId: () => number;
  clearSupplementaryGroups: () => void;
  setGroupId: (gid: number) => void;
  setUserId: (uid: number) => void;
}
