import process from 'node:process';
import { spawnSync, fork } from 'node:child_process';
import { randomBytes, randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer as httpServer } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import { fileURLToPath, URL } from 'node:url';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
const { fetch, AbortSignal } = globalThis;

const root = fileURLToPath(new URL('../', import.meta.url));
const local = resolve(root, '.local-demo');
const command = process.argv[2];
class DemoFailure extends Error {}
class DemoStopped extends Error {}
let stage = 'configuration';
const fail = (message) => {
  throw new DemoFailure(message);
};
const secret = () => randomBytes(32).toString('hex');
const file = (name) => resolve(local, name);
const json = async (name) => JSON.parse(await readFile(file(name), 'utf8'));
const safePort = (value) => Number.isInteger(value) && value >= 1024 && value <= 65535;
function run(args) {
  const result = spawnSync('docker', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 || result.error)
    fail(
      'Docker operation failed at ' + stage + '. Check Docker Desktop and local port availability.',
    );
  return result.stdout.trim();
}
function context() {
  const info = JSON.parse(run(['context', 'inspect']));
  const endpoint = info[0]?.Endpoints?.docker?.Host;
  if (
    typeof endpoint !== 'string' ||
    !(endpoint.startsWith('npipe://') || endpoint.startsWith('unix://'))
  )
    fail('Demo refuses a remote Docker context. Select a local Docker Desktop context.');
}
const compose = (config, ...args) =>
  run([
    'compose',
    '-p',
    config.project,
    '--env-file',
    file('compose.env'),
    '-f',
    resolve(root, 'infrastructure/compose.demo.yml'),
    ...args,
  ]);
