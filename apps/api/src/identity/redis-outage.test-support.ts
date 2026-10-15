import { connect, createServer, type Socket } from 'node:net';
import { bounded } from '@authcore/testing';
/** Test-only loopback fault proxy. It owns only its accepted and upstream sockets. */
export async function createRedisOutageProxy(target: URL) {
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    target.protocol !== 'redis:' ||
    !['127.0.0.1', 'localhost'].includes(target.hostname) ||
    target.port !== '6380' ||
    target.pathname !== '/15' ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  )
    throw new Error('S6 Redis proxy target rejected');
  const sockets = new Set<Socket>();
  let blocked = false;
  const own = (socket: Socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  const server = createServer((incoming) => {
    own(incoming);
    if (blocked) {
      incoming.destroy();
      return;
    }
    const upstream = own(connect({ host: target.hostname, port: Number(target.port) }));
    incoming.once('close', () => upstream.destroy());
    upstream.once('close', () => incoming.destroy());
    incoming.pipe(upstream).pipe(incoming);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('S6 Redis proxy address invalid');
  const url = new URL(target);
  url.hostname = '127.0.0.1';
  url.port = String(address.port);
  async function disconnect() {
    await bounded(
      Promise.all(
        [...sockets].map(
          (socket) =>
            new Promise<void>((resolve) => {
              socket.once('close', resolve);
              socket.destroy();
            }),
        ),
      ),
      'S6 owned Redis transport closure',
    );
    if (sockets.size) throw new Error('S6 proxy sockets retained');
  }
  return {
    url,
    async outage() {
      blocked = true;
      await disconnect();
    },
    restore() {
      blocked = false;
    },
    async close() {
      blocked = true;
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await disconnect();
      await bounded(closed, 'S6 Redis proxy shutdown');
      if (sockets.size || server.listening) throw new Error('S6 proxy shutdown incomplete');
    },
  };
}
