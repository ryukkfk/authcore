import {
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
  type OnModuleInit,
} from '@nestjs/common';
import { parseEnvironment } from '@authcore/config';
import type { SignupHmacConfiguration } from '@authcore/crypto';
import { DatabaseService } from '../database/database.service.js';
import { createSignupReservationBoundary } from './signup-reservation.js';
import { IdempotentSignupService, type SignupProtocolResponse } from './signup-protocol.service.js';

export interface SignupInput {
  email: string;
  password: string;
}
export interface SignupRuntimeConfiguration {
  readonly hmac: SignupHmacConfiguration;
  readonly executionWindowMs: number;
}
export const SIGNUP_CONFIGURATION = Symbol('SIGNUP_CONFIGURATION');

/** Explicit DI wiring only. No environment secret source, fallback or anchor creation. */
@Injectable()
export class SignupService implements OnModuleInit {
  private readonly enabled = parseEnvironment(process.env).SIGNUP_ENABLED;
  private protocol?: IdempotentSignupService;
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Optional()
    @Inject(SIGNUP_CONFIGURATION)
    private readonly configuration?: SignupRuntimeConfiguration,
  ) {}
  async onModuleInit(): Promise<void> {
    if (!this.enabled) return;
    if (!this.configuration) throw new Error('SIGNUP_HMAC_CONFIGURATION_REQUIRED');
    const boundary = await createSignupReservationBoundary(this.database.getClient(), {
      enabled: this.enabled,
      ...(this.configuration
        ? {
            configuration: this.configuration.hmac,
            executionWindowMs: this.configuration.executionWindowMs,
          }
        : {}),
    });
    if (boundary) this.protocol = new IdempotentSignupService(this.database.getClient(), boundary);
  }
  async signup(
    input: SignupInput,
    rawKey: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<SignupProtocolResponse> {
    if (!this.protocol) throw new ServiceUnavailableException('Signup temporarily unavailable');
    return this.protocol.start(rawKey, input, options).response;
  }
}
