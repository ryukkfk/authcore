import { createServer, connect, type Socket } from 'node:net';

/** Test only. Never persist protocol payloads: authentication frames contain secrets. */
export class Frames {
  private buffered: Buffer = Buffer.alloc(0);
  push(chunk: Buffer): Buffer[] {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    const frames: Buffer[] = [];
    while (this.buffered.length >= 5) {
      const length = this.buffered.readInt32BE(1);
      if (length < 4 || length > 1_048_576) throw new Error('Invalid S0 protocol frame length');
      if (this.buffered.length < length + 1) break;
      frames.push(this.buffered.subarray(0, length + 1));
      this.buffered = this.buffered.subarray(length + 1);
    }
    return frames;
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export type S0Event = { sequence: number; event: string; elapsedNs: string; detail?: string };
export function trace() {
  const origin = process.hrtime.bigint();
  const events: S0Event[] = [];
  return {
    events,
    add(event: string, detail?: string) {
      events.push({
        sequence: events.length + 1,
        event,
        elapsedNs: String(process.hrtime.bigint() - origin),
        ...(detail ? { detail } : {}),
      });
    },
  };
}

/** Deadline is only a harness watchdog. Callers still own and close the actual transport. */
export async function bounded<T>(pending: Promise<T>, label: string, ms = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`S0 watchdog: ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function approvedTestUrl(value: string | undefined, applicationValue?: string): URL {
  if (!value) throw new Error('BLOCKED — dedicated TEST_DATABASE_URL unavailable');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid dedicated TEST_DATABASE_URL');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    !['', '5432'].includes(url.port) ||
    url.pathname !== '/authcore_test' ||
    url.search ||
    url.hash ||
    value === applicationValue
  )
    throw new Error('TEST_DATABASE_URL must target dedicated local port 5432 authcore_test');
  return url;
}

/** Only exact simple-query COMMIT is supported. No TLS, SQL rewriting, or runtime use. */
export async function commitAckProxy(
  target: URL,
  log = trace(),
  mode: 'close' | 'stall' = 'close',
) {
  const sockets = new Map<Socket, Promise<void>>();
  const observed = deferred<void>();
  let armed = false;
  let dropped = false;
  let failure: Error | undefined;
  const server = createServer((downstream) => {
    const upstream = connect({ host: target.hostname, port: Number(target.port || 5432) });
    const backend = new Frames();
    const frontend = new Frames();
    let startup = Buffer.alloc(0);
    let started = false;
    let commitForwarded = false;
    let connectionDropped = false;
    const fail = (error: Error) => {
      failure ??= error;
      upstream.destroy();
      downstream.destroy();
    };
    for (const socket of [upstream, downstream]) {
      sockets.set(
        socket,
        new Promise<void>((resolve) => {
          socket.once('close', () => {
            sockets.delete(socket);
            resolve();
          });
        }),
      );
      socket.on('error', fail);
    }
    downstream.on('data', (chunk: Buffer) => {
      try {
        let input = chunk;
        if (!started) {
          startup = Buffer.concat([startup, chunk]);
          if (startup.length < 4) return;
          const length = startup.readInt32BE(0);
          if (length < 8 || length > 1_048_576) throw new Error('Invalid S0 startup length');
          if (startup.length < length) return;
          if (startup.readInt32BE(4) !== 196608)
            throw new Error('S0 proxy requires plaintext protocol v3');
          upstream.write(startup.subarray(0, length));
          input = startup.subarray(length);
          startup = Buffer.alloc(0);
          started = true;
        }
        for (const frame of frontend.push(input)) {
          const isCommit = frame[0] === 81 && frame.subarray(5).equals(Buffer.from('COMMIT\0'));
          if (armed && isCommit) {
            commitForwarded = true;
            log.add('COMMIT_forwarded_to_server');
          }
          upstream.write(frame);
        }
      } catch (error) {
        fail(error as Error);
      }
    });
    upstream.on('data', (chunk: Buffer) => {
      try {
        for (const frame of backend.push(chunk)) {
          if (connectionDropped) continue;
          const isCommit = frame[0] === 67 && frame.subarray(5).equals(Buffer.from('COMMIT\0'));
          if (armed && commitForwarded && isCommit) {
            // Complete server CommandComplete was received; zero bytes of it go downstream.
            log.add('server_CommandComplete_received', 'COMMIT');
            dropped = true;
            connectionDropped = true;
            armed = false;
            log.add(
              mode === 'close'
                ? 'COMMIT_ACK_withheld_transport_destroyed'
                : 'COMMIT_ACK_withheld_transport_open',
            );
            if (mode === 'close') {
              upstream.destroy();
              downstream.destroy();
            }
            observed.resolve();
            break; // Also withhold any ReadyForQuery coalesced in the same TCP chunk.
          }
          downstream.write(frame);
        }
      } catch (error) {
        fail(error as Error);
      }
    });
    upstream.once('end', () => downstream.end());
    downstream.once('end', () => upstream.end());
    downstream.once('close', () => upstream.destroy());
    upstream.once('close', () => downstream.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('S0 proxy has no TCP address');
  const url = new URL(target);
  url.hostname = '127.0.0.1';
  url.port = String(address.port);
  return {
    url,
    log,
    arm() {
      if (dropped) throw new Error('Protocol proxy permits one fault per fixture');
      armed = true;
    },
    async waitForDrop() {
      await bounded(observed.promise, 'server COMMIT response');
      if (failure) throw failure;
      if (!dropped) throw new Error('COMMIT ACK was not dropped');
    },
    async close() {
      // Track close EVENTS from socket creation; .closed may precede their delivery.
      const closed = [...sockets.values()];
      for (const socket of sockets.keys()) socket.destroy();
      await bounded(
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
        'proxy close',
      );
      await bounded(Promise.all(closed), 'proxy socket close events');
      if (sockets.size) throw new Error('S0 proxy socket leak');
    },
  };
}
