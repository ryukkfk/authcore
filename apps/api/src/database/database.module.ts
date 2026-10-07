import { Module } from '@nestjs/common';

import { UserRepository } from '@authcore/db';

import { DatabaseService } from './database.service.js';

@Module({
  providers: [
    DatabaseService,
    {
      provide: UserRepository,
      inject: [DatabaseService],
      useFactory: (databaseService: DatabaseService) =>
        new UserRepository(databaseService.getClient().db),
    },
  ],
  exports: [DatabaseService, UserRepository],
})
export class DatabaseModule {}
