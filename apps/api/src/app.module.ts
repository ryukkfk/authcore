import { Module } from '@nestjs/common';

import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health/health.controller.js';
import { IdentityModule } from './identity/identity.module.js';
import { EmailVerificationModule } from './identity/email-verification.module.js';
import { BrowserAuthModule } from './authentication/browser-auth.module.js';

@Module({
  imports: [DatabaseModule, IdentityModule, EmailVerificationModule, BrowserAuthModule],
  controllers: [HealthController],
})
export class AppModule {}
