import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import { from, lastValueFrom } from 'rxjs';

import { SignupAdmission, SignupAdmissionUnavailable } from './signup-admission.js';

@Injectable()
export class SignupAdmissionInterceptor implements NestInterceptor {
  constructor(@Inject(SignupAdmission) private readonly admission: SignupAdmission) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    return from(
      this.admission
        .run(() => lastValueFrom(next.handle()))
        .catch((error: unknown) => {
          if (error instanceof SignupAdmissionUnavailable) {
            context.switchToHttp().getResponse<Response>().setHeader('Retry-After', '1');
          }
          throw error;
        }),
    );
  }
}
