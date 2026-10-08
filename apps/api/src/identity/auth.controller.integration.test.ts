import 'reflect-metadata';

import type { AddressInfo } from 'node:net';

import { type INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { GlobalExceptionFilter } from '../common/filters/global-exception.filter.js';
import { AuthController } from './auth.controller.js';
import { EmailAlreadyInUseError } from './identity.errors.js';
import { SignupService } from './signup.service.js';

const signup = vi.fn();

@Module({
  controllers: [AuthController],
  providers: [
    {
      provide: SignupService,
      useValue: { signup },
    },
  ],
})
class SignupHttpTestModule {}

let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  app = await NestFactory.create(SignupHttpTestModule, {
    logger: false,
  });

  app.setGlobalPrefix('api/v1');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: false,
      },
      validationError: {
        target: false,
        value: false,
      },
    }),
  );

  app.useGlobalFilters(new GlobalExceptionFilter());

  await app.listen(0, '127.0.0.1');

  const address = app.getHttpServer().address() as AddressInfo;

  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  signup.mockReset();
});

async function sendSignup(body: unknown) {
  return fetch(`${baseUrl}/api/v1/auth/signup`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

const validInput = {
  email: 'User@Example.COM',
  password: 'correct horse battery staple',
};

describe('POST /api/v1/auth/signup', () => {
  it('returns HTTP 202 for valid signup', async () => {
    signup.mockResolvedValue(undefined);

    const response = await sendSignup(validInput);

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      status: 'accepted',
    });

    expect(signup).toHaveBeenCalledWith(validInput);
  });

  it('returns the same response for duplicate email', async () => {
    signup.mockResolvedValueOnce(undefined);

    const success = await sendSignup(validInput);
    const successBody = await success.text();

    signup.mockRejectedValueOnce(new EmailAlreadyInUseError());

    const duplicate = await sendSignup(validInput);
    const duplicateBody = await duplicate.text();

    expect(success.status).toBe(202);
    expect(duplicate.status).toBe(202);
    expect(duplicateBody).toBe(successBody);
  });

  it('rejects invalid email', async () => {
    const response = await sendSignup({
      ...validInput,
      email: 'not-an-email',
    });

    expect(response.status).toBe(400);
    expect(signup).not.toHaveBeenCalled();
  });

  it('rejects short passwords', async () => {
    const response = await sendSignup({
      ...validInput,
      password: 'short',
    });

    expect(response.status).toBe(400);
    expect(signup).not.toHaveBeenCalled();
  });

  it('rejects unexpected request properties', async () => {
    const response = await sendSignup({
      ...validInput,
      role: 'admin',
    });

    expect(response.status).toBe(400);
    expect(signup).not.toHaveBeenCalled();
  });

  it('does not modify password whitespace', async () => {
    signup.mockResolvedValue(undefined);

    const password = '  correct horse battery staple  ';

    const response = await sendSignup({
      email: ' User@Example.COM ',
      password,
    });

    expect(response.status).toBe(202);

    expect(signup).toHaveBeenCalledWith({
      email: 'User@Example.COM',
      password,
    });
  });

  it('sanitizes unexpected server errors', async () => {
    signup.mockRejectedValue(new Error('Sensitive database connection details'));

    const response = await sendSignup(validInput);
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toContain('INTERNAL_SERVER_ERROR');
    expect(body).not.toContain('Sensitive database connection details');
    expect(body).not.toContain(validInput.password);
  });
});
