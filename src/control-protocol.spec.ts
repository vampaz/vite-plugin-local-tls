import { describe, expect, it } from 'vitest';
import {
  ControlProtocolError,
  encodeControlMessage,
  parseClientControlMessage,
  parseControlFrame,
  validateRouteRegistration,
} from './control-protocol.js';

const ownerToken = 'owner-token-1234567890';

function validRoute() {
  return {
    hostname: 'app.main.localhost',
    ownerToken,
    upstreamHost: '127.0.0.1',
    upstreamPort: 5173,
    cors: 'https://client.localhost',
    upstreamHostHeader: 'localhost:5173',
    internalTls: true,
  };
}

describe('control protocol', () => {
  it('parses every client message type', () => {
    expect(
      parseClientControlMessage({
        version: 1,
        type: 'register',
        requestId: 'request-1',
        routes: [validRoute()],
      }),
    ).toMatchObject({ type: 'register', routes: [validRoute()] });
    expect(
      parseClientControlMessage({
        version: 1,
        type: 'unregister',
        requestId: 'request-2',
        ownerToken,
        hostnames: ['app.main.localhost'],
      }),
    ).toMatchObject({ type: 'unregister' });
    expect(
      parseClientControlMessage({
        version: 1,
        type: 'heartbeat',
        requestId: 'request-3',
        ownerToken,
        hostnames: ['app.main.localhost'],
      }),
    ).toMatchObject({ type: 'heartbeat' });
    expect(
      parseClientControlMessage({ version: 1, type: 'health', requestId: 'request-4' }),
    ).toMatchObject({ type: 'health' });
  });

  it.each([
    ['uppercase hostname', { ...validRoute(), hostname: 'App.Localhost' }],
    ['hostname with a port', { ...validRoute(), hostname: 'app.localhost:443' }],
    ['short owner token', { ...validRoute(), ownerToken: 'short' }],
    ['zero port', { ...validRoute(), upstreamPort: 0 }],
    ['large port', { ...validRoute(), upstreamPort: 65_536 }],
    ['fractional port', { ...validRoute(), upstreamPort: 51.73 }],
    ['invalid upstream', { ...validRoute(), upstreamHost: 'bad host' }],
    ['CORS header injection', { ...validRoute(), cors: 'ok\r\nInjected: true' }],
    ['Host header injection', { ...validRoute(), upstreamHostHeader: 'localhost\nInjected: true' }],
  ])('rejects %s', (_name, route) => {
    expect(() => validateRouteRegistration(route)).toThrow(ControlProtocolError);
  });

  it('rejects unsupported versions, duplicate routes, and unknown types', () => {
    expect(() =>
      parseClientControlMessage({ version: 2, type: 'health', requestId: 'request' }),
    ).toThrowError(/not supported/);
    expect(() =>
      parseClientControlMessage({
        version: 1,
        type: 'register',
        requestId: 'request',
        routes: [validRoute(), validRoute()],
      }),
    ).toThrowError(/unique/);
    expect(() =>
      parseClientControlMessage({ version: 1, type: 'destroy', requestId: 'request' }),
    ).toThrowError(/Unknown/);
  });

  it('encodes and decodes newline-framed JSON', () => {
    const message = { version: 1 as const, type: 'health' as const, requestId: 'health-1' };
    expect(parseControlFrame(encodeControlMessage(message).trim())).toEqual(message);
    expect(() => parseControlFrame('{')).toThrowError(/valid JSON/);
    expect(() => parseControlFrame('x'.repeat(1024 * 1024 + 1))).toThrowError(/1 MiB/);
  });
});
