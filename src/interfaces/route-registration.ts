export interface RouteRegistration {
  hostname: string;
  ownerToken: string;
  upstreamHost: string;
  upstreamPort: number;
  cors?: string;
  upstreamHostHeader?: string;
  internalTls?: boolean;
}
