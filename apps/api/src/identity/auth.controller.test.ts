import { describe, expect, it, vi } from 'vitest';

import { AuthController } from './auth.controller.js';
import type { SignupDto } from './dto/signup.dto.js';
import { EmailAlreadyInUseError } from './identity.errors.js';
import type { SignupService } from './signup.service.js';
import type { Request } from 'express';
const request = { rawHeaders: ['Idempotency-Key', 'public_unit_fixture_key_12345'] } as Request;

const input: SignupDto = {
  email: 'user@example.com',
  password: 'correct horse battery staple',
};

function createController() {
  const signup = vi.fn();

  const service = {
    signup,
  } as unknown as SignupService;

  return {
    controller: new AuthController(service),
    signup,
  };
}

describe('AuthController', () => {
  it('returns a generic response after signup', async () => {
    const { controller, signup } = createController();

    signup.mockResolvedValue({ status: 202, body: { status: 'accepted' } });

    await expect(controller.signup(input, request)).resolves.toEqual({
      status: 'accepted',
    });

    expect(signup).toHaveBeenCalledWith(input, 'public_unit_fixture_key_12345', {});
  });

  it('cannot fabricate acceptance from an unexpected legacy duplicate error', async () => {
    const { controller, signup } = createController();

    signup.mockRejectedValue(new EmailAlreadyInUseError());

    await expect(controller.signup(input, request)).rejects.toBeInstanceOf(EmailAlreadyInUseError);
  });

  it('does not hide unexpected failures', async () => {
    const { controller, signup } = createController();

    const error = new Error('Database unavailable');

    signup.mockRejectedValue(error);

    await expect(controller.signup(input, request)).rejects.toBe(error);
  });
});
