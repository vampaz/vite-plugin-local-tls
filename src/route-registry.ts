import type { RouteRegistration } from './interfaces/route-registration.js';

export type ActiveRoute = RouteRegistration & {
  registeredAt: number;
  leaseId: string;
};

export type RouteTakeover = {
  hostname: string;
  ownerToken: string;
  replacementOwnerToken: string;
};

export type RouteRegistrationResult = {
  status: 'claimed' | 'replaced';
  route: ActiveRoute;
  previousRoute?: ActiveRoute;
};

type RouteLostListener = (takeover: RouteTakeover) => void;

export class RouteRegistry {
  readonly #routes = new Map<string, ActiveRoute>();
  readonly #listeners = new Map<string, Set<RouteLostListener>>();

  get size(): number {
    return this.#routes.size;
  }

  get(hostname: string): ActiveRoute | undefined {
    return this.#routes.get(hostname);
  }

  list(): ActiveRoute[] {
    return [...this.#routes.values()];
  }

  register(registration: RouteRegistration, leaseId = 'direct'): RouteRegistrationResult {
    const previousRoute = this.#routes.get(registration.hostname);
    const route: ActiveRoute = { ...registration, registeredAt: Date.now(), leaseId };
    this.#routes.set(registration.hostname, route);

    if (previousRoute && previousRoute.ownerToken !== registration.ownerToken) {
      const takeover: RouteTakeover = {
        hostname: registration.hostname,
        ownerToken: previousRoute.ownerToken,
        replacementOwnerToken: registration.ownerToken,
      };
      for (const listener of this.#listeners.get(previousRoute.ownerToken) ?? []) {
        listener(takeover);
      }
      return { status: 'replaced', route, previousRoute };
    }

    return { status: 'claimed', route };
  }

  registerMany(registrations: RouteRegistration[], leaseId = 'direct'): RouteRegistrationResult[] {
    return registrations.map((registration) => this.register(registration, leaseId));
  }

  unregister(hostname: string, ownerToken: string, leaseId?: string): boolean {
    const route = this.#routes.get(hostname);
    if (!route || route.ownerToken !== ownerToken || (leaseId && route.leaseId !== leaseId)) {
      return false;
    }
    return this.#routes.delete(hostname);
  }

  unregisterMany(hostnames: string[], ownerToken: string, leaseId?: string): string[] {
    return hostnames.filter((hostname) => this.unregister(hostname, ownerToken, leaseId));
  }

  unregisterOwner(ownerToken: string, leaseId?: string): string[] {
    const removedHostnames: string[] = [];
    for (const [hostname, route] of this.#routes) {
      if (
        route.ownerToken === ownerToken &&
        (!leaseId || route.leaseId === leaseId) &&
        this.#routes.delete(hostname)
      ) {
        removedHostnames.push(hostname);
      }
    }
    return removedHostnames;
  }

  activeHostnames(ownerToken: string, hostnames: string[], leaseId?: string): string[] {
    return hostnames.filter((hostname) => {
      const route = this.#routes.get(hostname);
      return route?.ownerToken === ownerToken && (!leaseId || route.leaseId === leaseId);
    });
  }

  subscribeToRouteLoss(ownerToken: string, listener: RouteLostListener): () => void {
    const listeners = this.#listeners.get(ownerToken) ?? new Set<RouteLostListener>();
    listeners.add(listener);
    this.#listeners.set(ownerToken, listeners);
    return this.#unsubscribe.bind(this, ownerToken, listener);
  }

  #unsubscribe(ownerToken: string, listener: RouteLostListener): void {
    const listeners = this.#listeners.get(ownerToken);
    listeners?.delete(listener);
    if (listeners?.size === 0) {
      this.#listeners.delete(ownerToken);
    }
  }
}
