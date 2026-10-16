import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module.js';
import { EmailVerificationController } from './email-verification.controller.js';
import { EmailVerificationService } from './email-verification.service.js';

@Module({
  imports: [RedisModule],
  controllers: [EmailVerificationController],
  providers: [EmailVerificationService],
})
export class EmailVerificationModule {}
