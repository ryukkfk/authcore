import { Module } from '@nestjs/common';

import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health/health.controller.js';
import { IdentityModule } from './identity/identity.module.js';
import { EmailVerificationModule } from './identity/email-verification.module.js';

@Module({
  imports: [DatabaseModule, IdentityModule, EmailVerificationModule],
  controllers: [HealthController],
})
export class AppModule {}
