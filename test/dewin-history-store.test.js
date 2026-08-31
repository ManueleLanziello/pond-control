import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEWIN_HISTORY_SAMPLE_INTERVAL_MS,
  DewinHistoryStore,
  localDateString,
  validateHistoryDate,
} from '../src/dewin-history-store.js';

async function withStore(now, callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pond-dewin-history-'));
  const store = new DewinHistoryStore({ directory, now: () => now });
  try { await callback(store, directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('Europe/Rome local day is used across the UTC midnight boundary', () => {
  assert.equal(localDateString(Date.parse('2026-08-27T22:30:00.000Z')), '2026-08-28');
  assert.equal(validateHistoryDate('2026-08-27'), '2026-08-27');
  assert.throws(() => validateHistoryDate('2026-02-30'), RangeError);
});

test('daily history saves exact samples, deduplicates unchanged readings and does not interpolate', async () => {
  const now = Date.parse('2026-08-27T14:00:00.000Z');
  await withStore(now, async (store) => {
    assert.equal(await store.appendSample({ timestamp: '2026-08-27T14:00:00.000Z', pond: 28.5, ambient: 28.9 }), true);
    assert.equal(await store.appendSample({ timestamp: '2026-08-27T14:01:00.000Z', pond: 28.5, ambient: 28.9 }), false);
    assert.equal(await store.appendSample({ timestamp: '2026-08-27T14:02:00.000Z', pond: 28.4, ambient: 28.9 }), true);
    assert.equal(await store.appendSample({ timestamp: '2026-08-27T14:11:59.999Z', pond: 28.4, ambient: 28.9 }), false);
    assert.equal(await store.appendSample({ timestamp: '2026-08-27T14:12:00.000Z', pond: 28.4, ambient: 28.9 }), true);
    assert.deepEqual(await store.read('2026-08-27'), {
      date: '2026-08-27',
      samples: [
        { timestamp: '2026-08-27T14:00:00.000Z', pond: 28.5, ambient: 28.9 },
        { timestamp: '2026-08-27T14:02:00.000Z', pond: 28.4, ambient: 28.9 },
        { timestamp: '2026-08-27T14:12:00.000Z', pond: 28.4, ambient: 28.9 },
      ],
    });
  });
});

test('server restart reads the last disk sample and resumes the ten-minute cadence without duplicates', async () => {
  const now = Date.parse('2026-08-27T08:00:00.000Z');
  await withStore(now, async (firstStore, directory) => {
    await firstStore.appendSample({ timestamp: '2026-08-27T08:00:00.000Z', pond: 25, ambient: 28.7 });
    const restartedStore = new DewinHistoryStore({ directory, now: () => now });
    assert.equal(await restartedStore.appendSample({ timestamp: '2026-08-27T08:05:00.000Z', pond: 25, ambient: 28.7 }), false);
    assert.equal(await restartedStore.appendSample({ timestamp: '2026-08-27T08:10:00.000Z', pond: 25, ambient: 28.7 }), true);
    assert.equal((await restartedStore.read('2026-08-27')).samples.length, 2);
  });
});

test('ideal unchanged day produces 144 real samples at ten-minute cadence', async () => {
  const first = Date.parse('2026-08-27T00:00:00+02:00');
  await withStore(first, async (store) => {
    for (let index = 0; index < 144; index += 1) {
      const timestamp = new Date(first + index * DEWIN_HISTORY_SAMPLE_INTERVAL_MS).toISOString();
      assert.equal(await store.appendSample({ timestamp, pond: 25, ambient: 28.7 }), true);
    }
    const history = await store.read('2026-08-27');
    assert.equal(history.samples.length, 144);
    assert.ok(history.samples.every(({ pond, ambient }) => pond === 25 && ambient === 28.7));
  });
});

test('invalid or missing readings never create invented history samples', async () => {
  const now = Date.parse('2026-08-27T08:00:00.000Z');
  await withStore(now, async (store) => {
    assert.equal(await store.appendSample({ timestamp: '2026-08-27T08:00:00.000Z', pond: null, ambient: 28 }), false);
    assert.equal(await store.appendSample({ timestamp: '2026-08-27T08:10:00.000Z', pond: 25, ambient: undefined }), false);
    assert.deepEqual(await store.read('2026-08-27'), { date: '2026-08-27', samples: [] });
  });
});

test('retention keeps today plus 29 previous local days and removes older JSON files', async () => {
  const now = Date.parse('2026-08-27T12:00:00.000Z');
  await withStore(now, async (store, directory) => {
    await store.appendSample({ timestamp: '2026-07-28T12:00:00.000Z', pond: 20, ambient: 21 });
    await store.appendSample({ timestamp: '2026-07-29T12:00:00.000Z', pond: 21, ambient: 22 });
    await store.appendSample({ timestamp: '2026-08-27T12:00:00.000Z', pond: 28, ambient: 29 });
    assert.equal(await store.prune(), 1);
    assert.deepEqual((await readdir(directory)).sort(), ['2026-07-29.json', '2026-08-27.json']);
  });
});
