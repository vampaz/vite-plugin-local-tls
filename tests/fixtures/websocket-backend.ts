import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function createWebSocketBackend(): Server {
  const server = createServer();
  server.on('upgrade', (request, socket, head) => {
    const key = request.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64');
    const protocols = String(request.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((protocol) => protocol.trim())
      .filter(Boolean);
    const protocol = protocols.includes('vite-hmr') ? 'vite-hmr' : protocols[0];
    const extension = String(request.headers['sec-websocket-extensions'] ?? '')
      .split(',')[0]
      .trim();
    const responseHeaders = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
    ];
    if (protocol) {
      responseHeaders.push(`Sec-WebSocket-Protocol: ${protocol}`);
    }
    if (extension) {
      responseHeaders.push(`Sec-WebSocket-Extensions: ${extension}`);
    }
    socket.write(`${responseHeaders.join('\r\n')}\r\n\r\n`);
    if (head.length > 0) {
      socket.write(head);
    }
    socket.pipe(socket);
  });
  return server;
}
