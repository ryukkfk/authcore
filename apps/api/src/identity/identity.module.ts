import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module.js';
import { AuthController } from './auth.controller.js';
import { IdentityService } from './identity.service.js';
import { SignupService } from './signup.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [AuthController],
  providers: [IdentityService, SignupService],
  exports: [IdentityService, SignupService],
})
export class IdentityModule {}
