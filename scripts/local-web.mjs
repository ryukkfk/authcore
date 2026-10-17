import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { resolve } from 'node:path';
if (process.env.NODE_ENV !== 'development' || process.env.AUTHCORE_LOCAL_DEMO !== 'true')
  throw new Error('Local web server requires explicit development configuration');
const root = fileURLToPath(new URL('../apps/web/', import.meta.url));
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
// The explicit demo does not need HMR. Vite's reconnect poller creates a blob
// worker after restart; keep the strict application CSP instead of admitting it.
const server = await createServer({
  root,
  configFile: resolve(root, 'vite.config.ts'),
  server: { hmr: false, ws: false },
});
await server.listen();
server.printUrls();
let closing;
const close = () => {
  closing ??= server.close().then(() => {
    process.disconnect?.();
  });
  void closing.catch(() => {
    process.exitCode = 1;
    process.disconnect?.();
  });
};
process.on('message', (message) => {
  if (message === 'authcore:shutdown') close();
});
process.once('SIGINT', close);
process.once('SIGTERM', close);
process.send?.('authcore:ready');
