import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';
import process from 'node:process';

const root = fileURLToPath(new URL('../', import.meta.url));
const state = new URL('../.local-demo/processes.json', import.meta.url);
const exec = promisify(execFile);

// Explicit integration command: provision the disposable demo first and leave it
// stopped. This starts/stops only that owned project; all volumes are preserved.
test(
  'shutdown during API startup retains child ownership and exits cleanly',
  { timeout: 90000 },
  async () => {
    await assert.rejects(access(state), { code: 'ENOENT' });
    const supervisor = spawn(process.execPath, ['scripts/local-demo.mjs', 'start'], {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let startupResolve;
    const startup = new Promise((resolve) => {
      startupResolve = resolve;
    });
    supervisor.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.includes('Starting owned api process.')) startupResolve();
    });
    // Supervisor output is intentionally generic. Never publish raw child logs.
    supervisor.stderr.resume();
    const ended = new Promise((resolve, reject) => {
      supervisor.once('error', reject);
      supervisor.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const stop = () =>
      exec(process.execPath, ['scripts/local-demo.mjs', 'stop'], {
        cwd: root,
        windowsHide: true,
        timeout: 65000,
      });
    try {
      await Promise.race([
        startup,
        ended.then(() => {
          throw new Error('Supervisor exited before API startup');
        }),
      ]);
      await stop();
      assert.deepEqual(await ended, { code: 0, signal: null });
      assert(!output.includes('LOCAL SERVICES READY'), 'Stop was requested before readiness');
      await assert.rejects(access(state), { code: 'ENOENT' });
    } finally {
      if (supervisor.exitCode === null && supervisor.signalCode === null) await stop();
    }
  },
);
