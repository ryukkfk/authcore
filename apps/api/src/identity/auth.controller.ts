import {
  Body,
  HttpException,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';

import { SignupDto } from './dto/signup.dto.js';
import type { Request } from 'express';
import { SignupKeyGuard, readSignupKey } from './signup-key.guard.js';
import { signupRequestSignal } from './signup-http.js';
import { SignupEnabledGuard } from './signup-enabled.guard.js';
import { SignupService } from './signup.service.js';
import { SignupRateLimitGuard } from './signup-rate-limit.guard.js';
import { SignupAdmissionInterceptor } from './signup-admission.interceptor.js';

interface SignupResponse {
  status: 'accepted';
}

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(SignupService)
    private readonly signupService: SignupService,
  ) {}

  @Post('signup')
  @UseGuards(SignupEnabledGuard, SignupRateLimitGuard, SignupKeyGuard)
  @UseInterceptors(SignupAdmissionInterceptor)
  @HttpCode(HttpStatus.ACCEPTED)
  async signup(@Body() input: SignupDto, @Req() request: Request): Promise<SignupResponse> {
    const signal = signupRequestSignal(request);
    const result = await this.signupService.signup(
      input,
      readSignupKey(request),
      signal ? { signal } : {},
    );
    if (result.status === 202) return result.body;
    if (result.status === 500) throw new Error('Signup internal failure');
    const message =
      result.status === 400
        ? 'Invalid signup request'
        : result.status === 409
          ? 'Idempotency key unavailable'
          : 'Signup temporarily unavailable';
    throw new HttpException(message, result.status);
  }
}
