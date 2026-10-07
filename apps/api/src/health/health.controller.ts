import { Controller, Get, Inject } from '@nestjs/common';

import { DatabaseService } from '../database/database.service.js';

export interface HealthResponse {
  status: 'ok';
  service: 'authcore-api';
}

export interface ReadinessResponse extends HealthResponse {
  database: 'ok';
}

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DatabaseService)
    private readonly databaseService: DatabaseService,
  ) {}

  @Get()
  getHealth(): HealthResponse {
    return {
      status: 'ok',
      service: 'authcore-api',
    };
  }

  @Get('ready')
  async getReadiness(): Promise<ReadinessResponse> {
    await this.databaseService.checkConnection();

    return {
      status: 'ok',
      service: 'authcore-api',
      database: 'ok',
    };
  }
}
