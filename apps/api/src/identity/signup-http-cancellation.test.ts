import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import type { ExecutionContext } from '@nestjs/common';
import type { Request, Response } from 'express';
import { defer, lastValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { SignupAdmission } from './signup-admission.js';
import { SignupAdmissionInterceptor } from './signup-admission.interceptor.js';
import { signupRequestSignal } from './signup-http.js';
import type { RedisService } from '../redis/redis.service.js';
describe('S5 cancellation already observed before interceptor entry', () => {
  it.each(['response', 'socket', 'request', 'healthy'] as const)(
    'captures initial %s state before starting business work',
    async (kind) => {
      const request = Object.assign(new EventEmitter(), {
        body: { email: 'unit@example.com', password: 'public fixture password' },
        socket: { destroyed: kind === 'socket' },
        aborted: kind === 'request',
      }) as unknown as Request;
      const response = Object.assign(new EventEmitter(), {
        destroyed: kind === 'response',
        writableFinished: false,
      }) as unknown as Response;
      const context = {
        switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
      } as unknown as ExecutionContext;
      const admission = new SignupAdmission({
        getClient: async () => ({ withCommandOptions: () => ({ eval: async () => 1 }) }),
      } as unknown as RedisService);
      const interceptor = new SignupAdmissionInterceptor(admission);
      try {
        await lastValueFrom(
          interceptor.intercept(context, {
            handle: () =>
              defer(() => {
                expect(signupRequestSignal(request)?.aborted).toBe(kind !== 'healthy');
                return of('observed');
              }),
          }),
        );
      } finally {
        await admission.onApplicationShutdown();
      }
    },
  );
});
