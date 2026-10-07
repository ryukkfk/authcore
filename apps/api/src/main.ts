import 'reflect-metadata';

import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { parseEnvironment } from '@authcore/config';

import { AppModule } from './app.module.js';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter.js';

loadEnvFile(resolve(process.cwd(), '../../.env'));

const environment = parseEnvironment(process.env);

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();

  app.enableCors({
    origin: environment.WEB_ORIGIN,
    credentials: true,
  });

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

  const expressApplication = app.getHttpAdapter().getInstance();
  expressApplication.disable('x-powered-by');

  await app.listen(environment.API_PORT, environment.API_HOST);
}

void bootstrap();
