import { createServer, connect, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { bounded, commitAckProxy, deferred } from './s0-commit-proxy.test-support.js';

describe('S0 proxy with synthetic TCP peer — explicitly NOT PostgreSQL outcome proof', () => {
  it.each([false, true])(
    'forwards or withholds complete ACK according to armed=%s',
    async (armed) => {
      const startup = deferred<void>();
      const frameSeen = deferred<void>();
      const peers = new Set<Socket>();
      const commit = Buffer.from([67, 0, 0, 0, 11, ...Buffer.from('COMMIT\0')]);
      const ready = Buffer.from([90, 0, 0, 0, 5, 73]);
      const server = createServer((peer) => {
        peers.add(peer);
        peer.once('close', () => peers.delete(peer));
        let started = false;
        peer.on('data', () => {
          if (!started) {
            started = true;
            startup.resolve();
            return;
          }
          peer.write(commit.subarray(0, 3));
          peer.write(Buffer.concat([commit.subarray(3), ready]));
        });
        peer.on('error', () => {});
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No synthetic peer address');
      const proxy = await commitAckProxy(
        new URL(`postgresql://127.0.0.1:${address.port}/synthetic`),
      );
      const client = connect({ host: proxy.url.hostname, port: Number(proxy.url.port) });
      const received: Buffer[] = [];
      client.on('data', (chunk: Buffer) => {
        received.push(chunk);
        if (Buffer.concat(received).length >= commit.length + ready.length) frameSeen.resolve();
      });
      client.on('error', () => {});
      const closed = new Promise<void>((resolve) => client.once('close', resolve));
      try {
        const packet = Buffer.alloc(8);
        packet.writeInt32BE(8);
        packet.writeInt32BE(196608, 4);
        client.write(packet);
        await bounded(startup.promise, 'synthetic startup');
        if (armed) proxy.arm();
        client.write(Buffer.from([81, 0, 0, 0, 11, ...Buffer.from('COMMIT\0')]));
        if (armed) {
          await proxy.waitForDrop();
          await bounded(closed, 'synthetic client close');
          expect(Buffer.concat(received)).toEqual(Buffer.alloc(0));
          expect(proxy.log.events.map((event) => event.event)).toEqual([
            'COMMIT_forwarded_to_server',
            'server_CommandComplete_received',
            'COMMIT_ACK_withheld_transport_destroyed',
          ]);
        } else {
          await bounded(frameSeen.promise, 'synthetic ACK forwarding');
          expect(Buffer.concat(received)).toEqual(Buffer.concat([commit, ready]));
          expect(proxy.log.events).toEqual([]);
        }
      } finally {
        client.destroy();
        await proxy.close();
        for (const peer of peers) peer.destroy();
        await bounded(
          new Promise<void>((resolve) => server.close(() => resolve())),
          'synthetic server close',
        );
      }
    },
  );
});
