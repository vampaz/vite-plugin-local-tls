import { startServer } from '../fixtures/server-process.js';
import { expect, test } from './fixtures.js';

test('bridges an application WebSocket independently of Vite HMR', async ({ page, e2e }) => {
  const domain = 'application-websocket.localhost';
  await startServer(e2e, { domains: [domain], marker: 'application-websocket' });
  await page.goto(`https://${domain}:${e2e.proxyPort}/`);

  const response = await page.evaluate(
    ({ hostname, port }) =>
      new Promise<string>((resolve, reject) => {
        const socket = new WebSocket(`wss://${hostname}:${port}/app-ws`);
        socket.addEventListener('open', () => socket.send('through-proxy'));
        socket.addEventListener('message', (event) => {
          resolve(String(event.data));
          socket.close();
        });
        socket.addEventListener('error', () => reject(new Error('WebSocket failed.')));
      }),
    { hostname: domain, port: e2e.proxyPort },
  );

  expect(response).toBe('echo:through-proxy');
  await expect(page.locator('#hmr')).toHaveText('available');
});
