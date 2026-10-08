import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module.js';
import { IdentityService } from './identity.service.js';
import { SignupService } from './signup.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [IdentityService, SignupService],
  exports: [IdentityService, SignupService],
})
export class IdentityModule {}
