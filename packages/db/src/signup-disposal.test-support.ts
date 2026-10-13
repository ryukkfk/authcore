import { EventEmitter } from 'node:events';
import type { PassThrough } from 'node:stream';
import { vi } from 'vitest';

/** Synthetic A1 public contract for inherited owner tests. No production transport access. */
export function disposalMock(
  client: EventEmitter & {
    connection: { stream: PassThrough };
    end(): Promise<void>;
  },
) {
  return vi.fn(
    () =>
      new Promise<{ removed: true; transportSettled: true; diagnostics: [] }>((resolve) => {
        const stream = client.connection.stream;
        const finish = () => {
          clearTimeout(timer);
          client.removeListener('end', end);
          resolve({ removed: true, transportSettled: true, diagnostics: [] });
        };
        const end = () => stream.destroy();
        const timer = setTimeout(end, 1000);
        if (stream.closed) {
          finish();
          return;
        }
        stream.once('close', finish);
        client.once('end', end);
        try {
          void client.end().catch(end);
        } catch {
          end();
        }
      }),
  );
}
