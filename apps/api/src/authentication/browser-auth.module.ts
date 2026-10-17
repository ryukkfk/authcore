import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module.js';
import { BrowserAuthController } from './browser-auth.controller.js';
import { BrowserAuthService } from './browser-auth.service.js';
@Module({
  imports: [RedisModule],
  controllers: [BrowserAuthController],
  providers: [BrowserAuthService],
})
export class BrowserAuthModule {}
