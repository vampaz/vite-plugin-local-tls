import type { RouteRegistration } from './route-registration.js';

export interface NegotiateControlMessage {
  version: 0;
  type: 'negotiate';
  requestId: string;
  protocolVersion: number;
}

export interface StopIfIdleControlMessage {
  version: 0;
  type: 'stop-if-idle';
  requestId: string;
}

export interface NegotiatedControlMessage {
  version: 0;
  type: 'negotiated';
  requestId: string;
  protocolVersion: number;
  activeRoutes: number;
}

export interface StoppingControlMessage {
  version: 0;
  type: 'stopping';
  requestId: string;
}

export interface RegisterControlMessage {
  version: 1;
  type: 'register';
  requestId: string;
  routes: RouteRegistration[];
}

export interface UnregisterControlMessage {
  version: 1;
  type: 'unregister';
  requestId: string;
  ownerToken: string;
  hostnames: string[];
}

export interface HeartbeatControlMessage {
  version: 1;
  type: 'heartbeat';
  requestId: string;
  ownerToken: string;
  hostnames: string[];
}

export interface HealthControlMessage {
  version: 1;
  type: 'health';
  requestId: string;
}

export interface AcknowledgementControlMessage {
  version: 1;
  type: 'registered' | 'unregistered' | 'heartbeat';
  requestId: string;
  hostnames: string[];
}

export interface HealthResponseControlMessage {
  version: 1;
  type: 'healthy';
  requestId: string;
  activeRoutes: number;
}

export interface RouteLostControlMessage {
  version: 1;
  type: 'route-lost';
  hostname: string;
  ownerToken: string;
  replacementOwnerToken: string;
}

export interface ErrorControlMessage {
  version: 0 | 1;
  type: 'error';
  requestId?: string;
  code: string;
  message: string;
}

export type ClientControlMessage =
  | NegotiateControlMessage
  | StopIfIdleControlMessage
  | RegisterControlMessage
  | UnregisterControlMessage
  | HeartbeatControlMessage
  | HealthControlMessage;

export type ServerControlMessage =
  | NegotiatedControlMessage
  | StoppingControlMessage
  | AcknowledgementControlMessage
  | HealthResponseControlMessage
  | RouteLostControlMessage
  | ErrorControlMessage;

export type ControlMessage = ClientControlMessage | ServerControlMessage;
