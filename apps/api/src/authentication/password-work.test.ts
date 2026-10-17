import { describe, expect, it } from 'vitest';
import { PasswordWork } from './password-work.js';
describe('Native password work ownership', () => {
  it('keeps all four permits until actual settlement and drains them on shutdown', async () => {
    const work = new PasswordWork(),
      settle: (() => void)[] = [];
    const owners = Array.from({ length: 4 }, () =>
      work.run(() => new Promise<void>((resolve) => settle.push(resolve))),
    );
    await Promise.resolve();
    expect(work.inventory().active).toBe(4);
    await expect(work.run(async () => {})).rejects.toThrow('PASSWORD_WORK_UNAVAILABLE');
    let drained = false;
    const shutdown = work.shutdown().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    settle.forEach((resolve) => resolve());
    await Promise.all(owners);
    await shutdown;
    expect(work.inventory()).toEqual({ active: 0, closing: true });
    await expect(work.run(async () => {})).rejects.toThrow('PASSWORD_WORK_UNAVAILABLE');
  });
  it('settles failed native work without manufacturing a successful result', async () => {
    const work = new PasswordWork();
    await expect(
      work.run(async () => {
        throw new Error('Synthetic native failure');
      }),
    ).rejects.toThrow('Synthetic native failure');
    expect(work.inventory().active).toBe(0);
    expect(await work.run(async () => true)).toBe(true);
    await work.shutdown();
  });
});
