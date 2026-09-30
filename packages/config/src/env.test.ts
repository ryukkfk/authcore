import { describe, expect, it } from 'vitest';

import { parseEnvironment } from './env.js';

const validEnvironment = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://authcore:authcore_dev@localhost:5432/authcore',
  REDIS_URL: 'redis://localhost:6379',
  API_HOST: '0.0.0.0',
  API_PORT: '4000',
  WEB_ORIGIN: 'http://localhost:3000',
  LOG_LEVEL: 'debug',
};

describe('parseEnvironment', () => {
  it('parses a valid environment', () => {
    const config = parseEnvironment(validEnvironment);

    expect(config.NODE_ENV).toBe('development');
    expect(config.API_PORT).toBe(4000);
    expect(config.WEB_ORIGIN).toBe('http://localhost:3000');
  });

  it('applies supported defaults', () => {
    const config = parseEnvironment({
      DATABASE_URL:
        'postgresql://authcore:authcore_dev@localhost:5432/authcore',
      REDIS_URL: 'redis://localhost:6379',
      WEB_ORIGIN: 'http://localhost:3000',
    });

    expect(config.NODE_ENV).toBe('development');
    expect(config.API_HOST).toBe('0.0.0.0');
    expect(config.API_PORT).toBe(4000);
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('rejects a missing database URL', () => {
    expect(() =>
      parseEnvironment({
        REDIS_URL: 'redis://localhost:6379',
        WEB_ORIGIN: 'http://localhost:3000',
      }),
    ).toThrow('DATABASE_URL');
  });

  it('rejects a non-PostgreSQL database URL', () => {
    expect(() =>
      parseEnvironment({
        ...validEnvironment,
        DATABASE_URL: 'mysql://localhost/authcore',
      }),
    ).toThrow('DATABASE_URL');
  });

  it('rejects an invalid Redis URL', () => {
    expect(() =>
      parseEnvironment({
        ...validEnvironment,
        REDIS_URL: 'http://localhost:6379',
      }),
    ).toThrow('REDIS_URL');
  });

  it('rejects a non-numeric API port', () => {
    expect(() =>
      parseEnvironment({
        ...validEnvironment,
        API_PORT: 'not-a-port',
      }),
    ).toThrow('API_PORT');
  });

  it('rejects an out-of-range API port', () => {
    expect(() =>
      parseEnvironment({
        ...validEnvironment,
        API_PORT: '70000',
      }),
    ).toThrow('API_PORT');
  });

  it('rejects an invalid web origin', () => {
    expect(() =>
      parseEnvironment({
        ...validEnvironment,
        WEB_ORIGIN: 'not-a-url',
      }),
    ).toThrow('WEB_ORIGIN');
  });

  it('rejects unsupported NODE_ENV values', () => {
    expect(() =>
      parseEnvironment({
        ...validEnvironment,
        NODE_ENV: 'staging',
      }),
    ).toThrow('NODE_ENV');
  });
});