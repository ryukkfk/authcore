import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
const preserved = {
  'drizzle/0000_users.sql': 'de76b2219fdbeebda7786f234cb0340a1f6d9a25d422f479bee9c8e5eb07a083',
  'drizzle/0001_password_credentials.sql':
    '2eb4c0c3f2980c161e307d1003494454a6496d9c88f6b1d1b8df4e2fa6d2a5f9',
  'drizzle/0002_security_audit_events.sql':
    '584a56122cd4cd5c4daa78ec854872d1e0a8812ab7f847390ef7cdab2f630fc9',
  'drizzle/0003_signup_idempotency.sql':
    '14de56e335bcc11ef18ad50391fd7d370b1fef8abf57a630ccbb762182671e1e',
  'drizzle/meta/0000_snapshot.json':
    '742006f39d7f30b1ba19ea899a94fb85f0e59f6ea2cef6d20eeaa26858649aab',
  'drizzle/meta/0001_snapshot.json':
    'ba1d63e8755ab5734d5fb1a191d894733210b89a7ddd40c161b8267138eb9238',
  'drizzle/meta/0002_snapshot.json':
    '1580481367a8164ae24d3ad83cad3a0ebf0f5e93f67822152735cd917996d644',
  'drizzle/meta/0003_snapshot.json':
    '189ba833e24fedb3215bde91140af3b54b48e2a577224900832619486c97ba38',
};
describe('S2 append-only migration lineage', () => {
  it('preserves all Phase A migration and snapshot bytes', async () => {
    for (const [file, digest] of Object.entries(preserved)) {
      expect(
        createHash('sha256')
          .update(
            (await readFile(new URL('../' + file, import.meta.url), 'utf8')).replaceAll(
              '\r\n',
              '\n',
            ),
          )
          .digest('hex'),
        file,
      ).toBe(digest);
    }
  });
  it('appends one journal entry with a linked snapshot and only additive schema changes', async () => {
    const read = async (file: string) =>
      JSON.parse(await readFile(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
    const journal = await read('meta/_journal.json');
    expect(journal.entries.map((entry: { idx: number }) => entry.idx)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(journal.entries[4].tag).toBe('0004_signup_namespace_and_terminal_events');
    const old = await read('meta/0003_snapshot.json');
    const next = await read('meta/0004_snapshot.json');
    expect(next.prevId).toBe(old.id);
    expect(next.id).not.toBe(old.id);
    for (const [table, definition] of Object.entries(old.tables)) {
      const comparison = structuredClone(next.tables[table]);
      if (table === 'public.signup_idempotency_claims')
        delete comparison.indexes.signup_claims_hmac_version_idx;
      expect(comparison, table).toEqual(definition);
    }
    expect(Object.keys(next.tables)).toHaveLength(7);
    expect(journal.entries[5].tag).toBe('0005_verification_events');
    const outbox = await read('meta/0005_snapshot.json');
    expect(outbox.prevId).toBe(next.id);
    for (const [table, definition] of Object.entries(next.tables))
      expect(outbox.tables[table], table).toEqual(definition);
    expect(Object.keys(outbox.tables)).toHaveLength(8);
    expect(journal.entries[6].tag).toBe('0006_email_delivery_and_verification');
    const delivery = await read('meta/0006_snapshot.json');
    expect(delivery.prevId).toBe(outbox.id);
    for (const [table, definition] of Object.entries(outbox.tables))
      expect(delivery.tables[table], table).toEqual(definition);
    expect(Object.keys(delivery.tables)).toHaveLength(12);
    expect(journal.entries[7].tag).toBe('0007_cloudy_iron_patriot');
    const sessions = await read('meta/0007_snapshot.json');
    expect(sessions.prevId).toBe(delivery.id);
    for (const [table, definition] of Object.entries(delivery.tables))
      expect(sessions.tables[table], table).toEqual(definition);
    expect(Object.keys(sessions.tables)).toHaveLength(14);
    expect(journal.entries[8].tag).toBe('0008_verification_resend');
    const resend = await read('meta/0008_snapshot.json');
    expect(resend.prevId).toBe(sessions.id);
    for (const [table, definition] of Object.entries(sessions.tables)) {
      const comparison = structuredClone(resend.tables[table]);
      if (table === 'public.verification_events') {
        delete comparison.columns.request_id;
        delete comparison.indexes.verification_events_user_created_idx;
      }
      expect(comparison, table).toEqual(definition);
    }
    expect(Object.keys(resend.tables)).toHaveLength(14);
    expect(journal.entries[9].tag).toBe('0009_password_recovery');
    const recovery = await read('meta/0009_snapshot.json');
    expect(recovery.prevId).toBe(resend.id);
    for (const [table, definition] of Object.entries(resend.tables))
      expect(recovery.tables[table], table).toEqual(definition);
    expect(Object.keys(recovery.tables)).toHaveLength(19);
  });
});
