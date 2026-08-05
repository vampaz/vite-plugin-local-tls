import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';
import {
  CONTROL_PROTOCOL_VERSION,
  ControlProtocolError,
  createControlError,
  encodeControlMessage,
  parseControlFrame,
} from './control-protocol.js';
import type { ClientControlMessage, ServerControlMessage } from './interfaces/control-message.js';
import type { ControlServerOptions } from './interfaces/control-server-options.js';

const MAX_BUFFER_BYTES = 1024 * 1024;

type ConnectionState = {
  id: string;
  ownerTokens: Set<string>;
  unsubscribers: Map<string, () => void>;
  buffer: string;
  queue: Promise<void>;
  cleaned: boolean;
};

function writeMessage(socket: Socket, message: ServerControlMessage): void {
  if (!socket.destroyed) {
    socket.write(encodeControlMessage(message));
  }
}

async function isSocketReachable(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(finish, 250, false);

    function finish(reachable: boolean): void {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    }

    socket.once('connect', finish.bind(null, true));
    socket.once('error', finish.bind(null, false));
  });
}

async function prepareSocketPath(socketPath: string): Promise<void> {
  if (process.platform === 'win32') {
    return;
  }
  try {
    const stats = await lstat(socketPath);
    if (!stats.isSocket()) {
      throw new Error(`Refusing to replace non-socket control path: ${socketPath}`);
    }
    if (await isSocketReachable(socketPath)) {
      throw new Error(`Control socket is already active: ${socketPath}`);
    }
    await unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

export class ControlServer {
  readonly #options: ControlServerOptions;
  readonly #sockets = new Set<Socket>();
  #server: Server | null = null;

  constructor(options: ControlServerOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    if (this.#server) {
      return;
    }
    if (process.platform !== 'win32') {
      await mkdir(path.dirname(this.#options.socketPath), {
        recursive: true,
        mode: 0o700,
      });
    }
    await prepareSocketPath(this.#options.socketPath);
    const server = createServer(this.#handleConnection.bind(this));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.#options.socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.#server = server;
    try {
      if (process.platform !== 'win32') {
        await chmod(this.#options.socketPath, 0o600);
      }
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    for (const socket of this.#sockets) {
      socket.destroy();
    }
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (process.platform !== 'win32') {
      await unlink(this.#options.socketPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      });
    }
  }

  #handleConnection(socket: Socket): void {
    this.#sockets.add(socket);
    const state: ConnectionState = {
      id: randomUUID(),
      ownerTokens: new Set(),
      unsubscribers: new Map(),
      buffer: '',
      queue: Promise.resolve(),
      cleaned: false,
    };
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.#handleData(socket, state, chunk));
    socket.once('end', () => this.#cleanupConnection(socket, state));
    socket.once('close', () => this.#cleanupConnection(socket, state));
    socket.once('error', () => this.#cleanupConnection(socket, state));
  }

  #handleData(socket: Socket, state: ConnectionState, chunk: string): void {
    state.buffer += chunk;
    if (Buffer.byteLength(state.buffer) > MAX_BUFFER_BYTES) {
      writeMessage(
        socket,
        createControlError(
          new ControlProtocolError('FRAME_TOO_LARGE', 'Control buffer exceeded 1 MiB.'),
        ),
      );
      socket.destroy();
      return;
    }

    const frames = state.buffer.split('\n');
    state.buffer = frames.pop() ?? '';
    for (const frame of frames) {
      if (!frame.trim()) {
        continue;
      }
      state.queue = state.queue.then(async () => {
        let requestId: string | undefined;
        try {
          const message = parseControlFrame(frame);
          requestId = message.requestId;
          await this.#processMessage(socket, state, message);
        } catch (error) {
          writeMessage(socket, createControlError(error, requestId));
        }
      });
    }
  }

  async #processMessage(
    socket: Socket,
    state: ConnectionState,
    message: ClientControlMessage,
  ): Promise<void> {
    const registry = this.#options.registry;
    if (message.type === 'negotiate') {
      writeMessage(socket, {
        version: 0,
        type: 'negotiated',
        requestId: message.requestId,
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        activeRoutes: registry.size,
      });
      return;
    }
    if (message.type === 'stop-if-idle') {
      if (registry.size > 0) {
        throw new ControlProtocolError(
          'ROUTES_ACTIVE',
          'Refusing to stop the local TLS daemon while routes are active.',
        );
      }
      socket.write(
        encodeControlMessage({ version: 0, type: 'stopping', requestId: message.requestId }),
        () => setImmediate(() => this.#options.onStopRequested?.()),
      );
      return;
    }
    if (message.type === 'health') {
      writeMessage(socket, {
        version: 1,
        type: 'healthy',
        requestId: message.requestId,
        activeRoutes: registry.size,
      });
      return;
    }
    if (message.type === 'register') {
      await this.#options.validateRoutes?.(message.routes);
      registry.registerMany(message.routes, state.id);
      for (const { ownerToken } of message.routes) {
        state.ownerTokens.add(ownerToken);
        if (!state.unsubscribers.has(ownerToken)) {
          state.unsubscribers.set(
            ownerToken,
            registry.subscribeToRouteLoss(ownerToken, (takeover) => {
              writeMessage(socket, { version: 1, type: 'route-lost', ...takeover });
            }),
          );
        }
      }
      writeMessage(socket, {
        version: 1,
        type: 'registered',
        requestId: message.requestId,
        hostnames: message.routes.map(({ hostname }) => hostname),
      });
      return;
    }
    const activeHostnames = registry.activeHostnames(
      message.ownerToken,
      message.hostnames,
      state.id,
    );
    const hostnames =
      message.type === 'unregister'
        ? registry.unregisterMany(activeHostnames, message.ownerToken, state.id)
        : activeHostnames;
    writeMessage(socket, {
      version: 1,
      type: message.type === 'unregister' ? 'unregistered' : 'heartbeat',
      requestId: message.requestId,
      hostnames,
    });
  }

  #cleanupConnection(socket: Socket, state: ConnectionState): void {
    if (state.cleaned) {
      return;
    }
    state.cleaned = true;
    this.#sockets.delete(socket);
    for (const ownerToken of state.ownerTokens) {
      this.#options.registry.unregisterOwner(ownerToken, state.id);
    }
    for (const unsubscribe of state.unsubscribers.values()) {
      unsubscribe();
    }
  }
}
