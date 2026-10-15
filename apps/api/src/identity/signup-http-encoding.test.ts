import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { request } from 'node:http';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { SignupHttpAdapter, configureSignupHttp } from './signup-http.js';
let app: INestApplication;
let url: string;
@Module({})
class EncodingFixture {}
beforeAll(async () => {
  app = await NestFactory.create(EncodingFixture, new SignupHttpAdapter(), {
    logger: false,
    bodyParser: false,
  });
  configureSignupHttp(app);
  app.use(
    '/api/v1/auth/signup',
    (_req: unknown, res: { status(n: number): { json(v: unknown): void } }) =>
      res.status(202).json({ status: 'accepted' }),
  );
  await app.listen(0, '127.0.0.1');
  url = await app.getUrl();
}, 15000);
afterAll(async () => {
  await app?.close();
});
function send(body: Buffer) {
  return new Promise<number>((resolve, reject) => {
    const req = request(
      url + '/api/v1/auth/signup',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      },
      (res) => {
        res.resume();
        res.once('end', () => resolve(res.statusCode!));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
it('rejects malformed UTF-8 instead of silently binding decoder replacement characters', async () => {
  expect(
    await send(
      Buffer.concat([Buffer.from('{"password":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]),
    ),
  ).toBe(400);
});
it.each(['\uFFFD', String.fromCodePoint(0x1f600)])(
  'preserves explicitly encoded valid Unicode %s',
  async (value) => {
    expect(await send(Buffer.from(JSON.stringify({ password: value })))).toBe(202);
  },
);
