import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { isSignupRequest } from '../../identity/signup-http.js';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();
    const signup = isSignupRequest(request);
    if (signup) response.setHeader('Cache-Control', 'no-store');

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (signup && status === 503) response.setHeader('Retry-After', '1');
      const exceptionResponse = exception.getResponse();

      let message = 'Request failed';

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (
        typeof exceptionResponse === 'object' &&
        exceptionResponse !== null &&
        'message' in exceptionResponse
      ) {
        const candidate = exceptionResponse.message;

        if (Array.isArray(candidate)) {
          message = candidate.map(String).join('; ');
        } else if (typeof candidate === 'string') {
          message = candidate;
        }
      }

      response.status(status).json({
        error: {
          code: `HTTP_${status}`,
          message:
            signup && status === 400 && message !== 'Invalid Idempotency-Key'
              ? 'Invalid signup request'
              : message,
        },
      });

      return;
    }

    // URLs, query strings, bodies and raw exceptions may contain credentials.
    this.logger.error({ event: 'http.unhandled_exception', method: request.method });

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal server error',
      },
    });
  }
}
