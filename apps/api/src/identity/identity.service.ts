import { Injectable } from '@nestjs/common';

import type { UserRepository, User } from '@authcore/db';

import { normalizeEmail } from './email.js';

@Injectable()
export class IdentityService {
  constructor(private readonly userRepository: Pick<UserRepository, 'findByNormalizedEmail'>) {}

  async findUserByEmail(email: string): Promise<User | null> {
    const emailNormalized = normalizeEmail(email);

    return this.userRepository.findByNormalizedEmail(emailNormalized);
  }
}
