import { access, open, readFile, stat, unlink } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { CONTROL_PROTOCOL_VERSION, encodeControlMessage } from './control-protocol.js';
import { LocalTlsDaemon } from './daemon.js';
import type { ServiceAutoStartOptions } from './interfaces/service-autostart-options.js';
import type { ServiceOptions } from './interfaces/service-options.js';
import type { ServiceState } from './interfaces/service-state.js';
import type { ServiceStatus } from './interfaces/service-status.js';
import { ensureStatePaths } from './state-paths.js';

interface StartupLock {
  pid: number;
  startedAt: string;
}

type ServiceProbe =
  | { status: 'healthy'; activeRoutes: number; protocolVersion: number }
  | { status: 'missing' }
  | { status: 'unrelated'; reason: string };

const INSTALLED_SERVICE_START_TIMEOUT_MS = 30_000;

export class ServiceCoordinationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ServiceCoordinationError';
    this.code = code;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseServiceState(value: unknown): ServiceState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const state = value as Record<string, unknown>;
  if (
    state.version !== 1 ||
    typeof state.pid !== 'number' ||
    !Number.isInteger(state.pid) ||
    state.pid < 1 ||
    typeof state.namespace !== 'string' ||
    typeof state.socketPath !== 'string' ||
    typeof state.startedAt !== 'string' ||
    typeof state.protocolVersion !== 'number' ||
    typeof state.port !== 'number' ||
    typeof state.caFingerprint !== 'string'
  ) {
    return null;
  }
  return state as unknown as ServiceState;
}

export async function readServiceState(stateFile: string): Promise<ServiceState | null> {
  try {
    return parseServiceState(JSON.parse(await readFile(stateFile, 'utf8')) as unknown);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

function connect(socketPath: string, timeoutMs: number): Promise<Socket | null> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(finish, timeoutMs, null);

    function finish(result: Socket | null): void {
      clearTimeout(timer);
      socket.removeAllListeners();
      if (!result) {
        socket.destroy();
      }
      resolve(result);
    }

    socket.once('connect', finish.bind(null, socket));
    socket.once('error', finish.bind(null, null));
  });
}

async function probeService(socketPath: string, timeoutMs: number): Promise<ServiceProbe> {
  const socket = await connect(socketPath, timeoutMs);
  if (!socket) {
    return { status: 'missing' };
  }
  const connectedSocket = socket;
  return new Promise((resolve) => {
    let buffer = '';
    const requestId = randomUUID();
    const timer = setTimeout(finish, timeoutMs, {
      status: 'unrelated',
      reason: 'Listener did not answer protocol negotiation.',
    });

    function finish(result: ServiceProbe): void {
      clearTimeout(timer);
      connectedSocket.removeAllListeners();
      connectedSocket.destroy();
      resolve(result);
    }

    connectedSocket.setEncoding('utf8');
    connectedSocket.once('error', () =>
      finish({ status: 'unrelated', reason: 'Listener closed during protocol negotiation.' }),
    );
    connectedSocket.on('data', (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end === -1) {
        return;
      }
      try {
        const response = JSON.parse(buffer.slice(0, end)) as Record<string, unknown>;
        if (
          response.version === 0 &&
          response.type === 'negotiated' &&
          response.requestId === requestId &&
          typeof response.protocolVersion === 'number' &&
          typeof response.activeRoutes === 'number'
        ) {
          finish({
            status: 'healthy',
            activeRoutes: response.activeRoutes,
            protocolVersion: response.protocolVersion,
          });
          return;
        }
        finish({ status: 'unrelated', reason: 'Listener returned an invalid control response.' });
      } catch {
        finish({ status: 'unrelated', reason: 'Listener returned a non-JSON control response.' });
      }
    });
    connectedSocket.write(
      encodeControlMessage({
        version: 0,
        type: 'negotiate',
        requestId,
        protocolVersion: CONTROL_PROTOCOL_VERSION,
      }),
    );
  });
}

