import 'reflect-metadata';

import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { GlobalExceptionFilter } from '../common/filters/global-exception.filter.js';
import { DatabaseService } from '../database/database.service.js';
import { HealthController } from './health.controller.js';

const databaseService = { checkConnection: vi.fn() };

@Module({
  controllers: [HealthController],
  providers: [{ provide: DatabaseService, useValue: databaseService }],
})
class HealthTestModule {}

describe('Health HTTP integration', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    // tsx/esbuild does not emit design:paramtypes in the development server.
    // Keep explicit injection metadata, but remove the test runner's type metadata.
    Reflect.deleteMetadata('design:paramtypes', HealthController);
    // Preload the real HTTP adapter during module import; retain the strict hook deadline.
    app = await NestFactory.create(HealthTestModule, new ExpressAdapter(), { logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  beforeEach(() => {
    databaseService.checkConnection.mockReset().mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('injects the database service and returns readiness over HTTP', async () => {
    const response = await fetch(`${baseUrl}/api/v1/health/ready`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      service: 'authcore-api',
      database: 'ok',
    });
    expect(databaseService.checkConnection).toHaveBeenCalledOnce();
  });

  it('redacts database failures while keeping liveness available', async () => {
    databaseService.checkConnection.mockRejectedValueOnce(new Error('private database details'));

    const response = await fetch(`${baseUrl}/api/v1/health/ready`);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal server error',
      },
    });
    expect(databaseService.checkConnection).toHaveBeenCalledOnce();

    const liveness = await fetch(`${baseUrl}/api/v1/health`);
    expect(liveness.status).toBe(200);
    expect(await liveness.json()).toEqual({
      status: 'ok',
      service: 'authcore-api',
    });
    expect(databaseService.checkConnection).toHaveBeenCalledOnce();
  });
});
