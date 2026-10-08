import { type CanActivate, ForbiddenException, Injectable } from '@nestjs/common';

import { parseEnvironment } from '@authcore/config';

/** Startup snapshot: changing signup policy requires restarting the API. */
@Injectable()
export class SignupEnabledGuard implements CanActivate {
  private readonly enabled = parseEnvironment(process.env).SIGNUP_ENABLED;

  canActivate(): boolean {
    if (!this.enabled) {
      throw new ForbiddenException('Signup is disabled');
    }

    return true;
  }
}
