import { ValidationPipe, type Type, type DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Environment } from '@authcore/config';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter.js';
import { configureSignupHttp, SignupHttpAdapter } from './identity/signup-http.js';
import { configureEmailVerificationHttp } from './identity/email-verification.http.js';
import { configureBrowserAuthHttp } from './authentication/browser-http.js';

export async function startApi(module: Type<unknown> | DynamicModule, environment: Environment) {
  const app = await NestFactory.create(module, new SignupHttpAdapter(), { bodyParser: false });
  try {
    configureSignupHttp(app);
    configureEmailVerificationHttp(app);
    configureBrowserAuthHttp(app);
    app.setGlobalPrefix('api/v1');
    app.enableShutdownHooks();
    app.enableCors({ origin: environment.WEB_ORIGIN, credentials: true });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
        validationError: { target: false, value: false },
      }),
    );
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.getHttpAdapter().getInstance().disable('x-powered-by');
    await app.listen(environment.API_PORT, environment.API_HOST);
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
