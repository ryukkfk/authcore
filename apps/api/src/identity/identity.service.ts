import { Injectable } from '@nestjs/common';

import {
  DuplicateUserEmailError,
  UserRepository,
  type User,
} from '@authcore/db';

import { normalizeEmail } from './email.js';
import { EmailAlreadyInUseError } from './identity.errors.js';

@Injectable()
export class IdentityService {
  constructor(
    private readonly userRepository: UserRepository,
  ) {}

  async findUserByEmail(email: string): Promise<User | null> {
    const emailNormalized = normalizeEmail(email);

    return this.userRepository.findByNormalizedEmail(
      emailNormalized,
    );
  }

  async createUser(email: string): Promise<User> {
    const emailNormalized = normalizeEmail(email);

    try {
      return await this.userRepository.create({
        email: email.trim(),
        emailNormalized,
      });
    } catch (error: unknown) {
      if (error instanceof DuplicateUserEmailError) {
        throw new EmailAlreadyInUseError();
      }

      throw error;
    }
  }
}