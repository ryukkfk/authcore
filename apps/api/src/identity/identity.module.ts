import { Module, type DynamicModule } from '@nestjs/common';
import { UserRepository } from '@authcore/db';

import { DatabaseModule } from '../database/database.module.js';
import { DatabaseService } from '../database/database.service.js';
import { RedisModule } from '../redis/redis.module.js';
import { AuthController } from './auth.controller.js';
import { IdentityService } from './identity.service.js';
import { SignupEnabledGuard } from './signup-enabled.guard.js';
import { SignupRateLimitGuard } from './signup-rate-limit.guard.js';
import { SignupRateLimiter } from './signup-rate-limiter.js';
import {
  SignupService,
  SIGNUP_CONFIGURATION,
  type SignupRuntimeConfiguration,
} from './signup.service.js';
import { SignupKeyGuard } from './signup-key.guard.js';
import { SignupAdmission } from './signup-admission.js';
import { SignupAdmissionInterceptor } from './signup-admission.interceptor.js';

@Module({
  imports: [DatabaseModule, RedisModule],
  controllers: [AuthController],
  providers: [
    {
      provide: IdentityService,
      inject: [DatabaseService],
      useFactory: (database: DatabaseService) => {
        const repository = new UserRepository(database.getClient().db);
        // Export only the read capability, never the pool-bound writer object.
        return new IdentityService(
          Object.freeze({
            findByNormalizedEmail: (email: string) => repository.findByNormalizedEmail(email),
          }),
        );
      },
    },
    SignupService,
    SignupAdmission,
    SignupAdmissionInterceptor,
    SignupEnabledGuard,
    SignupKeyGuard,
    SignupRateLimiter,
    SignupRateLimitGuard,
  ],
  exports: [IdentityService, SignupService],
})
export class IdentityModule {
  /** Explicit approved composition supplies independent attested material. */
  static withSignup(configuration: SignupRuntimeConfiguration): DynamicModule {
    return {
      module: IdentityModule,
      providers: [{ provide: SIGNUP_CONFIGURATION, useValue: configuration }],
    };
  }
}
