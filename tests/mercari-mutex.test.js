import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMercariMutex } from '../src/mercari/mutex.js';

describe('createMercariMutex', () => {
  it('serializes concurrent withLock calls', async () => {
    const mutex = createMercariMutex();
    const order = [];

    const a = mutex.withLock(async () => {
      order.push('a-start');
      await new Promise((r) => globalThis.setTimeout(r, 30));
      order.push('a-end');
      return 1;
    });

    const b = mutex.withLock(async () => {
      order.push('b-start');
      order.push('b-end');
      return 2;
    });

    const results = await Promise.all([a, b]);
    assert.deepEqual(results, [1, 2]);
    assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('continues the chain after a rejection', async () => {
    const mutex = createMercariMutex();
    await assert.rejects(
      () =>
        mutex.withLock(async () => {
          throw new Error('boom');
        }),
      /boom/,
    );
    const value = await mutex.withLock(async () => 42);
    assert.equal(value, 42);
  });
});
