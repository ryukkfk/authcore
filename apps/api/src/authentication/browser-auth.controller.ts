import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Req,
  Res,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { isEmail, isUUID } from 'class-validator';
import type { Request, Response } from 'express';
import { BrowserAuthService } from './browser-auth.service.js';
import {
  browserRequestContext,
  readSessionCredential,
  sessionCookiePolicy,
} from './browser-http.js';

const validObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const device = (agent: string) =>
  /Firefox\//.test(agent)
    ? 'Firefox'
    : /Chrome\/|Chromium\/|Edg\//.test(agent)
      ? 'Chromium'
      : /Safari\//.test(agent)
        ? 'Safari'
        : 'Other';
const ip = (request: Request) => request.socket.remoteAddress ?? '';

@Controller('auth')
export class BrowserAuthController {
  constructor(@Inject(BrowserAuthService) private readonly auth: BrowserAuthService) {}
  private async safely<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Authentication temporarily unavailable');
    }
  }
  private clear(response: Response) {
    const policy = sessionCookiePolicy(process.env.NODE_ENV === 'production');
    const { maxAge, ...options } = policy.options;
    void maxAge;
    response.clearCookie(policy.name, options);
  }
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (
      !validObject(body) ||
      Object.keys(body).sort().join(',') !== 'email,password' ||
      typeof body.email !== 'string' ||
      body.email.trim().length > 254 ||
      !isEmail(body.email.trim()) ||
      typeof body.password !== 'string' ||
      body.password.length < 1 ||
      body.password.length > 128
    )
      throw new BadRequestException('Invalid authentication request');
    const context = browserRequestContext(request);
    const result = await this.safely(() =>
      this.auth.login(
        { email: body.email as string, password: body.password as string },
        {
          ip: ip(request),
          previous: readSessionCredential(request),
          deviceLabel: device(request.headers['user-agent'] ?? ''),
          ...context,
        },
      ),
    );
    const policy = sessionCookiePolicy(process.env.NODE_ENV === 'production');
    response.cookie(policy.name, result.credential, policy.options);
    return {
      user: {
        id: result.account.id,
        email: result.account.email,
        emailVerified: true,
        createdAt: result.account.createdAt,
      },
    };
  }
  @Get('me')
  async me(@Req() request: Request) {
    const account = await this.safely(() =>
      this.auth.me(readSessionCredential(request), ip(request)),
    );
    return {
      user: {
        id: account.id,
        email: account.email,
        emailVerified: true,
        createdAt: account.createdAt,
      },
    };
  }
  @Get('sessions')
  async sessions(@Req() request: Request) {
    return {
      sessions: await this.safely(() =>
        this.auth.list(readSessionCredential(request), ip(request)),
      ),
    };
  }
  private async revoke(
    body: unknown,
    request: Request,
    response: Response,
    target: 'current' | 'all' | 'others',
  ) {
    if (!validObject(body) || Object.keys(body).length)
      throw new BadRequestException('Invalid authentication request');
    const result = await this.safely(() =>
      this.auth.revoke(
        readSessionCredential(request),
        ip(request),
        browserRequestContext(request).requestId,
        target,
      ),
    );
    if (target === 'current' || result.currentRevoked) this.clear(response);
  }
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.revoke(body, request, response, 'current');
  }
  @Post('logout-all')
  @HttpCode(204)
  async logoutAll(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.revoke(body, request, response, 'all');
  }
  @Post('logout-others')
  @HttpCode(204)
  async logoutOthers(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.revoke(body, request, response, 'others');
  }
  @Post('sessions/revoke')
  @HttpCode(204)
  async revokeDevice(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (
      !validObject(body) ||
      Object.keys(body).length !== 1 ||
      typeof body.sessionId !== 'string' ||
      !isUUID(body.sessionId)
    )
      throw new BadRequestException('Invalid authentication request');
    const result = await this.safely(() =>
      this.auth.revoke(
        readSessionCredential(request),
        ip(request),
        browserRequestContext(request).requestId,
        { id: body.sessionId as string },
      ),
    );
    if (result.currentRevoked) this.clear(response);
  }
}
