import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';

import { SignupDto } from './dto/signup.dto.js';
import { EmailAlreadyInUseError } from './identity.errors.js';
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
  @UseGuards(SignupEnabledGuard, SignupRateLimitGuard)
  @UseInterceptors(SignupAdmissionInterceptor)
  @HttpCode(HttpStatus.ACCEPTED)
  async signup(@Body() input: SignupDto): Promise<SignupResponse> {
    try {
      await this.signupService.signup(input);
    } catch (error: unknown) {
      if (!(error instanceof EmailAlreadyInUseError)) {
        throw error;
      }
    }

    return { status: 'accepted' };
  }
}