async function requestIdleStop(socketPath: string, timeoutMs: number): Promise<void> {
  const socket = await connect(socketPath, timeoutMs);
  if (!socket) {
    return;
  }
  const connectedSocket = socket;
  await new Promise<void>((resolve, reject) => {
    let buffer = '';
    const requestId = randomUUID();
    const timer = setTimeout(
      finishError,
      timeoutMs,
      new ServiceCoordinationError('STOP_TIMEOUT', 'Timed out requesting daemon replacement.'),
    );

    function cleanup(): void {
      clearTimeout(timer);
      connectedSocket.removeAllListeners();
      connectedSocket.destroy();
    }

    function finishError(error: Error): void {
      cleanup();
      reject(error);
    }

    connectedSocket.setEncoding('utf8');
    connectedSocket.once('error', (error) => finishError(error));
    connectedSocket.on('data', (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end === -1) {
        return;
      }
      try {
        const response = JSON.parse(buffer.slice(0, end)) as Record<string, unknown>;
        if (response.version === 0 && response.type === 'stopping') {
          cleanup();
          resolve();
          return;
        }
        if (response.type === 'error') {
          finishError(
            new ServiceCoordinationError(
              typeof response.code === 'string' ? response.code : 'STOP_REFUSED',
              typeof response.message === 'string'
                ? response.message
                : 'Daemon refused replacement.',
            ),
          );
          return;
        }
        finishError(
          new ServiceCoordinationError(
            'UNRELATED_LISTENER',
            'Listener returned an invalid stop response.',
          ),
        );
      } catch {
        finishError(
          new ServiceCoordinationError(
            'UNRELATED_LISTENER',
            'Listener returned a non-JSON stop response.',
          ),
        );
      }
    });
    connectedSocket.write(encodeControlMessage({ version: 0, type: 'stop-if-idle', requestId }));
  });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function errorHasCode(error: unknown, codes: Set<string>): boolean {
  let current = error;
  while (current instanceof Error) {
    const code = (current as NodeJS.ErrnoException).code;
    if (code && codes.has(code)) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

export class LocalTlsService {
  readonly #options: Required<
    Pick<ServiceOptions, 'startupTimeoutMs' | 'probeTimeoutMs' | 'retryDelayMs' | 'staleLockMs'>
  > &
    Omit<ServiceOptions, 'startupTimeoutMs' | 'probeTimeoutMs' | 'retryDelayMs' | 'staleLockMs'>;
  #daemon: LocalTlsDaemon | null = null;

  constructor(options: ServiceOptions) {
    this.#options = {
      ...options,
      startupTimeoutMs: options.startupTimeoutMs ?? 5000,
      probeTimeoutMs: options.probeTimeoutMs ?? 500,
      retryDelayMs: options.retryDelayMs ?? 50,
      staleLockMs: options.staleLockMs ?? 30_000,
    };
  }

  get ownsStartedDaemon(): boolean {
    return this.#daemon !== null;
  }

  async ensureRunning(): Promise<ServiceState> {
    await ensureStatePaths(this.#options.paths);
    const deadline = Date.now() + this.#options.startupTimeoutMs;
    while (true) {
      const runningState = await this.#readHealthyState();
      if (runningState) {
        return runningState;
      }
      const release = await this.#tryAcquireLock();
      if (release) {
        try {
          const recheckedState = await this.#readHealthyState();
          if (recheckedState) {
            return recheckedState;
          }
          const replaced = await this.#replaceIdleIncompatibleDaemon(deadline);
          if (!replaced) {
            await this.#assertNoLiveUnhealthyDaemon();
          }
          const state = await this.#startDaemon();
          const probe = await probeService(state.socketPath, this.#options.probeTimeoutMs);
          if (probe.status !== 'healthy' || probe.protocolVersion !== CONTROL_PROTOCOL_VERSION) {
            throw new ServiceCoordinationError(
              'START_FAILED',
              'Local TLS daemon did not become healthy after startup.',
            );
          }
          return state;
        } finally {
          await release();
        }
      }
      await this.#clearStaleLock();
      if (Date.now() >= deadline) {
        throw new ServiceCoordinationError(
          'STARTUP_TIMEOUT',
          `Timed out waiting for the local TLS startup lock at ${this.#options.paths.lockPath}.`,
        );
      }
      await delay(this.#options.retryDelayMs);
    }
  }

  async autoStart(options: ServiceAutoStartOptions): Promise<ServiceState> {
    const interactive =
      options.interactive ??
      Boolean(
        !process.env.CI &&
        (process.platform === 'darwin' ||
          (process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY)),
      );
    if (!(await options.isTrusted())) {
      if (!interactive) {
        throw new ServiceCoordinationError(
          'TRUST_REQUIRED',
          'The local certificate authority is not trusted. Run `npm exec -- vite-local-tls trust` in an interactive terminal.',
        );
      }
      await this.#withAuthorizationLock(async () => {
        if (await options.isTrusted()) {
          return;
        }
        await options.trust();
        if (!(await options.isTrusted())) {
          throw new ServiceCoordinationError(
            'TRUST_FAILED',
            'The local certificate authority is still untrusted after `npm exec -- vite-local-tls trust`.',
          );
        }
      }, options.onAuthorizationWait);
    }
    const isServiceCurrent = options.isServiceCurrent;
    if (isServiceCurrent && !(await isServiceCurrent())) {
      if (!interactive) {
        throw new ServiceCoordinationError(
          'SERVICE_UPDATE_REQUIRED',
          'The installed local TLS service is outdated. Run `npm exec -- vite-local-tls service install` in an interactive terminal.',
        );
      }
      return this.#withAuthorizationLock(async () => {
        if (await isServiceCurrent()) {
          return this.ensureRunning();
        }
        const status = await this.status();
        if (status.running && status.activeRoutes > 0) {
          throw new ServiceCoordinationError(
            'SERVICE_UPDATE_ROUTES_ACTIVE',
            `The installed local TLS service is outdated, but ${status.activeRoutes} route(s) are active. Stop those Vite processes and start this project again.`,
          );
        }
        await options.installService();
        return this.#waitForInstalledService(INSTALLED_SERVICE_START_TIMEOUT_MS);
      }, options.onAuthorizationWait);
    }
    try {
      return await this.ensureRunning();
    } catch (error) {
      if (!errorHasCode(error, new Set(['EACCES', 'EPERM']))) {
        throw error;
      }
      if (!interactive) {
        throw new ServiceCoordinationError(
          'SERVICE_INSTALL_REQUIRED',
          'Port 443 requires the startup service. Run `npm exec -- vite-local-tls service install` in an interactive terminal.',
        );
      }
      return this.#withAuthorizationLock(async () => {
        try {
          return await this.ensureRunning();
        } catch (coordinatedError) {
          if (!errorHasCode(coordinatedError, new Set(['EACCES', 'EPERM']))) {
            throw coordinatedError;
          }
        }
        await options.installService();
        return this.#waitForInstalledService(INSTALLED_SERVICE_START_TIMEOUT_MS);
      }, options.onAuthorizationWait);
    }
  }

  async stopStartedDaemon(): Promise<void> {
    const daemon = this.#daemon;
    this.#daemon = null;
    await daemon?.stop();
  }

  async status(): Promise<ServiceStatus> {
    const probe = await probeService(this.#options.paths.socketPath, this.#options.probeTimeoutMs);
    if (probe.status === 'missing') {
      return {
        running: false,
        activeRoutes: 0,
        protocolVersion: null,
        compatible: false,
        state: await readServiceState(this.#options.paths.stateFile),
      };
    }
    if (probe.status === 'unrelated') {
      throw new ServiceCoordinationError(
        'UNRELATED_LISTENER',
        `The listener at ${this.#options.paths.socketPath} is not a local TLS daemon: ${probe.reason}`,
      );
    }
    return {
      running: true,
      activeRoutes: probe.activeRoutes,
      protocolVersion: probe.protocolVersion,
      compatible: probe.protocolVersion === CONTROL_PROTOCOL_VERSION,
      state: await readServiceState(this.#options.paths.stateFile),
    };
  }

  async stopIfIdle(): Promise<boolean> {
    const status = await this.status();
    if (!status.running) {
      return false;
    }
    if (status.activeRoutes > 0) {
      throw new ServiceCoordinationError(
        'ROUTES_ACTIVE',
        `Refusing to stop the local TLS daemon while ${status.activeRoutes} route(s) are active.`,
      );
    }
    await requestIdleStop(this.#options.paths.socketPath, this.#options.probeTimeoutMs);
    await this.#waitForStop(Date.now() + this.#options.startupTimeoutMs);
    return true;
  }

  async #waitForInstalledService(timeoutMs: number): Promise<ServiceState> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await this.status();
      if (status.running && status.compatible && status.state) {
        return status.state;
      }
      await delay(this.#options.retryDelayMs);
    }
    throw new ServiceCoordinationError(
      'SERVICE_START_TIMEOUT',
      'The installed local TLS service did not become ready in time.',
    );
  }

  async #readHealthyState(): Promise<ServiceState | null> {
    const probe = await probeService(this.#options.paths.socketPath, this.#options.probeTimeoutMs);
    if (probe.status === 'unrelated') {
      throw new ServiceCoordinationError(
        'UNRELATED_LISTENER',
        `Refusing to replace the listener at ${this.#options.paths.socketPath}: ${probe.reason}`,
      );
    }
    if (probe.status === 'missing') {
      return null;
    }
    if (probe.protocolVersion !== CONTROL_PROTOCOL_VERSION) {
      if (probe.activeRoutes > 0) {
        throw new ServiceCoordinationError(
          'INCOMPATIBLE_ACTIVE_DAEMON',
          `Local TLS protocol ${probe.protocolVersion} owns ${probe.activeRoutes} active route(s); this plugin requires protocol ${CONTROL_PROTOCOL_VERSION}.`,
        );
      }
      return null;
    }
    const state = await readServiceState(this.#options.paths.stateFile);
    if (!state && (await pathExists(this.#options.paths.lockPath))) {
      return null;
    }
    if (
      !state ||
      state.socketPath !== this.#options.paths.socketPath ||
      state.namespace !== (this.#options.namespace ?? 'default')
    ) {
      throw new ServiceCoordinationError(
        'INVALID_STATE',
        'A healthy local TLS daemon has missing or mismatched service metadata.',
      );
    }
    return state;
  }

  async #replaceIdleIncompatibleDaemon(deadline: number): Promise<boolean> {
    const probe = await probeService(this.#options.paths.socketPath, this.#options.probeTimeoutMs);
    if (probe.status === 'missing') {
      return false;
    }
    if (probe.status === 'unrelated') {
      throw new ServiceCoordinationError(
        'UNRELATED_LISTENER',
        `Refusing to replace the listener at ${this.#options.paths.socketPath}: ${probe.reason}`,
      );
    }
    if (probe.protocolVersion === CONTROL_PROTOCOL_VERSION) {
      return false;
    }
    if (probe.activeRoutes > 0) {
      throw new ServiceCoordinationError(
        'INCOMPATIBLE_ACTIVE_DAEMON',
        `Local TLS protocol ${probe.protocolVersion} gained active routes during replacement.`,
      );
    }
    await requestIdleStop(this.#options.paths.socketPath, this.#options.probeTimeoutMs);
    await this.#waitForStop(deadline);
    return true;
  }

  async #waitForStop(deadline: number): Promise<void> {
    while (Date.now() < deadline) {
      const stoppedProbe = await probeService(
        this.#options.paths.socketPath,
        this.#options.probeTimeoutMs,
      );
      if (stoppedProbe.status === 'missing' && !(await pathExists(this.#options.paths.stateFile))) {
        return;
      }
      await delay(this.#options.retryDelayMs);
    }
    throw new ServiceCoordinationError(
      'STOP_TIMEOUT',
      'Timed out waiting for the idle incompatible local TLS daemon to stop.',
    );
  }

  async #withAuthorizationLock<T>(operation: () => Promise<T>, onWait?: () => void): Promise<T> {
    await ensureStatePaths(this.#options.paths);
    const lockPath = `${this.#options.paths.lockPath}.authorization`;
    let waitingReported = false;
    while (true) {
      const release = await this.#tryAcquireLock(lockPath);
      if (release) {
        try {
          return await operation();
        } finally {
          await release();
        }
      }
      if (!waitingReported) {
        waitingReported = true;
        onWait?.();
      }
      await this.#clearStaleLock(lockPath);
      await delay(this.#options.retryDelayMs);
    }
  }

  async #tryAcquireLock(
    lockPath = this.#options.paths.lockPath,
  ): Promise<(() => Promise<void>) | null> {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        const lock: StartupLock = { pid: process.pid, startedAt: new Date().toISOString() };
        await handle.writeFile(`${JSON.stringify(lock)}\n`);
      } catch (error) {
        await handle.close();
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }
      return async function releaseLock(): Promise<void> {
        await handle.close();
        await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') {
            throw error;
          }
        });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return null;
      }
      throw error;
    }
  }

  async #clearStaleLock(lockPath = this.#options.paths.lockPath): Promise<void> {
    try {
      const [contents, details] = await Promise.all([readFile(lockPath, 'utf8'), stat(lockPath)]);
      let lock: StartupLock | null = null;
      try {
        const value = JSON.parse(contents) as Partial<StartupLock>;
        if (typeof value.pid === 'number' && typeof value.startedAt === 'string') {
          lock = value as StartupLock;
        }
      } catch {
        lock = null;
      }
      const isOld = Date.now() - details.mtimeMs >= this.#options.staleLockMs;
      if ((lock && !isProcessRunning(lock.pid)) || (!lock && isOld)) {
        await unlink(lockPath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async #assertNoLiveUnhealthyDaemon(): Promise<void> {
    const state = await readServiceState(this.#options.paths.stateFile);
    if (state && isProcessRunning(state.pid)) {
      throw new ServiceCoordinationError(
        'UNHEALTHY_DAEMON',
        `Process ${state.pid} owns the local TLS service metadata but is not healthy.`,
      );
    }
  }

  async #startDaemon(): Promise<ServiceState> {
    if (this.#options.startDaemon) {
      return this.#options.startDaemon();
    }
    const daemon = new LocalTlsDaemon(this.#options);
    this.#daemon = daemon;
    return daemon.start();
  }
}
