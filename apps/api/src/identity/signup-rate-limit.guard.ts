import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { SignupRateLimiter } from './signup-rate-limiter.js';

@Injectable()
export class SignupRateLimitGuard implements CanActivate {
  constructor(
    @Inject(SignupRateLimiter)
    private readonly limiter: SignupRateLimiter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    // Use the actual socket peer, not client-supplied proxy headers.
    const remoteAddress = request.socket?.remoteAddress;

    if (!remoteAddress) {
      throw new ServiceUnavailableException('Signup temporarily unavailable');
    }

    let result;

    try {
      result = await this.limiter.consume(remoteAddress);
    } catch {
      // Redis errors must not bypass rate limiting or leak details.
      throw new ServiceUnavailableException('Signup temporarily unavailable');
    }

    if (!result.allowed) {
      response.setHeader('Retry-After', String(result.retryAfterSeconds));

      throw new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS);
    }

    return true;
  }
}
