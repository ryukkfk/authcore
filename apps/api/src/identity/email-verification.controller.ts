import { createHash, createHmac } from 'node:crypto';
import { isEmail, maxLength } from 'class-validator';
import {
  Body,
  BadRequestException,
  Controller,
  HttpException,
  HttpCode,
  Inject,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Request } from 'express';
import { verificationTokenDigest } from '@authcore/crypto';
import { RedisService } from '../redis/redis.service.js';
import { EmailVerificationService } from './email-verification.service.js';
import { emailVerificationRequestId } from './email-verification.http.js';
import { normalizeEmail } from './email.js';

const consume = `
for i=1,#KEYS do
  if tonumber(redis.call('GET',KEYS[i]) or '0') >= tonumber(ARGV[i]) then return 0 end
end
for i=1,#KEYS do
  local n=redis.call('INCR',KEYS[i])
  if n==1 then redis.call('PEXPIRE',KEYS[i],ARGV[4]) end
end
return 1`;

@Controller('auth')
export class EmailVerificationController {
  constructor(
    @Inject(EmailVerificationService) private readonly verification: EmailVerificationService,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {}

  @Post('resend-verification')
  @HttpCode(202)
  async resend(@Body() input: unknown, @Req() request: Request): Promise<{ status: 'accepted' }> {
    // Public request, not a session-authenticated operation. Eligibility is never
    // returned; the database outbox records a request only when policy permits.
    const origin = request.headers.origin;
    if (origin && origin !== process.env.WEB_ORIGIN)
      throw new HttpException('Request origin rejected', 403);
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).length !== 1 ||
      !('email' in input) ||
      typeof input.email !== 'string' ||
      !maxLength(input.email.trim(), 254) ||
      !isEmail(input.email.trim())
    )
      throw new BadRequestException('Invalid verification request');
    const key = process.env.AUTH_RATE_HMAC_KEY,
      ip = request.socket.remoteAddress;
    if (!key || !/^[0-9a-f]{64}$/.test(key) || !ip)
      throw new ServiceUnavailableException('Verification temporarily unavailable');
    const normalized = normalizeEmail(input.email);
    const fingerprint = (category: string, value: string) =>
      createHmac('sha256', Buffer.from(key, 'hex'))
        .update(JSON.stringify(['verification.resend.v1', category, value]))
        .digest('hex');
    let allowed: unknown;
    try {
      const client = await this.redis.getClient();
      allowed = await client.eval(consume, {
        keys: [
          'authcore:{verify-resend}:ip:' + fingerprint('ip', ip),
          'authcore:{verify-resend}:account:' + fingerprint('account', normalized),
          'authcore:{verify-resend}:global',
        ],
        arguments: ['10', '3', '100', '60000'],
      });
    } catch {
      throw new ServiceUnavailableException('Verification temporarily unavailable');
    }
    if (allowed === 0) throw new HttpException('Too many requests', 429);
    if (allowed !== 1)
      throw new ServiceUnavailableException('Verification temporarily unavailable');
    try {
      await this.verification.resend(normalized, emailVerificationRequestId(request));
    } catch {
      throw new ServiceUnavailableException('Verification temporarily unavailable');
    }
    return { status: 'accepted' };
  }

  @Post('verify-email')
  @HttpCode(200)
  async verify(@Body() input: unknown, @Req() request: Request): Promise<{ status: 'verified' }> {
    // Public proof-of-mailbox endpoint; no cookie authentication/session issuance.
    const origin = request.headers.origin;
    if (origin && origin !== process.env.WEB_ORIGIN)
      throw new HttpException('Request origin rejected', 403);
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).length !== 1 ||
      !('token' in input) ||
      typeof input.token !== 'string' ||
      !verificationTokenDigest(input.token)
    )
      throw new BadRequestException('Invalid verification request');
    const ip = request.socket.remoteAddress;
    if (!ip) throw new ServiceUnavailableException('Verification temporarily unavailable');
    const fingerprint = createHash('sha256').update(ip).digest('hex');
    let allowed: unknown;
    try {
      const client = await this.redis.getClient();
      allowed = await client.eval(consume, {
        keys: [
          `authcore:{verify}:ip:${fingerprint}`,
          `authcore:{verify}:token:${verificationTokenDigest(input.token)}`,
          'authcore:{verify}:global',
        ],
        arguments: ['20', '5', '100', '60000'],
      });
    } catch {
      throw new ServiceUnavailableException('Verification temporarily unavailable');
    }
    if (allowed === 0) throw new HttpException('Too many requests', 429);
    if (allowed !== 1)
      throw new ServiceUnavailableException('Verification temporarily unavailable');
    let verified: boolean;
    try {
      verified = await this.verification.verify(input.token, emailVerificationRequestId(request));
    } catch {
      throw new ServiceUnavailableException('Verification temporarily unavailable');
    }
    if (!verified) throw new BadRequestException('Verification credential unavailable');
    return { status: 'verified' };
  }
}
