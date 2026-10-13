import { EventEmitter } from 'node:events';
import { Pool, type Client, type PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Receipt {
  removed: true;
  transportSettled: true;
  readonly diagnostics: readonly { event: string; error: unknown }[];
}
type OwnedClient = PoolClient & { dispose(): Promise<Receipt> };

class Transport extends EventEmitter {
  connection = {
    stream: {
      destroy: () => {
        this._ending = true;
      },
    },
  };
  _queryable = true;
  _ending = false;
  closed = false;
  endCalls = 0;
  holdClose = false;
  static holdConnect = false;
  static connectError: Error | undefined;
  static instances: Transport[] = [];
  connectCallback?: (error?: Error) => void;
  closeCallback?: () => void;
  constructor() {
    super();
    Transport.instances.push(this);
  }
  connect(callback: (error?: Error) => void) {
    this.connectCallback = callback;
    if (!Transport.holdConnect) callback(Transport.connectError);
  }
  query(_text: string, _values: unknown, callback: (error: null, value: unknown) => void) {
    callback(null, { command: 'SELECT', rows: [] });
  }
  finishClose() {
    if (this.closed) return;
    this.closed = true;
    this.emit('end');
    this.closeCallback?.();
  }
  end(callback: () => void) {
    this.endCalls++;
    this._ending = true;
    this.closeCallback = callback;
    if (!this.holdClose) this.finishClose();
  }
  terminate() {
    this._ending = true;
    this.finishClose();
    return Promise.resolve({ transportSettled: true, queriesSettled: true });
  }
}
const createPool = () =>
  new Pool({
    Client: Transport as unknown as typeof Client,
    max: 1,
    idleTimeoutMillis: 0,
    connectionTimeoutMillis: 500,
  });
afterEach(() => {
  vi.useRealTimers();
  Transport.holdConnect = false;
  Transport.connectError = undefined;
  Transport.instances = [];
});

describe('A1 driver-owned disposal acceptance, synthetic transport', () => {
  it('release-listener exception cannot strand the consumed checkout', async () => {
    const pool = createPool();
    const client = (await pool.connect()) as OwnedClient;
    const fault = new Error('controlled release observer failure');
    pool.once('release', () => {
      throw fault;
    });
    expect(() => client.release(true)).toThrow(fault);
    expect(typeof client.dispose).toBe('function');
    const first = client.dispose();
    expect(client.dispose()).toBe(first);
    expect(await first).toMatchObject({ removed: true, transportSettled: true });
    expect((await first).diagnostics).toContainEqual({ event: 'release', error: fault });
    expect(() => client.release(true)).toThrow('already been released');
    expect(pool.totalCount).toBe(0);
    await pool.end();
  });
  it('remove-listener exception preserves waiter progress and shutdown', async () => {
    const pool = createPool();
    const first = (await pool.connect()) as OwnedClient;
    const waiting = pool.connect();
    const fault = new Error('controlled removal observer failure');
    pool.once('remove', () => {
      throw fault;
    });
    const receipt = await first.dispose();
    expect(receipt.diagnostics).toContainEqual({ event: 'remove', error: fault });
    const next = (await waiting) as OwnedClient;
    expect(next).not.toBe(first);
    await next.dispose();
    await pool.end();
  });
  it('normal release reuses capacity and stale dispose cannot evict a later checkout', async () => {
    const pool = createPool();
    const first = (await pool.connect()) as OwnedClient;
    const dispose = first.dispose;
    first.release();
    const next = (await pool.connect()) as OwnedClient;
    expect(next).toBe(first);
    await expect(dispose()).rejects.toThrow('returned');
    await next.dispose();
    await pool.end();
  });
  it.each(['connect', 'acquire'] as const)(
    '%s observer fault rejects checkout and settles ownership',
    async (event) => {
      const pool = createPool();
      const fault = new Error('controlled acquisition observer failure');
      pool.once(event, () => {
        throw fault;
      });
      await expect(pool.connect()).rejects.toBe(fault);
      await pool.end();
      expect(pool.totalCount).toBe(0);
    },
  );
  it('shutdown rejects queued waiters instead of abandoning promises', async () => {
    const pool = createPool();
    const first = (await pool.connect()) as OwnedClient;
    const queued = pool.connect().catch((error: unknown) => error);
    const ending = pool.end();
    expect(await queued).toBeInstanceOf(Error);
    await first.dispose();
    await ending;
    expect(pool.waitingCount).toBe(0);
  });
  it('closing transport consumes capacity and blocks successful shutdown', async () => {
    const pool = createPool();
    const first = (await pool.connect()) as OwnedClient;
    (first as unknown as Transport).holdClose = true;
    first.release(true);
    let delivered = false;
    const waiting = pool.connect().then((client) => {
      delivered = true;
      return client as OwnedClient;
    });
    await Promise.resolve();
    expect(delivered).toBe(false);
    expect((pool as Pool & { closingCount: number }).closingCount).toBe(1);
    (first as unknown as Transport).finishClose();
    const next = await waiting;
    await next.dispose();
    await pool.end();
  });
  it('dispose consumes release exactly once, including reentrant release observers', async () => {
    const pool = createPool();
    const client = (await pool.connect()) as OwnedClient;
    let disposal: Promise<Receipt> | undefined;
    pool.once('release', () => {
      disposal = client.dispose();
    });
    client.release();
    expect(await disposal).toMatchObject({ removed: true, transportSettled: true });
    expect(pool.idleCount).toBe(0);
    expect(() => client.release()).toThrow('already been released');
    await pool.end();
  });
  it('dispose racing repeated remove callbacks settles once', async () => {
    const pool = createPool();
    const client = (await pool.connect()) as OwnedClient;
    const removal = vi.fn();
    pool.on('remove', removal);
    const receipt = client.dispose();
    expect(client.dispose()).toBe(receipt);
    await receipt;
    (client as unknown as Transport).closeCallback?.();
    expect(removal).toHaveBeenCalledOnce();
    await pool.end();
  });
  it('async release observer is rejected safely and its rejection is observed', async () => {
    const pool = createPool();
    const client = (await pool.connect()) as OwnedClient;
    const fault = new Error('late observer failure');
    pool.once('release', async () => {
      throw fault;
    });
    expect(() => client.release()).toThrow('Async pool lifecycle observer');
    const receipt = await client.dispose();
    expect(receipt.diagnostics).toContainEqual({ event: 'release', error: fault });
    await pool.end();
  });
  it('all remove observers are isolated even if an earlier one throws', async () => {
    const pool = createPool();
    const client = (await pool.connect()) as OwnedClient;
    pool.once('remove', () => {
      throw new Error('first remove observer');
    });
    const second = vi.fn();
    pool.once('remove', second);
    await client.dispose();
    expect(second).toHaveBeenCalledOnce();
    await pool.end();
  });
  it('pool.query success is not hidden by release-event failure or double release', async () => {
    const pool = createPool();
    pool.once('release', () => {
      throw new Error('controlled query cleanup failure');
    });
    await expect(pool.query('SELECT 1')).resolves.toMatchObject({ command: 'SELECT' });
    await pool.end();
    expect(pool.totalCount).toBe(0);
  });
  it('shutdown retains late connection callback ownership and never delivers late SQL work', async () => {
    Transport.holdConnect = true;
    const pool = createPool();
    const checkout = pool.connect().catch((error) => error);
    let ended = false;
    const ending = pool.end().then(() => {
      ended = true;
    });
    expect(await checkout).toBeInstanceOf(Error);
    await Promise.resolve();
    expect(ended).toBe(false);
    Transport.instances[0]!.connectCallback?.();
    await ending;
    expect(pool.totalCount).toBe(0);
  });
  it('connection failure disposes its transport, progresses queue, and shuts down', async () => {
    Transport.connectError = new Error('controlled connect failure');
    const pool = createPool();
    await expect(pool.connect()).rejects.toBe(Transport.connectError);
    await pool.end();
    expect(Transport.instances[0]!.closed).toBe(true);
  });
  it('onConnect rejection disposes without waiting for an application release', async () => {
    const fault = new Error('controlled onConnect rejection');
    const pool = new Pool({
      Client: Transport as unknown as typeof Client,
      max: 1,
      idleTimeoutMillis: 0,
      onConnect: async () => {
        throw fault;
      },
    });
    await expect(pool.connect()).rejects.toBe(fault);
    await pool.end();
    expect(Transport.instances[0]!.closed).toBe(true);
  });
  it('cleanup deadline never labels an unsettled transport clean or frees capacity', async () => {
    vi.useFakeTimers();
    const pool = createPool();
    const client = (await pool.connect()) as OwnedClient;
    const transport = client as unknown as Transport;
    transport.holdClose = true;
    let complete!: () => void;
    transport.terminate = () =>
      new Promise((resolve) => {
        complete = () => {
          transport.finishClose();
          resolve({ transportSettled: true, queriesSettled: true });
        };
      });
    client.release(true);
    let ended = false;
    const ending = pool.end().then(() => {
      ended = true;
    });
    await vi.advanceTimersByTimeAsync(1001);
    expect(ended).toBe(false);
    expect((pool as Pool & { closingCount: number }).closingCount).toBe(1);
    complete();
    await ending;
  });
  it('synchronous end failure is diagnosed and terminal fallback owns the transport', async () => {
    const pool = createPool();
    const client = (await pool.connect()) as OwnedClient;
    const fault = new Error('controlled end failure');
    (client as unknown as Transport).end = () => {
      throw fault;
    };
    client.release(true);
    expect((await client.dispose()).diagnostics).toContainEqual({ event: 'end', error: fault });
    await pool.end();
  });
  it('idle network failure removes the client and progresses waiting capacity', async () => {
    const pool = createPool();
    const client = (await pool.connect()) as OwnedClient;
    const errors = vi.fn();
    pool.on('error', errors);
    client.release();
    client.emit('error', new Error('controlled idle network error'));
    const next = (await pool.connect()) as OwnedClient;
    expect(next).not.toBe(client);
    expect(errors).toHaveBeenCalledOnce();
    await next.dispose();
    await pool.end();
  });
  it('release and remove failures remain separate diagnostics without a lost receipt', async () => {
    const pool = createPool();
    const client = (await pool.connect()) as OwnedClient;
    const first = new Error('release fault');
    const second = new Error('remove fault');
    pool.once('release', () => {
      throw first;
    });
    pool.once('remove', () => {
      throw second;
    });
    expect(() => client.release()).toThrow(first);
    const receipt = await client.dispose();
    expect(receipt.diagnostics).toContainEqual({ event: 'release', error: first });
    expect(receipt.diagnostics).toContainEqual({ event: 'remove', error: second });
    await pool.end();
  });
  it('shutdown with an idle client awaits its late transport close', async () => {
    const pool = createPool();
    const client = (await pool.connect()) as OwnedClient;
    (client as unknown as Transport).holdClose = true;
    client.release();
    let settled = false;
    const ending = pool.end().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    (client as unknown as Transport).finishClose();
    await ending;
    expect(settled).toBe(true);
  });
  it('shutdown rejects all FIFO waiters even if an application callback throws', async () => {
    const pool = createPool();
    const client = (await pool.connect()) as OwnedClient;
    const second = pool.connect().catch((error) => error);
    pool.connect(() => {
      throw new Error('application callback fault');
    });
    const fourth = pool.connect().catch((error) => error);
    const ending = pool.end();
    expect(await second).toBeInstanceOf(Error);
    expect(await fourth).toBeInstanceOf(Error);
    await client.dispose();
    await ending;
    expect(pool.waitingCount).toBe(0);
  });
  it('throwing diagnostic logger cannot interrupt any pool transition', async () => {
    const pool = new Pool({
      Client: Transport as unknown as typeof Client,
      max: 1,
      idleTimeoutMillis: 0,
      log: () => {
        throw new Error('diagnostic logger fault');
      },
    });
    const client = (await pool.connect()) as OwnedClient;
    await client.dispose();
    await pool.end();
    expect(pool.totalCount).toBe(0);
  });
  it('shutdown owns pending onConnect completion and rejects before late checkout', async () => {
    let finish!: () => void;
    const pool = new Pool({
      Client: Transport as unknown as typeof Client,
      max: 1,
      idleTimeoutMillis: 0,
      onConnect: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });
    const pending = pool.connect().catch((error) => error);
    const ending = pool.end();
    expect(await pending).toBeInstanceOf(Error);
    finish();
    await ending;
    expect(pool.totalCount).toBe(0);
  });
  it('late successful connection callback after timeout cannot deliver a checkout', async () => {
    vi.useFakeTimers();
    Transport.holdConnect = true;
    const pool = createPool();
    const pending = pool.connect().catch((error) => error);
    await vi.advanceTimersByTimeAsync(500);
    Transport.instances[0]!.connectCallback?.();
    expect(await pending).toBeInstanceOf(Error);
    await pool.end();
  });
  it('throwing a non-Error cannot silently return a failed client to idle', async () => {
    const pool = createPool();
    const client = (await pool.connect()) as OwnedClient;
    pool.once('release', () => {
      throw undefined;
    });
    expect(() => client.release()).toThrow('Pool lifecycle observer threw');
    expect(await client.dispose()).toMatchObject({ removed: true });
    await pool.end();
  });
  it('asynchronous logger rejection is observed outside mandatory transitions', async () => {
    const pool = new Pool({
      Client: Transport as unknown as typeof Client,
      max: 1,
      idleTimeoutMillis: 0,
      log: async () => {
        throw new Error('async log fault');
      },
    });
    const client = (await pool.connect()) as OwnedClient;
    await client.dispose();
    await pool.end();
    await Promise.resolve();
  });
});
