import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { encodeControlMessage } from './control-protocol.js';
import type { ControlClientOptions } from './interfaces/control-client-options.js';
import type { ClientControlMessage, ServerControlMessage } from './interfaces/control-message.js';
import type { RouteRegistration } from './interfaces/route-registration.js';

export type OwnedRouteInput = Omit<RouteRegistration, 'ownerToken'>;

type PendingRequest = {
  resolve: (message: ServerControlMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class ControlClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ControlClientError';
    this.code = code;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function connectSocket(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);

    function handleError(error: Error): void {
      socket.destroy();
      reject(error);
    }

    socket.once('error', handleError);
    socket.once('connect', () => {
      socket.off('error', handleError);
      resolve(socket);
    });
  });
}

export class ControlClient {
  readonly ownerToken: string;
  readonly #options: Required<
    Pick<
      ControlClientOptions,
      'socketPath' | 'reconnectAttempts' | 'retryDelayMs' | 'requestTimeoutMs'
    >
  > &
    Pick<ControlClientOptions, 'onRouteLost' | 'onDisconnect'>;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #claimedHostnames = new Set<string>();
  #socket: Socket | null = null;
  #buffer = '';
  #closing = false;

  constructor(options: ControlClientOptions) {
    this.ownerToken = options.ownerToken ?? randomUUID();
    this.#options = {
      socketPath: options.socketPath,
      reconnectAttempts: options.reconnectAttempts ?? 3,
      retryDelayMs: options.retryDelayMs ?? 100,
      requestTimeoutMs: options.requestTimeoutMs ?? 5000,
      onRouteLost: options.onRouteLost,
      onDisconnect: options.onDisconnect,
    };
  }

  get connected(): boolean {
    return Boolean(this.#socket && !this.#socket.destroyed);
  }

  get claimedHostnames(): string[] {
    return [...this.#claimedHostnames];
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }
    this.#closing = false;
    let lastError = new Error('Unable to connect to local TLS control service.');
    for (let attempt = 0; attempt <= this.#options.reconnectAttempts; attempt += 1) {
      try {
        const socket = await connectSocket(this.#options.socketPath);
        this.#attachSocket(socket);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < this.#options.reconnectAttempts) {
          await delay(this.#options.retryDelayMs);
        }
      }
    }
    throw new ControlClientError(
      'CONNECTION_FAILED',
      `Unable to connect to ${this.#options.socketPath}: ${lastError.message}`,
    );
  }

  async health(): Promise<number> {
    const response = await this.#request({
      version: 1,
      type: 'health',
      requestId: randomUUID(),
    });
    if (response.type !== 'healthy') {
      throw new ControlClientError('INVALID_RESPONSE', 'Expected a health response.');
    }
    return response.activeRoutes;
  }

  async register(routes: OwnedRouteInput[]): Promise<string[]> {
    const response = await this.#request({
      version: 1,
      type: 'register',
      requestId: randomUUID(),
      routes: routes.map((route) => ({ ...route, ownerToken: this.ownerToken })),
    });
    if (response.type !== 'registered') {
      throw new ControlClientError('INVALID_RESPONSE', 'Expected a registration response.');
    }
    for (const hostname of response.hostnames) {
      this.#claimedHostnames.add(hostname);
    }
    return response.hostnames;
  }

  async unregister(hostnames = this.claimedHostnames): Promise<string[]> {
    if (hostnames.length === 0) {
      return [];
    }
    const response = await this.#request({
      version: 1,
      type: 'unregister',
      requestId: randomUUID(),
      ownerToken: this.ownerToken,
      hostnames,
    });
    if (response.type !== 'unregistered') {
      throw new ControlClientError('INVALID_RESPONSE', 'Expected an unregistration response.');
    }
    for (const hostname of response.hostnames) {
      this.#claimedHostnames.delete(hostname);
    }
    return response.hostnames;
  }

  async heartbeat(hostnames = this.claimedHostnames): Promise<string[]> {
    if (hostnames.length === 0) {
      return [];
    }
    const response = await this.#request({
      version: 1,
      type: 'heartbeat',
      requestId: randomUUID(),
      ownerToken: this.ownerToken,
      hostnames,
    });
    if (response.type !== 'heartbeat') {
      throw new ControlClientError('INVALID_RESPONSE', 'Expected a heartbeat response.');
    }
    const activeHostnames = new Set(response.hostnames);
    for (const hostname of hostnames) {
      if (!activeHostnames.has(hostname)) {
        this.#claimedHostnames.delete(hostname);
      }
    }
    return response.hostnames;
  }

  async close(): Promise<void> {
    this.#closing = true;
    if (this.connected && this.#claimedHostnames.size > 0) {
      await this.unregister().catch(() => undefined);
    }
    const socket = this.#socket;
    this.#socket = null;
    if (socket && !socket.destroyed) {
      await new Promise<void>((resolve) => {
        socket.once('close', resolve);
        socket.end();
      });
    }
    this.#rejectPending(new ControlClientError('CLOSED', 'Control client closed.'));
  }

  #attachSocket(socket: Socket): void {
    this.#socket = socket;
    this.#buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', this.#handleData.bind(this));
    socket.once('error', this.#handleDisconnect.bind(this));
    socket.once('close', this.#handleDisconnect.bind(this));
  }

  #handleData(chunk: string): void {
    this.#buffer += chunk;
    const frames = this.#buffer.split('\n');
    this.#buffer = frames.pop() ?? '';
    for (const frame of frames) {
      if (!frame.trim()) {
        continue;
      }
      try {
        this.#handleMessage(JSON.parse(frame) as ServerControlMessage);
      } catch {
        this.#handleDisconnect(new ControlClientError('INVALID_RESPONSE', 'Invalid server frame.'));
      }
    }
  }

  #handleMessage(message: ServerControlMessage): void {
    if (message.type === 'route-lost') {
      this.#claimedHostnames.delete(message.hostname);
      this.#options.onRouteLost?.(message);
      return;
    }
    if (!message.requestId) {
      return;
    }
    const pending = this.#pending.get(message.requestId);
    if (!pending) {
      return;
    }
    this.#pending.delete(message.requestId);
    clearTimeout(pending.timer);
    if (message.type === 'error') {
      pending.reject(new ControlClientError(message.code, message.message));
      return;
    }
    pending.resolve(message);
  }

  #handleDisconnect(error?: Error): void {
    if (!this.#socket) {
      return;
    }
    this.#socket.removeAllListeners();
    this.#socket.destroy();
    this.#socket = null;
    const disconnectError =
      error ?? new ControlClientError('DISCONNECTED', 'Control service connection closed.');
    this.#rejectPending(disconnectError);
    if (!this.#closing) {
      this.#options.onDisconnect?.(disconnectError);
    }
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  async #request(message: ClientControlMessage): Promise<ServerControlMessage> {
    const socket = this.#socket;
    if (!socket || socket.destroyed) {
      throw new ControlClientError('NOT_CONNECTED', 'Control client is not connected.');
    }
    return new Promise<ServerControlMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(message.requestId);
        reject(
          new ControlClientError('TIMEOUT', `Control request ${message.requestId} timed out.`),
        );
      }, this.#options.requestTimeoutMs);
      this.#pending.set(message.requestId, { resolve, reject, timer });
      socket.write(encodeControlMessage(message), (error) => {
        if (error) {
          const pending = this.#pending.get(message.requestId);
          if (pending) {
            this.#pending.delete(message.requestId);
            clearTimeout(pending.timer);
            pending.reject(error);
          }
        }
      });
    });
  }
}
