import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';

import { parseEnvironment } from '@authcore/config';
import { createClient, TimeoutError } from 'redis';

type NodeRedisClient = ReturnType<typeof createClient>;
type CommandOptions = Parameters<NodeRedisClient['withCommandOptions']>[0];
const COMMANDS = [
  'eval',
  'sendCommand',
  'ping',
  'get',
  'set',
  'del',
  'exists',
  'pTTL',
  'pExpire',
  'lPush',
  'zAdd',
  'zCard',
  'zRange',
  'zScore',
] as const;
type RedisCommands = Pick<NodeRedisClient, (typeof COMMANDS)[number] | 'isOpen' | 'isReady'> & {
  withCommandOptions(options: CommandOptions): RedisCommands;
};
const commandNames = new Set<PropertyKey>(COMMANDS);
const COMMAND_TIMEOUT_MS = 1000;
const CONNECT_TIMEOUT_MS = 3000;
const COOLDOWN_MS = 1000;

@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);
  private readonly url: string;
  private client: NodeRedisClient | null = null;
  private connectionPromise: Promise<void> | null = null;
  private retryAt = 0;
  private stopped = false;
  private readonly connected = new WeakSet<NodeRedisClient>();

  constructor() {
    this.url = parseEnvironment(process.env).REDIS_URL;
  }

  private retire(client: NodeRedisClient): void {
    if (this.client === client) {
      this.client = null;
      this.retryAt = performance.now() + COOLDOWN_MS;
    }
    // destroy(), unlike close(), flushes both queued and already-sent commands.
    // Before TCP/TLS connect, node-redis has not attached the socket yet. Its
    // connectTimeout owns that phase; destroying early can leave a late socket
    // attached after destroy. The handshake deadline below owns the next phase.
    if (client.isOpen && this.connected.has(client)) client.destroy();
  }

  private async deadline<T>(
    client: NodeRedisClient,
    operation: Promise<T>,
    ms: number,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        timer = setTimeout(() => {
          this.retire(client);
          reject(new Error('Redis operation timed out'));
        }, ms);
        operation.then(resolve, reject);
      });
    } catch (error) {
      // A caller-supplied node-redis queue timeout must also retire the socket.
      if (error instanceof TimeoutError) this.retire(client);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private createConnection(): NodeRedisClient {
    const client = createClient({
      url: this.url,
      disableOfflineQueue: true,
      commandsQueueMaxLength: 128,
      // node-redis removes this queue timeout at send; deadline() also bounds replies.
      commandOptions: { timeout: COMMAND_TIMEOUT_MS },
      socket: { connectTimeout: CONNECT_TIMEOUT_MS, reconnectStrategy: false },
    });
    this.client = client;
    client.on('connect', () => {
      this.connected.add(client);
    });
    client.on('error', () => {
      this.retire(client);
      // Never log connection strings or raw errors.
      this.logger.warn('Redis connection error');
    });
    return client;
  }

  private readonly facades = new WeakMap<NodeRedisClient, RedisCommands>();

  private commands(client: NodeRedisClient, receiver = client): RedisCommands {
    // Bound the public command promise, independently of node-redis queue timers.
    // Do not expose transaction/pipeline APIs that could bypass these deadlines.
    return new Proxy({} as RedisCommands, {
      get: (_target, property) => {
        if (property === 'withCommandOptions') {
          return (options: CommandOptions) =>
            this.commands(client, receiver.withCommandOptions(options));
        }
        if (property === 'isOpen') return client.isOpen;
        if (property === 'isReady') return client.isReady;
        if (!commandNames.has(property)) return undefined;
        const value: unknown = Reflect.get(receiver, property);
        return (...args: unknown[]) => {
          if (this.stopped || this.client !== client) {
            return Promise.reject(new Error('Redis connection unavailable'));
          }
          const operation = (value as (...args: unknown[]) => Promise<unknown>).apply(
            receiver,
            args,
          );
          return this.deadline(client, operation, COMMAND_TIMEOUT_MS);
        };
      },
    });
  }

  private exposed(client: NodeRedisClient): RedisCommands {
    let commands = this.facades.get(client);
    if (!commands) {
      commands = this.commands(client);
      this.facades.set(client, commands);
    }
    return commands;
  }

  private async connect(client: NodeRedisClient): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expire: (() => void) | undefined;
    const onConnect = () => {
      timer = setTimeout(() => expire?.(), CONNECT_TIMEOUT_MS);
    };
    client.once('connect', onConnect);
    try {
      await new Promise<void>((resolve, reject) => {
        expire = () => {
          this.retire(client);
          reject(new Error('Redis handshake timed out'));
        };
        client.connect().then(() => {
          if (this.stopped || this.client !== client) {
            this.retire(client);
            reject(new Error('Redis connection unavailable'));
          } else resolve();
        }, reject);
      });
    } finally {
      clearTimeout(timer);
      client.off('connect', onConnect);
    }
  }

  async getClient(): Promise<RedisCommands> {
    if (this.stopped) throw new Error('Redis service stopped');
    if (this.client?.isReady) return this.exposed(this.client);

    if (!this.connectionPromise) {
      if (performance.now() < this.retryAt) throw new Error('Redis connection cooling down');
      // Each attempt gets a fresh generation; stale clients/timers cannot affect recovery.
      const client = this.createConnection();
      this.connectionPromise = this.connect(client)
        .catch(() => {
          this.retire(client);
          throw new Error('Redis connection unavailable');
        })
        .finally(() => {
          this.connectionPromise = null;
        });
    }
    await this.connectionPromise;
    if (this.stopped || !this.client?.isReady) throw new Error('Redis is not ready');
    return this.exposed(this.client);
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    if (this.client) this.retire(this.client);
  }
}
