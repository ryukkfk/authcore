import {
  BadRequestException,
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { from, lastValueFrom } from 'rxjs';

import { SignupAdmission, SignupAdmissionUnavailable } from './signup-admission.js';
import { setSignupRequestSignal } from './signup-http.js';

@Injectable()
export class SignupAdmissionInterceptor implements NestInterceptor {
  constructor(@Inject(SignupAdmission) private readonly admission: SignupAdmission) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const cancellation = new AbortController();
    const abort = () => cancellation.abort();
    const disconnected = () => {
      if (!response.writableFinished) abort();
    };
    request.once('aborted', abort);
    response.once('close', disconnected);
    // Rate limiting may have awaited after the client already disconnected.
    if (request.aborted || response.destroyed || request.socket.destroyed) abort();
    setSignupRequestSignal(request, cancellation.signal);
    const remove = () => {
      request.removeListener('aborted', abort);
      response.removeListener('close', disconnected);
    };
    let operation: ReturnType<SignupAdmission['start']>;
    try {
      operation = this.admission.start(() => {
        // Reject recursive/non-string graphs before class-transformer, after admission.
        const body: unknown = request.body;
        if (
          !body ||
          typeof body !== 'object' ||
          Array.isArray(body) ||
          Object.keys(body).length !== 2 ||
          !Object.hasOwn(body, 'email') ||
          !Object.hasOwn(body, 'password') ||
          typeof (body as { email?: unknown }).email !== 'string' ||
          typeof (body as { password?: unknown }).password !== 'string'
        )
          throw new BadRequestException('Invalid signup request');
        return lastValueFrom(next.handle());
      });
    } catch (error) {
      remove();
      if (error instanceof SignupAdmissionUnavailable) response.setHeader('Retry-After', '1');
      throw error;
    }
    void operation.settlement.then(remove, remove);
    return from(
      operation.response.catch((error: unknown) => {
        if (error instanceof SignupAdmissionUnavailable) {
          context.switchToHttp().getResponse<Response>().setHeader('Retry-After', '1');
        }
        throw error;
      }),
    );
  }
}
