import { describe, expect, it, vi } from 'vitest';
import type { RouteRegistration } from './interfaces/route-registration.js';
import { RouteRegistry } from './route-registry.js';

function route(hostname: string, ownerToken: string): RouteRegistration {
  return {
    hostname,
    ownerToken,
    upstreamHost: '127.0.0.1',
    upstreamPort: 5173,
  };
}

describe('RouteRegistry', () => {
  it('stores independent hostname claims', () => {
    const registry = new RouteRegistry();
    registry.registerMany([
      route('app.localhost', 'owner-token-00000001'),
      route('api.localhost', 'owner-token-00000001'),
    ]);

    expect(registry.list().map(({ hostname }) => hostname)).toEqual([
      'app.localhost',
      'api.localhost',
    ]);
  });

  it('atomically gives a reused hostname to the latest owner and notifies the old owner', () => {
    const registry = new RouteRegistry();
    const lostRoute = vi.fn();
    registry.subscribeToRouteLoss('owner-token-00000001', lostRoute);
    registry.register(route('app.localhost', 'owner-token-00000001'));

    const result = registry.register(route('app.localhost', 'owner-token-00000002'));

    expect(result.status).toBe('replaced');
    expect(registry.get('app.localhost')?.ownerToken).toBe('owner-token-00000002');
    expect(lostRoute).toHaveBeenCalledWith({
      hostname: 'app.localhost',
      ownerToken: 'owner-token-00000001',
      replacementOwnerToken: 'owner-token-00000002',
    });
  });

  it('preserves sibling hostnames during partial takeover', () => {
    const registry = new RouteRegistry();
    registry.registerMany([
      route('app.localhost', 'owner-token-00000001'),
      route('api.localhost', 'owner-token-00000001'),
    ]);

    registry.register(route('app.localhost', 'owner-token-00000002'));

    expect(registry.get('app.localhost')?.ownerToken).toBe('owner-token-00000002');
    expect(registry.get('api.localhost')?.ownerToken).toBe('owner-token-00000001');
  });

  it('requires the current owner token for cleanup', () => {
    const registry = new RouteRegistry();
    registry.register(route('app.localhost', 'owner-token-00000001'));
    registry.register(route('app.localhost', 'owner-token-00000002'));

    expect(registry.unregister('app.localhost', 'owner-token-00000001')).toBe(false);
    expect(registry.get('app.localhost')).toBeDefined();
    expect(registry.unregister('app.localhost', 'owner-token-00000002')).toBe(true);
  });

  it('removes only currently owned routes on owner disconnect', () => {
    const registry = new RouteRegistry();
    registry.registerMany([
      route('app.localhost', 'owner-token-00000001'),
      route('api.localhost', 'owner-token-00000001'),
    ]);
    registry.register(route('app.localhost', 'owner-token-00000002'));

    expect(registry.unregisterOwner('owner-token-00000001')).toEqual(['api.localhost']);
    expect(registry.get('app.localhost')?.ownerToken).toBe('owner-token-00000002');
  });

  it('reports only live claims during heartbeat checks', () => {
    const registry = new RouteRegistry();
    registry.register(route('app.localhost', 'owner-token-00000001'));

    expect(
      registry.activeHostnames('owner-token-00000001', ['app.localhost', 'lost.localhost']),
    ).toEqual(['app.localhost']);
  });
});
