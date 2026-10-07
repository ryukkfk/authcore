import { describe, expect, it, vi } from 'vitest';

import { DatabaseService } from '../database/database.service.js';
import { HealthController } from './health.controller.js';

function createController() {
  const databaseService = {
    checkConnection: vi.fn().mockResolvedValue(undefined),
  } as unknown as DatabaseService;

  return {
    controller: new HealthController(databaseService),
    databaseService,
  };
}

describe('HealthController', () => {
  it('returns the API liveness status', () => {
    const { controller } = createController();

    expect(controller.getHealth()).toEqual({
      status: 'ok',
      service: 'authcore-api',
    });
  });

  it('returns readiness when the database is available', async () => {
    const { controller, databaseService } = createController();

    await expect(controller.getReadiness()).resolves.toEqual({
      status: 'ok',
      service: 'authcore-api',
      database: 'ok',
    });

    expect(databaseService.checkConnection).toHaveBeenCalledOnce();
  });
});
