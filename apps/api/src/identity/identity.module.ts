import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module.js';
import { IdentityService } from './identity.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [IdentityService],
  exports: [IdentityService],
})
export class IdentityModule {}