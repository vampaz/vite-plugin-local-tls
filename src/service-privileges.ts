import { chown } from 'node:fs/promises';
import type { ServicePrivilegeOperations } from './interfaces/service-privilege-operations.js';
import type { ServiceUserIdentity } from './interfaces/service-user-identity.js';

async function changeOwnership(filePath: string, identity: ServiceUserIdentity): Promise<void> {
  await chown(filePath, identity.uid, identity.gid).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  });
}

function defaultOperations(): ServicePrivilegeOperations {
  const { getgid, getuid, setgid, setgroups, setuid } = process;
  if (!getgid || !getuid || !setgid || !setgroups || !setuid) {
    throw new Error('This Node.js runtime cannot drop Unix service privileges.');
  }
  return {
    async changeOwnership(filePath, uid, gid): Promise<void> {
      await changeOwnership(filePath, { uid, gid });
    },
    getUserId: getuid,
    getGroupId: getgid,
    clearSupplementaryGroups(): void {
      setgroups([]);
    },
    setGroupId: setgid,
    setUserId: setuid,
  };
}

export async function dropServicePrivileges(
  identity: ServiceUserIdentity,
  ownedPaths: string[],
  operations = defaultOperations(),
): Promise<void> {
  if (process.platform === 'win32') {
    throw new Error('Unix service privilege dropping is unavailable on Windows.');
  }
  if (operations.getUserId() !== 0) {
    throw new Error('The privileged local TLS service must start as root before dropping access.');
  }
  for (const filePath of ownedPaths) {
    await operations.changeOwnership(filePath, identity.uid, identity.gid);
  }
  operations.clearSupplementaryGroups();
  operations.setGroupId(identity.gid);
  operations.setUserId(identity.uid);
  if (operations.getUserId() !== identity.uid || operations.getGroupId() !== identity.gid) {
    throw new Error('The local TLS service could not drop root privileges.');
  }
}

export async function transferServiceOwnership(
  identity: ServiceUserIdentity,
  ownedPaths: string[],
  operations = defaultOperations(),
): Promise<void> {
  for (const filePath of ownedPaths) {
    await operations.changeOwnership(filePath, identity.uid, identity.gid);
  }
}
