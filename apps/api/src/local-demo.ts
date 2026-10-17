import 'reflect-metadata';
import { readFile } from 'node:fs/promises';
import { Module } from '@nestjs/common';
import { parseEnvironment } from '@authcore/config';
import { createAttestedSignupHasher, type SignupHmacMetadata } from '@authcore/crypto';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health/health.controller.js';
import { IdentityModule } from './identity/identity.module.js';
import { BrowserAuthModule } from './authentication/browser-auth.module.js';
import { EmailVerificationModule } from './identity/email-verification.module.js';
import { startApi } from './bootstrap.js';

async function main() {
  if (process.env.NODE_ENV !== 'development' || process.env.AUTHCORE_LOCAL_DEMO !== 'true')
    throw new Error('LOCAL_DEMO_EXPLICIT_ENABLEMENT_REQUIRED');
  const value = JSON.parse(
    await readFile(new URL('../../../.local-demo/api.json', import.meta.url), 'utf8'),
  );
  const metadata = JSON.parse(
    await readFile(new URL('../../../.local-demo/attestation.json', import.meta.url), 'utf8'),
  ) as SignupHmacMetadata;
  if (
    value.localDemo !== true ||
    !/^[0-9a-f]{64}$/.test(value.hmacSecret) ||
    !/^[0-9a-f]{64}$/.test(value.authRateKey) ||
    !Number.isInteger(value.apiPort) ||
    value.apiPort < 1024 ||
    value.apiPort > 65535
  )
    throw new Error('LOCAL_DEMO_CONFIGURATION_REJECTED');
  for (const [url, principal] of [
    [value.databaseUrl, 'authcore_signup_runtime_'],
    [value.authDatabaseUrl, 'authcore_auth_runtime_'],
    [value.verificationDatabaseUrl, 'authcore_email_verifier_'],
  ]) {
    const target = new URL(url);
    if (
      target.protocol !== 'postgresql:' ||
      target.hostname !== '127.0.0.1' ||
      target.pathname !== '/authcore_demo' ||
      !target.username.startsWith(principal) ||
      target.search ||
      target.hash
    )
      throw new Error('LOCAL_DEMO_DATABASE_REJECTED');
  }
  const redis = new URL(value.redisUrl),
    web = new URL(value.webOrigin);
  if (
    redis.protocol !== 'redis:' ||
    redis.hostname !== '127.0.0.1' ||
    redis.pathname !== '/0' ||
    redis.username ||
    redis.password ||
    redis.search ||
    redis.hash ||
    web.protocol !== 'http:' ||
    web.hostname !== '127.0.0.1' ||
    web.origin !== value.webOrigin
  )
    throw new Error('LOCAL_DEMO_ORIGIN_REJECTED');
  const hmac = { secret: Buffer.from(value.hmacSecret, 'hex'), metadata };
  createAttestedSignupHasher(hmac);
  Object.assign(process.env, {
    DATABASE_URL: value.databaseUrl,
    AUTH_DATABASE_URL: value.authDatabaseUrl,
    VERIFICATION_DATABASE_URL: value.verificationDatabaseUrl,
    AUTH_RATE_HMAC_KEY: value.authRateKey,
    REDIS_URL: value.redisUrl,
    WEB_ORIGIN: value.webOrigin,
    API_HOST: '127.0.0.1',
    API_PORT: String(value.apiPort),
    SIGNUP_ENABLED: 'true',
  });
  @Module({
    imports: [
      DatabaseModule,
      IdentityModule.withSignup({ hmac, executionWindowMs: 86400000 }),
      BrowserAuthModule,
      EmailVerificationModule,
    ],
    controllers: [HealthController],
  })
  class LocalDemoModule {}
  const app = await startApi(LocalDemoModule, parseEnvironment(process.env));
  let closing: Promise<void> | undefined;
  process.on('message', (message) => {
    if (message === 'authcore:shutdown') {
      closing ??= app.close().then(() => {
        process.disconnect?.();
      });
      void closing.catch(() => {
        process.exitCode = 1;
        process.disconnect?.();
      });
    }
  });
  process.send?.('authcore:ready');
}
void main().catch(() => {
  process.stderr.write('{"event":"local_demo.api_startup_failed"}\n');
  process.exitCode = 1;
  process.disconnect?.();
});
