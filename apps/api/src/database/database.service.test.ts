import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock('@authcore/db', async (original) => ({
  ...(await original<typeof import('@authcore/db')>()),
  createDatabaseClient: () => state.client,
}));
import { DatabaseService } from './database.service.js';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
function setup() {
  vi.stubEnv('DATABASE_URL', 'postgresql://localhost/authcore_test');
  vi.stubEnv('REDIS_URL', 'redis://localhost:6380');
  vi.stubEnv('WEB_ORIGIN', 'http://localhost:3000');
  const pool = new EventEmitter();
  state.client = { pool };
  return { pool, service: new DatabaseService() };
}
it('owns idle pool errors without serializing raw error or client secrets', () => {
  const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  const { pool, service } = setup();
  const poison = {
    toJSON() {
      throw new Error('client serialization forbidden');
    },
  };
  expect(() => pool.emit('error', new Error('sensitive-test-sentinel'), poison)).not.toThrow();
  expect(warn).toHaveBeenCalledExactlyOnceWith({ event: 'database.idle_connection_error' });
  expect(service.connectionDiagnostics()).toEqual({ idleErrors: 1, loggingFaults: 0 });
});
it('a failing log sink cannot interrupt idle eviction or pool waiter progress', () => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
    throw new Error('sink failure');
  });
  const { pool, service } = setup();
  let observed = false;
  pool.on('error', () => {
    observed = true;
  });
  expect(() => pool.emit('error', new Error('sensitive-test-sentinel'))).not.toThrow();
  expect(observed).toBe(true);
  expect(service.connectionDiagnostics()).toEqual({ idleErrors: 1, loggingFaults: 1 });
});
