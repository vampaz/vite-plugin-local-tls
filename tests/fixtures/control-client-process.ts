import { createConnection, createServer } from 'node:net';

const [mode, socketPath, ownerToken, hostnamesJson] = process.argv.slice(2);

function report(message: Record<string, unknown>): void {
  process.send?.(message);
}

async function runClient(): Promise<void> {
  const hostnames = JSON.parse(hostnamesJson) as string[];
  const socket = createConnection(socketPath);
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('connect', () => {
    socket.write(
      `${JSON.stringify({
        version: 1,
        type: 'register',
        requestId: 'register-child',
        routes: hostnames.map((hostname, index) => ({
          hostname,
          ownerToken,
          upstreamHost: '127.0.0.1',
          upstreamPort: 5100 + index,
        })),
      })}\n`,
    );
  });
  socket.on('data', (chunk) => {
    buffer += chunk;
    const frames = buffer.split('\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      if ((JSON.parse(frame) as { type?: string }).type === 'registered') {
        report({ type: 'ready', hostnames });
      }
    }
  });
  process.on('message', (message) => {
    if (message === 'close') {
      socket.end();
    }
  });
  socket.once('close', () => process.exit(0));
}

async function runStaleSocket(): Promise<void> {
  const server = createServer();
  server.listen(socketPath, () => report({ type: 'ready' }));
}

if (mode === 'client') {
  await runClient();
} else if (mode === 'stale-socket') {
  await runStaleSocket();
} else {
  throw new Error(`Unknown fixture mode: ${mode}`);
}