async function exclusive(name, value) {
  const content = typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';
  try {
    await writeFile(file(name), content, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await readFile(file(name), 'utf8');
    if (
      typeof value === 'string'
        ? existing !== content
        : !isDeepStrictEqual(JSON.parse(existing), value)
    )
      fail(
        'Existing local configuration differs: ' +
          name +
          '. Preserved; do not reset secrets or data.',
      );
  }
}
async function free(port) {
  return new Promise((resolve) => {
    const server = tcpServer();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () =>
      server.close(() => resolve(true)),
    );
  });
}
async function pick(choices) {
  for (const choice of choices) if (await free(choice)) return choice;
  fail('No safe local demo port is available.');
}
function validate(config) {
  if (
    config.localDemo !== true ||
    config.version !== 1 ||
    !/^authcore-full-product-demo(?:-[a-f0-9]{6})?$/.test(config.project) ||
    !Object.values(config.ports).every(safePort) ||
    new Set(Object.values(config.ports)).size !== 5 ||
    ![
      'ownerPassword',
      'signupPassword',
      'authPassword',
      'workerPassword',
      'verifierPassword',
      'hmacSecret',
      'authRateKey',
      'deliveryKey',
    ].every((key) => /^[0-9a-f]{64}$/.test(config[key]))
  )
    fail('Local demo administrator configuration is invalid.');
  return config;
}
function urls(config) {
  const database = (role, password) =>
    'postgresql://' +
    role +
    ':' +
    password +
    '@127.0.0.1:' +
    config.ports.postgres +
    '/authcore_demo';
  return {
    owner: database('authcore_demo_owner', config.ownerPassword),
    signup: database('authcore_signup_runtime_demo', config.signupPassword),
    auth: database('authcore_auth_runtime_demo', config.authPassword),
    worker: database('authcore_email_worker_demo', config.workerPassword),
    verifier: database('authcore_email_verifier_demo', config.verifierPassword),
    redis: 'redis://127.0.0.1:' + config.ports.redis + '/0',
    web: 'http://127.0.0.1:' + config.ports.web,
    api: 'http://127.0.0.1:' + config.ports.api,
    mailbox: 'http://127.0.0.1:' + config.ports.mailbox,
  };
}
function containers(config, requireRunning = false) {
  const ids = run(['ps', '-aq', '--filter', 'label=com.docker.compose.project=' + config.project])
    .split(/\s+/)
    .filter(Boolean);
  const seen = new Set();
  for (const id of ids) {
    const item = JSON.parse(run(['inspect', id]))[0];
    const labels = item.Config?.Labels ?? {},
      service = labels['com.docker.compose.service'];
    if (
      labels['com.authcore.local-demo'] !== 'true' ||
      !['postgres', 'redis', 'mailpit'].includes(service)
    )
      fail('Existing Compose project contains an unowned container. Preserved.');
    if (requireRunning && item.State?.Status !== 'running')
      fail('Demo container is not running: ' + service);
    const containerPort =
      service === 'postgres' ? '5432/tcp' : service === 'redis' ? '6379/tcp' : '8025/tcp';
    const expected =
      config.ports[
        service === 'postgres' ? 'postgres' : service === 'mailpit' ? 'mailbox' : 'redis'
      ];
    const binding =
      item.NetworkSettings?.Ports?.[containerPort] ??
      item.HostConfig?.PortBindings?.[containerPort];
    if (
      !binding?.length ||
      binding.some((port) => port.HostIp !== '127.0.0.1' || Number(port.HostPort) !== expected)
    )
      fail('Demo port ownership or loopback binding differs. Preserved.');
    seen.add(service);
  }
  if (requireRunning && seen.size !== 3) fail('All three dedicated demo services are required.');
}
async function configure() {
  await mkdir(local, { recursive: true });
  let config;
  try {
    config = validate(await json('admin.json'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    let project = 'authcore-full-product-demo';
    if (run(['ps', '-aq', '--filter', 'label=com.docker.compose.project=' + project]))
      project += '-' + randomBytes(3).toString('hex');
    config = {
      localDemo: true,
      version: 1,
      initialized: false,
      project,
      ports: {
        web: await pick([3000, 3001, 3100]),
        api: await pick([4000, 4001, 4100]),
        postgres: await pick([55432, 55434, 55435]),
        redis: await pick([56379, 56381, 56382]),
        mailbox: await pick([8025, 18026, 18027]),
      },
      ownerPassword: secret(),
      signupPassword: secret(),
      authPassword: secret(),
      workerPassword: secret(),
      verifierPassword: secret(),
      hmacSecret: secret(),
      authRateKey: secret(),
      deliveryKey: secret(),
    };
    // Independent provisioning implementation of the frozen public known-answer tuples.
    // Runtime validates this separate metadata and its pre-existing DB anchor.
    const digest = (tuple) =>
      createHmac('sha256', Buffer.from(config.hmacSecret, 'hex'))
        .update(JSON.stringify(tuple))
        .digest('hex');
    config.metadata = {
      hmacKeyVersion: 1,
      keyDigest: digest(['authcore.signup.key', 1, 'authcore_attestation_v1']),
      payloadDigest: digest([
        'authcore.signup.payload',
        1,
        'signup-attestation@example.invalid',
        'signup-attestation@example.invalid',
        'public-known-answer-input-v1',
      ]),
    };
    await exclusive('admin.json', config);
  }
  const target = urls(config);
  await exclusive('attestation.json', config.metadata);
  await exclusive(
    'compose.env',
    [
      'AUTHCORE_DEMO_OWNER_PASSWORD=' + config.ownerPassword,
      'AUTHCORE_DEMO_PG_PORT=' + config.ports.postgres,
      'AUTHCORE_DEMO_REDIS_PORT=' + config.ports.redis,
      'AUTHCORE_DEMO_MAIL_PORT=' + config.ports.mailbox,
      '',
    ].join('\n'),
  );
  await exclusive('api.json', {
    localDemo: true,
    databaseUrl: target.signup,
    authDatabaseUrl: target.auth,
    verificationDatabaseUrl: target.verifier,
    redisUrl: target.redis,
    webOrigin: target.web,
    apiPort: config.ports.api,
    hmacSecret: config.hmacSecret,
    authRateKey: config.authRateKey,
  });
  await exclusive('worker.json', {
    localDemo: true,
    databaseUrl: target.worker,
    deliveryKey: config.deliveryKey,
    mailboxOrigin: target.mailbox,
    webOrigin: target.web,
  });
  await exclusive('public.json', {
    localDemo: true,
    project: config.project,
    webOrigin: target.web,
    apiOrigin: target.api,
    mailboxOrigin: target.mailbox,
  });
  return config;
}
async function setup() {
  context();
  const config = await configure();
  stage = 'container provisioning';
  containers(config);
  compose(config, 'up', '-d', '--wait', '--wait-timeout', '90');
  containers(config, true);
  stage = 'additive migrations';
  const { createDatabaseClient } = await import('../packages/db/dist/index.js');
  const require = createRequire(new URL('../packages/db/package.json', import.meta.url));
  const { migrate } = require('drizzle-orm/node-postgres/migrator');
  const database = createDatabaseClient({ connectionString: urls(config).owner });
  try {
    await migrate(database.db, { migrationsFolder: resolve(root, 'packages/db/drizzle') });
    await database.pool.query('REVOKE TEMPORARY ON DATABASE authcore_demo FROM PUBLIC');
    await database.pool.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    stage = 'namespace attestation';
    const rows = (
      await database.pool.query(
        'SELECT hmac_key_version,attestation_key_digest,attestation_payload_digest FROM signup_idempotency_namespace',
      )
    ).rows;
    if (!rows.length) {
      const count = (
        await database.pool.query(
          'SELECT (SELECT count(*) FROM users)+(SELECT count(*) FROM signup_idempotency_claims) AS n',
        )
      ).rows[0].n;
      if (config.initialized || Number(count) !== 0)
        fail('Missing namespace anchor in initialized/nonempty demo. Preserved.');
      await database.pool.query(
        'INSERT INTO signup_idempotency_namespace(hmac_key_version,attestation_key_digest,attestation_payload_digest) VALUES($1,$2,$3)',
        [config.metadata.hmacKeyVersion, config.metadata.keyDigest, config.metadata.payloadDigest],
      );
    } else if (
      rows.length !== 1 ||
      rows[0].hmac_key_version !== config.metadata.hmacKeyVersion ||
      rows[0].attestation_key_digest !== config.metadata.keyDigest ||
      rows[0].attestation_payload_digest !== config.metadata.payloadDigest
    )
      fail('Existing namespace anchor differs. No overwrite or automatic rotation.');
    stage = 'restricted role provisioning';
    for (const [role, password, script, capability] of [
      ['authcore_signup_runtime_demo', config.signupPassword, 'signup-runtime-role.sql', 'signup'],
      ['authcore_auth_runtime_demo', config.authPassword, 'auth-runtime-role.sql', 'auth'],
      ['authcore_email_worker_demo', config.workerPassword, 'email-runtime-role.sql', 'worker'],
      [
        'authcore_email_verifier_demo',
        config.verifierPassword,
        'email-runtime-role.sql',
        'verification',
      ],
    ]) {
      if (
        !(await database.pool.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount
      ) {
        const sql = (
          await database.pool.query(
            "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',$1::text,$2::text) AS sql",
            [role, password],
          )
        ).rows[0].sql;
        await database.pool.query(sql);
      }
      const client = await database.pool.connect();
      try {
        await client.query('BEGIN');
        const setting =
          capability === 'signup'
            ? 'authcore.runtime_role'
            : capability === 'auth'
              ? 'authcore.auth_role'
              : 'authcore.email_role';
        await client.query('SELECT set_config($1,$2,true)', [setting, role]);
        if (capability === 'worker' || capability === 'verification')
          await client.query("SELECT set_config('authcore.email_capability',$1,true)", [
            capability,
          ]);
        await client.query(
          await readFile(resolve(root, 'packages/db/permissions', script), 'utf8'),
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  } finally {
    await database.pool.end();
  }
  // Verify actual principal authentication; never alter an existing role's password.
  for (const name of ['signup', 'auth', 'worker', 'verifier']) {
    const client = createDatabaseClient({ connectionString: urls(config)[name] });
    try {
      await client.pool.query('SELECT 1');
    } finally {
      await client.pool.end();
    }
  }
  if (!config.initialized)
    await writeFile(
      file('admin.json'),
      JSON.stringify({ ...config, initialized: true }, null, 2) + '\n',
      { mode: 0o600 },
    );
  console.log(
    'LOCAL DEMO SETUP COMPLETE. Run pnpm dev:start. Data volumes and secrets persist across ordinary restarts.',
  );
  printUrls(config);
}
function printUrls(config) {
  const target = urls(config);
  console.log(
    'Web: ' + target.web + '\nAPI: ' + target.api + '\nLocal-only test mailbox: ' + target.mailbox,
  );
}
async function ready(url, timeout = 90000, cancelled = () => false) {
  const deadline = performance.now() + timeout;
  let lastStatus = 'no response';
  while (performance.now() < deadline) {
    if (cancelled()) throw new DemoStopped();
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000), redirect: 'error' });
      lastStatus = String(response.status);
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      lastStatus = 'connection unavailable';
    }
    await pause(150);
  }
  fail(
    'Local service did not become ready (' +
      lastStatus +
      '). Inspect the new ignored .local-demo/logs files.',
  );
}
async function stopRequest(state) {
  if (
    state.localDemo !== true ||
    !safePort(state.controlPort) ||
    !/^[0-9a-f]{64}$/.test(state.controlToken)
  )
    fail('Invalid saved demo supervisor state; no process was stopped.');
  const response = await fetch('http://127.0.0.1:' + state.controlPort + '/stop', {
    method: 'POST',
    headers: { 'x-authcore-control': state.controlToken },
    signal: AbortSignal.timeout(60000),
    redirect: 'error',
  });
  await response.body?.cancel();
  if (response.status !== 204)
    fail('Demo supervisor rejected shutdown. No arbitrary PID was stopped.');
}
async function start() {
  context();
  const config = validate(await json('admin.json'));
  if (!config.initialized) fail('Run pnpm dev:setup first.');
  stage = 'start';
  try {
    const state = await json('processes.json');
    if (
      state.localDemo !== true ||
      !safePort(state.controlPort) ||
      !/^[0-9a-f]{64}$/.test(state.controlToken)
    )
      fail('Invalid saved supervisor state. Preserved without any network request.');
    const response = await fetch('http://127.0.0.1:' + state.controlPort + '/status', {
      headers: { 'x-authcore-control': state.controlToken },
      signal: AbortSignal.timeout(1000),
      redirect: 'error',
    });
    await response.body?.cancel();
    if (response.status === 200) {
      console.log('Local demo is already running.');
      printUrls(config);
      return;
    }
    fail('Existing supervisor state was not authenticated. Preserved.');
  } catch (error) {
    if (error instanceof DemoFailure) throw error;
    if (error.code !== 'ENOENT')
      await rename(file('processes.json'), file('processes-stale-' + randomUUID() + '.json'));
  }
  if (!(await free(config.ports.web)) || !(await free(config.ports.api)))
    fail('Configured web/API port is occupied. No existing process was stopped.');
  containers(config);
  compose(config, 'up', '-d', '--wait', '--wait-timeout', '90');
  containers(config, true);
  await mkdir(file('logs'), { recursive: true });
  const children = [],
    logs = [],
    initialized = new WeakMap(),
    token = secret();
  let stopping;
  const control = httpServer({ maxHeaderSize: 1024 }, (req, res) => {
    const supplied = req.headers['x-authcore-control'];
    const authorized =
      typeof supplied === 'string' &&
      /^[0-9a-f]{64}$/.test(supplied) &&
      timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
    if (!authorized || (req.url !== '/status' && req.url !== '/stop')) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200).end();
      return;
    }
    if (
      req.method !== 'POST' ||
      req.url !== '/stop' ||
      req.headers['transfer-encoding'] ||
      (req.headers['content-length'] && req.headers['content-length'] !== '0')
    ) {
      res.writeHead(400).end();
      return;
    }
    void shutdown()
      .then(() => {
        res.writeHead(204).end();
        control.close();
      })
      .catch(() => {
        res.writeHead(503).end();
      });
  });
  control.requestTimeout = 3000;
  control.headersTimeout = 3000;
  control.maxConnections = 4;
  const shutdown = () =>
    (stopping ??= (async () => {
      // A shutdown sent before a child installs its IPC listener can be lost.
      // Retain ownership until that listener is ready or the process has exited.
      await Promise.all(children.map((child) => initialized.get(child)));
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null && child.connected)
          child.send('authcore:shutdown');
      }
      await Promise.all(
        children.map((child) =>
          child.exitCode !== null || child.signalCode !== null
            ? Promise.resolve()
            : new Promise((resolve) => child.once('exit', resolve)),
        ),
      );
      stage = 'stop owned services';
      containers(config);
      compose(config, 'stop');
      for (const log of logs) await log.close();
      await unlink(file('processes.json')).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      console.log('Local demo stopped. Database, Redis and mailbox volumes preserved.');
    })());
  const env = Object.fromEntries(
    ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'HOME']
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
  Object.assign(env, { NODE_ENV: 'development', AUTHCORE_LOCAL_DEMO: 'true' });
  async function child(name, entry, args = [], extra = {}) {
    if (stopping) throw new DemoStopped();
    console.log('Starting owned ' + name + ' process.');
    const log = await open(file('logs/' + name + '-' + Date.now() + '.log'), 'ax', 0o600);
    if (stopping) {
      await log.close();
      throw new DemoStopped();
    }
    logs.push(log);
    const instance = fork(resolve(root, entry), args, {
      cwd: root,
      env: { ...env, ...extra },
      windowsHide: true,
      stdio: ['ignore', log.fd, log.fd, 'ipc'],
    });
    children.push(instance);
    initialized.set(
      instance,
      new Promise((resolve) => {
        const finish = () => {
          instance.off('message', onMessage);
          instance.off('exit', finish);
          resolve();
        };
        const onMessage = (message) => {
          if (message === 'authcore:ready') finish();
        };
        instance.on('message', onMessage);
        instance.once('exit', finish);
      }),
    );
    instance.once('exit', () => {
      if (!stopping) {
        process.exitCode = 1;
        console.error('Owned ' + name + ' process exited; stopping the demo safely.');
        void shutdown().finally(() => control.close());
      }
    });
  }
  const interrupt = () => {
    void shutdown().finally(() => control.close());
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    await new Promise((resolve) => control.listen(0, '127.0.0.1', resolve));
    await exclusive('processes.json', {
      localDemo: true,
      pid: process.pid,
      controlPort: control.address().port,
      controlToken: token,
    });
    const target = urls(config);
    await child('api', 'apps/api/dist/local-demo.js');
    await ready(target.api + '/api/v1/health/ready', 90000, () => !!stopping);
    await child('worker', 'apps/worker/dist/index.js', [file('worker.json')]);
    await child('web', 'scripts/local-web.mjs', [], {
      AUTHCORE_WEB_PORT: String(config.ports.web),
      AUTHCORE_API_PORT: String(config.ports.api),
      VITE_LOCAL_DEMO: 'true',
      VITE_MAILBOX_ORIGIN: target.mailbox,
    });
    await ready(target.web, 90000, () => !!stopping);
    console.log(
      'LOCAL SERVICES READY. Browser acceptance is a separate check. Keep this terminal open; Ctrl+C or pnpm dev:stop shuts down owned services.',
    );
    printUrls(config);
  } catch (error) {
    await shutdown();
    control.close();
    if (!(error instanceof DemoStopped)) throw error;
  }
}
async function check() {
  const config = validate(await json('admin.json')),
    target = urls(config);
  context();
  containers(config, true);
  await ready(target.api + '/api/v1/health/ready', 5000);
  await ready(target.mailbox + '/readyz', 5000);
  await ready(target.web, 5000);
  const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
  const { createClient } = require('redis'),
    redis = createClient({
      url: target.redis,
      socket: { reconnectStrategy: false, connectTimeout: 3000 },
    });
  try {
    await redis.connect();
    if ((await redis.ping()) !== 'PONG') fail('Demo Redis is not ready.');
  } finally {
    if (redis.isOpen) redis.destroy();
  }
  console.log('LOCAL SERVICES CHECK PASS. This does not claim browser authentication acceptance.');
  printUrls(config);
}
try {
  if (process.env.NODE_ENV === 'production') fail('Local demo tools refuse production execution.');
  if (command === 'setup') await setup();
  else if (command === 'start') await start();
  else if (command === 'stop') {
    context();
    await stopRequest(await json('processes.json'));
  } else if (command === 'check') await check();
  else fail('Usage: node scripts/local-demo.mjs setup|start|stop|check');
} catch (error) {
  console.error(
    error instanceof DemoFailure
      ? error.message
      : 'Local demo failed at ' +
          stage +
          '. Configuration and data were preserved; check Docker availability and ignored local logs.',
  );
  process.exitCode = 1;
}
