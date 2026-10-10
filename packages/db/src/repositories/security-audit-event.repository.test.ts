import { describe, expect, it, vi } from 'vitest';

import { securityAuditEvents } from '../schema/index.js';
import {
  SecurityAuditEventRepository,
  type SecurityAuditEventRepositoryDatabase,
} from './security-audit-event.repository.js';

function setup() {
  const returning = vi.fn();
  const values = vi.fn(() => ({ returning }));
  const insert = vi.fn(() => ({ values }));
  const repository = new SecurityAuditEventRepository({
    insert,
  } as unknown as SecurityAuditEventRepositoryDatabase);
  return { repository, insert, values, returning };
}

describe('SecurityAuditEventRepository', () => {
  it('persists only the subject, fixed type and empty payload, ignoring runtime extras', async () => {
    const { repository, insert, values, returning } = setup();
    const row = {
      id: 'event-id',
      userId: 'user-id',
      eventType: 'identity.user_created',
      payload: {},
      occurredAt: new Date(),
    };
    returning.mockResolvedValue([row]);

    await expect(
      repository.recordUserCreated({
        userId: row.userId,
        ...{
          id: 'forged-id',
          eventType: 'forged-type',
          occurredAt: new Date(0),
          password: 'plaintext',
          passwordHash: 'encoded-hash',
          payload: { password: 'plaintext', idempotencyKey: 'raw-key', secret: 'secret' },
          body: { email: 'private@example.com', password: 'plaintext' },
        },
      }),
    ).resolves.toBe(row);

    expect(insert).toHaveBeenCalledExactlyOnceWith(securityAuditEvents);
    expect(values).toHaveBeenCalledExactlyOnceWith({
      userId: row.userId,
      eventType: 'identity.user_created',
      payload: {},
    });
  });

  it('rejects an insert with no returned event instead of accepting a missing audit', async () => {
    const { repository, returning } = setup();
    returning.mockResolvedValue([]);
    await expect(repository.recordUserCreated({ userId: 'user-id' })).rejects.toThrow(
      'Security audit event insert returned no row',
    );
  });

  it('propagates every insert failure for the caller to roll back, including conflicts', async () => {
    const { repository, returning } = setup();
    const failure = Object.assign(new Error('unique conflict'), { code: '23505' });
    returning.mockRejectedValue(failure);
    await expect(repository.recordUserCreated({ userId: 'user-id' })).rejects.toBe(failure);
  });
});
