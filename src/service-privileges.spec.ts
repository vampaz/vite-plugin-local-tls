import { describe, expect, it, vi } from 'vitest';
import type { ServicePrivilegeOperations } from './interfaces/service-privilege-operations.js';
import { dropServicePrivileges, transferServiceOwnership } from './service-privileges.js';

describe('service privilege drop', () => {
  it('transfers ownership, clears supplementary groups, and drops group before user', async () => {
    let uid = 0;
    let gid = 0;
    const calls: string[] = [];
    const operations: ServicePrivilegeOperations = {
      changeOwnership: vi.fn(async (filePath, owner, group) => {
        calls.push(`chown:${filePath}:${owner}:${group}`);
      }),
      getUserId(): number {
        return uid;
      },
      getGroupId(): number {
        return gid;
      },
      clearSupplementaryGroups(): void {
        calls.push('setgroups');
      },
      setGroupId(value): void {
        calls.push(`setgid:${value}`);
        gid = value;
      },
      setUserId(value): void {
        calls.push(`setuid:${value}`);
        uid = value;
      },
    };

    await dropServicePrivileges({ uid: 501, gid: 20 }, ['/state', '/runtime'], operations);

    expect(calls).toEqual([
      'chown:/state:501:20',
      'chown:/runtime:501:20',
      'setgroups',
      'setgid:20',
      'setuid:501',
    ]);
  });

  it('refuses to perform a partial drop from an unprivileged process', async () => {
    const operations: ServicePrivilegeOperations = {
      changeOwnership: vi.fn(async () => undefined),
      getUserId: () => 501,
      getGroupId: () => 20,
      clearSupplementaryGroups: vi.fn(),
      setGroupId: vi.fn(),
      setUserId: vi.fn(),
    };

    await expect(
      dropServicePrivileges({ uid: 501, gid: 20 }, ['/state'], operations),
    ).rejects.toThrow(/must start as root/);
    expect(operations.changeOwnership).not.toHaveBeenCalled();
  });

  it('can transfer generated files before the privileged bind attempt', async () => {
    const changeOwnership = vi.fn(async () => undefined);
    const operations: ServicePrivilegeOperations = {
      changeOwnership,
      getUserId: () => 0,
      getGroupId: () => 0,
      clearSupplementaryGroups: vi.fn(),
      setGroupId: vi.fn(),
      setUserId: vi.fn(),
    };

    await transferServiceOwnership(
      { uid: 501, gid: 20 },
      ['/state/ca.json', '/state/certificates'],
      operations,
    );

    expect(changeOwnership).toHaveBeenNthCalledWith(1, '/state/ca.json', 501, 20);
    expect(changeOwnership).toHaveBeenNthCalledWith(2, '/state/certificates', 501, 20);
    expect(operations.setUserId).not.toHaveBeenCalled();
  });
});
