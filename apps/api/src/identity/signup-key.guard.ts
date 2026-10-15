import {
  BadRequestException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';

export function readSignupKey(request: Pick<Request, 'rawHeaders'>): string {
  let value: string | undefined;
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    if (request.rawHeaders[i]?.toLowerCase() !== 'idempotency-key') continue;
    if (value !== undefined) throw new BadRequestException('Invalid Idempotency-Key');
    value = request.rawHeaders[i + 1];
  }
  if (
    typeof value !== 'string' ||
    value.length < 16 ||
    value.length > 128 ||
    /[^A-Za-z0-9_-]/.test(value)
  )
    throw new BadRequestException('Invalid Idempotency-Key');
  return value;
}
@Injectable()
export class SignupKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    readSignupKey(context.switchToHttp().getRequest<Request>());
    return true;
  }
}
