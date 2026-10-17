import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MODULE_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it, vi } from 'vitest';
import { UserRepository } from '@authcore/db';
import { DatabaseModule } from '../database/database.module.js';
import { DatabaseService } from '../database/database.service.js';
import { IdentityModule } from './identity.module.js';
import { IdentityService } from './identity.service.js';

describe('PB-001 production account writer boundary', () => {
  it('exports identity lookup and admitted signup without a pool-bound user writer provider', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, IdentityModule)).toContain(IdentityService);
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, DatabaseModule)).toEqual([DatabaseService]);
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, DatabaseModule)).toEqual([
      DatabaseService,
    ]);
  });

  it('gives the exported read service only a frozen lookup capability', async () => {
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, IdentityModule) as unknown[];
    const provider = providers.find(
      (value) =>
        typeof value === 'object' &&
        value !== null &&
        'provide' in value &&
        value.provide === IdentityService,
    ) as
      { useFactory: (database: DatabaseService) => IdentityService; inject: unknown[] } | undefined;
    expect(provider?.inject).toEqual([DatabaseService]);
    expect(provider?.useFactory).toBeTypeOf('function');
    const user = { id: 'read-only-fixture' };
    const lookup = vi
      .spyOn(UserRepository.prototype, 'findByNormalizedEmail')
      .mockResolvedValue(user as never);
    try {
      const service = provider!.useFactory({ getClient: () => ({ db: {} }) } as DatabaseService);
      expect(Object.getOwnPropertyNames(IdentityService.prototype).sort()).toEqual([
        'constructor',
        'findUserByEmail',
      ]);
      const capabilities = Object.values(service) as object[];
      expect(capabilities).toHaveLength(1);
      expect(Object.isFrozen(capabilities[0])).toBe(true);
      expect(Object.keys(capabilities[0]!)).toEqual(['findByNormalizedEmail']);
      expect(await service.findUserByEmail(' Reader@Example.COM ')).toBe(user);
      expect(lookup).toHaveBeenCalledExactlyOnceWith('reader@example.com');
    } finally {
      lookup.mockRestore();
    }
  });

  it(
    'reconciles all production persistence writers and privileged consumers across applications and packages',
    { timeout: 20000 },
    () => {
      const root = fileURLToPath(new URL('../../../../', import.meta.url));
      const output = execFileSync(process.execPath, ['scripts/verify-account-writers.mjs'], {
        cwd: root,
        encoding: 'utf8',
        // This starts a TypeScript AST scan in another Node process. Cold Windows
        // startup can exceed Vitest's 5s default; bound the actual child as well.
        // No inventory assertion or application security deadline is changed.
        timeout: 15000,
      });
      expect(output).toContain('ACCOUNT_WRITERS PASS');
    },
  );
});
