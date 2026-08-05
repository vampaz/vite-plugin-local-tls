import { isIP } from 'node:net';
import type {
  ClientControlMessage,
  ControlMessage,
  ServerControlMessage,
} from './interfaces/control-message.js';
import type { RouteRegistration } from './interfaces/route-registration.js';

export const CONTROL_PROTOCOL_VERSION = 1;

export class ControlProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ControlProtocolError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !value) {
    throw new ControlProtocolError('INVALID_MESSAGE', `\`${key}\` must be a non-empty string.`);
  }
  return value;
}

function validateSafeText(value: string, key: string, maximumLength = 4096): string {
  const containsControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
  if (value.length > maximumLength || containsControlCharacter) {
    throw new ControlProtocolError(
      'INVALID_MESSAGE',
      `\`${key}\` contains control characters or exceeds ${maximumLength} characters.`,
    );
  }
  return value;
}

export function validateHostname(value: unknown): string {
  if (typeof value !== 'string' || value !== value.toLowerCase() || value.length > 253) {
    throw new ControlProtocolError('INVALID_HOSTNAME', 'Hostname must be lowercase and valid.');
  }
  const labels = value.split('.');
  if (
    labels.some(
      (label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    throw new ControlProtocolError('INVALID_HOSTNAME', `Invalid hostname: ${value}`);
  }
  return value;
}

export function validateOwnerToken(value: unknown): string {
  if (typeof value !== 'string' || value.length < 16 || value.length > 256) {
    throw new ControlProtocolError('INVALID_OWNER', 'Owner token must be 16 to 256 characters.');
  }
  if (!/^[a-zA-Z0-9._:-]+$/.test(value)) {
    throw new ControlProtocolError('INVALID_OWNER', 'Owner token contains invalid characters.');
  }
  return value;
}

export function validateUpstreamHost(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 253) {
    throw new ControlProtocolError('INVALID_UPSTREAM', 'Upstream host must be valid.');
  }
  const unwrapped = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  if (isIP(unwrapped)) {
    return unwrapped;
  }
  if (
    unwrapped === 'localhost' ||
    unwrapped.split('.').every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label))
  ) {
    return unwrapped;
  }
  throw new ControlProtocolError('INVALID_UPSTREAM', `Invalid upstream host: ${value}`);
}

export function validatePort(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65_535) {
    throw new ControlProtocolError(
      'INVALID_PORT',
      'Upstream port must be an integer from 1 to 65535.',
    );
  }
  return value as number;
}

function validateRequestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(value)) {
    throw new ControlProtocolError('INVALID_MESSAGE', 'Request ID is invalid.');
  }
  return value;
}

function validateHostnames(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new ControlProtocolError('INVALID_MESSAGE', 'Hostnames must be a non-empty array.');
  }
  const hostnames = value.map(validateHostname);
  if (new Set(hostnames).size !== hostnames.length) {
    throw new ControlProtocolError('INVALID_MESSAGE', 'Hostnames must be unique.');
  }
  return hostnames;
}

export function validateRouteRegistration(value: unknown): RouteRegistration {
  if (!isRecord(value)) {
    throw new ControlProtocolError('INVALID_ROUTE', 'Route registration must be an object.');
  }
  const route: RouteRegistration = {
    hostname: validateHostname(value.hostname),
    ownerToken: validateOwnerToken(value.ownerToken),
    upstreamHost: validateUpstreamHost(value.upstreamHost),
    upstreamPort: validatePort(value.upstreamPort),
  };
  if (value.cors !== undefined) {
    if (typeof value.cors !== 'string') {
      throw new ControlProtocolError('INVALID_ROUTE', '`cors` must be a string.');
    }
    route.cors = validateSafeText(value.cors, 'cors');
  }
  if (value.upstreamHostHeader !== undefined) {
    if (typeof value.upstreamHostHeader !== 'string') {
      throw new ControlProtocolError('INVALID_ROUTE', '`upstreamHostHeader` must be a string.');
    }
    route.upstreamHostHeader = validateSafeText(
      value.upstreamHostHeader,
      'upstreamHostHeader',
      255,
    );
  }
  if (value.internalTls !== undefined) {
    if (typeof value.internalTls !== 'boolean') {
      throw new ControlProtocolError('INVALID_ROUTE', '`internalTls` must be a boolean.');
    }
    route.internalTls = value.internalTls;
  }
  return route;
}

function validateVersion(record: Record<string, unknown>): void {
  if (record.version !== CONTROL_PROTOCOL_VERSION) {
    throw new ControlProtocolError(
      'UNSUPPORTED_VERSION',
      `Control protocol version ${String(record.version)} is not supported.`,
    );
  }
}

export function parseClientControlMessage(value: unknown): ClientControlMessage {
  if (!isRecord(value)) {
    throw new ControlProtocolError('INVALID_MESSAGE', 'Control message must be an object.');
  }
  const requestId = validateRequestId(value.requestId);
  const type = requireString(value, 'type');

  if (value.version === 0 && type === 'negotiate') {
    if (
      typeof value.protocolVersion !== 'number' ||
      !Number.isInteger(value.protocolVersion) ||
      value.protocolVersion < 1
    ) {
      throw new ControlProtocolError(
        'INVALID_MESSAGE',
        '`protocolVersion` must be a positive integer.',
      );
    }
    return {
      version: 0,
      type,
      requestId,
      protocolVersion: value.protocolVersion,
    };
  }
  if (value.version === 0 && type === 'stop-if-idle') {
    return { version: 0, type, requestId };
  }

  validateVersion(value);

  if (type === 'health') {
    return { version: 1, type, requestId };
  }
  if (type === 'register') {
    if (!Array.isArray(value.routes) || value.routes.length === 0 || value.routes.length > 100) {
      throw new ControlProtocolError('INVALID_MESSAGE', 'Routes must be a non-empty array.');
    }
    const routes = value.routes.map(validateRouteRegistration);
    const hostnames = routes.map(({ hostname }) => hostname);
    if (new Set(hostnames).size !== hostnames.length) {
      throw new ControlProtocolError('INVALID_MESSAGE', 'Route hostnames must be unique.');
    }
    return { version: 1, type, requestId, routes };
  }
  if (type === 'unregister' || type === 'heartbeat') {
    return {
      version: 1,
      type,
      requestId,
      ownerToken: validateOwnerToken(value.ownerToken),
      hostnames: validateHostnames(value.hostnames),
    };
  }
  throw new ControlProtocolError('INVALID_MESSAGE', `Unknown client message type: ${type}`);
}

export function parseControlFrame(frame: string): ClientControlMessage {
  if (Buffer.byteLength(frame) > 1024 * 1024) {
    throw new ControlProtocolError('FRAME_TOO_LARGE', 'Control frame exceeds 1 MiB.');
  }
  try {
    return parseClientControlMessage(JSON.parse(frame) as unknown);
  } catch (error) {
    if (error instanceof ControlProtocolError) {
      throw error;
    }
    throw new ControlProtocolError('INVALID_JSON', 'Control frame is not valid JSON.');
  }
}

export function encodeControlMessage(message: ControlMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function createControlError(error: unknown, requestId?: string): ServerControlMessage {
  const protocolError =
    error instanceof ControlProtocolError
      ? error
      : new ControlProtocolError('INTERNAL_ERROR', 'Unexpected control service error.');
  return {
    version: 1,
    type: 'error',
    requestId,
    code: protocolError.code,
    message: protocolError.message,
  };
}
