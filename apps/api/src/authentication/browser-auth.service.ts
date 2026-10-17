import { createHmac, createSecretKey, randomBytes, type KeyObject } from 'node:crypto';
import {
  Inject,
  Injectable,
  HttpException,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
  type OnModuleInit,
  type BeforeApplicationShutdown,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { createDatabaseClient, BrowserSessionRepository, type DatabaseClient } from '@authcore/db';
import { createSessionCredential, hashPassword, verifyPassword } from '@authcore/crypto';
import { RedisService } from '../redis/redis.service.js';
import { PasswordWork } from './password-work.js';

const consume = String.raw`
for i=1,#KEYS do
  if tonumber(redis.call('GET',KEYS[i]) or '0')>=tonumber(ARGV[i]) then return 0 end
end
for i=1,#KEYS do
  local n=redis.call('INCR',KEYS[i]);if n==1 then redis.call('PEXPIRE',KEYS[i],60000) end
end
return 1`;
const unavailable = () => new ServiceUnavailableException('Authentication temporarily unavailable');

@Injectable()
export class BrowserAuthService
  implements OnModuleInit, BeforeApplicationShutdown, OnApplicationShutdown
{
  private database?: DatabaseClient;
  private repository?: BrowserSessionRepository;
  private rateKey?: KeyObject;
  private dummyHash?: string;
  private initialization?: Promise<void>;
  private closing = false;
  private readonly work = new PasswordWork();
  private readonly logger = new Logger(BrowserAuthService.name);
  private loggingFaults = 0;
  constructor(@Inject(RedisService) private readonly redis: RedisService) {}
  async onModuleInit() {
    if (process.env.AUTH_DATABASE_URL) await this.ready();
  }
  private async ready() {
    if (this.closing) throw unavailable();
    this.initialization ??= (async () => {
      const connectionString = process.env.AUTH_DATABASE_URL,
        key = process.env.AUTH_RATE_HMAC_KEY,
        origin = process.env.WEB_ORIGIN;
      if (!connectionString || !key || !/^[0-9a-f]{64}$/.test(key) || !origin) throw unavailable();
      let target: URL, web: URL;
      try {
        target = new URL(connectionString);
        web = new URL(origin);
      } catch {
        throw unavailable();
      }
      if (
        !['postgres:', 'postgresql:'].includes(target.protocol) ||
        !target.username.startsWith('authcore_auth_runtime_') ||
        web.origin !== origin ||
        (process.env.NODE_ENV === 'production' && web.protocol !== 'https:')
      )
        throw unavailable();
      this.rateKey = createSecretKey(Buffer.from(key, 'hex'));
      this.dummyHash = await this.work.run(() =>
        hashPassword(randomBytes(32).toString('base64url')),
      );
      this.database = createDatabaseClient({ connectionString });
      this.database.pool.on('error', () => {
        try {
          this.logger.warn({ event: 'authentication.database_idle_error' });
        } catch {
          this.loggingFaults = Math.min(Number.MAX_SAFE_INTEGER, this.loggingFaults + 1);
        }
      });
      this.repository = new BrowserSessionRepository(this.database.pool);
    })();
    await this.initialization;
    if (this.closing) throw unavailable();
  }
  private async rate(category: 'login' | 'read' | 'session', ip: string, account?: string) {
    await this.ready();
    if (!ip) throw unavailable();
    const digest = (value: string) =>
      createHmac('sha256', this.rateKey!)
        .update(category + '\0' + value)
        .digest('hex');
    const limits =
      category === 'login'
        ? [10, 5, 30]
        : category === 'session'
          ? [20, 20, 100]
          : [200, 200, 1000];
    let result: unknown;
    try {
      const client = await this.redis.getClient();
      result = await client.eval(consume, {
        keys: [
          'authcore:{browser-auth}:' + category + ':ip:' + digest(ip),
          'authcore:{browser-auth}:' + category + ':subject:' + digest(account ?? ip),
          'authcore:{browser-auth}:' + category + ':global',
        ],
        arguments: limits.map(String),
      });
    } catch {
      throw unavailable();
    }
    if (result === 0) throw new HttpException('Too many requests', 429);
    if (result !== 1) throw unavailable();
  }
  async login(
    input: { email: string; password: string },
    context: {
      ip: string;
      previous: unknown;
      deviceLabel: string;
      requestId: string;
      signal: AbortSignal;
    },
  ) {
    await this.rate('login', context.ip, input.email.trim().toLowerCase());
    const snapshot = await this.repository!.credentials(input.email.trim().toLowerCase());
    const valid = await this.work.run(() =>
      verifyPassword(snapshot?.passwordHash ?? this.dummyHash!, input.password),
    );
    const credential = createSessionCredential();
    const account = await this.repository!.completeLogin(
      snapshot,
      valid,
      credential,
      context.previous,
      context.deviceLabel,
      context.requestId,
      context.signal,
    );
    if (context.signal.aborted) throw unavailable();
    if (!account) throw new UnauthorizedException('Invalid credentials');
    return { account, credential };
  }
  async me(credential: unknown, ip: string) {
    await this.rate('read', ip);
    const account = await this.repository!.resolve(credential);
    if (!account) throw new UnauthorizedException('Authentication required');
    return account;
  }
  async list(credential: unknown, ip: string) {
    await this.rate('read', ip);
    const sessions = await this.repository!.list(credential);
    if (!sessions) throw new UnauthorizedException('Authentication required');
    return sessions;
  }
  async revoke(
    credential: unknown,
    ip: string,
    requestId: string,
    target: 'current' | 'all' | 'others' | { id: string },
  ) {
    await this.rate('session', ip);
    const result = await this.repository!.revoke(credential, requestId, target);
    if (target !== 'current' && !result.authorized)
      throw new UnauthorizedException('Authentication required');
    return result;
  }
  async beforeApplicationShutdown() {
    this.closing = true;
    await this.work.shutdown();
  }
  async onApplicationShutdown() {
    this.closing = true;
    await this.work.shutdown();
    await this.database?.pool.end();
  }
}
