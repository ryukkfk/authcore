import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module.js';
import { RedisModule } from '../redis/redis.module.js';
import { AuthController } from './auth.controller.js';
import { IdentityService } from './identity.service.js';
import { SignupEnabledGuard } from './signup-enabled.guard.js';
import { SignupRateLimitGuard } from './signup-rate-limit.guard.js';
import { SignupRateLimiter } from './signup-rate-limiter.js';
import { SignupService } from './signup.service.js';
import { SignupAdmission } from './signup-admission.js';
import { SignupAdmissionInterceptor } from './signup-admission.interceptor.js';

@Module({
  imports: [DatabaseModule, RedisModule],
  controllers: [AuthController],
  providers: [
    IdentityService,
    SignupService,
    SignupAdmission,
    SignupAdmissionInterceptor,
    SignupEnabledGuard,
    SignupRateLimiter,
    SignupRateLimitGuard,
  ],
  exports: [IdentityService, SignupService],
})
export class IdentityModule {}
