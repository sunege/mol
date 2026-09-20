import { describe, expect, it } from 'vitest';
import { MemoryRecordStore, openRecordStore } from './store';
import { fakeRecord } from './fixtures';

const FIRST = fakeRecord({ energy: -74.7, id: 'first', savedAt: '2026-09-20T09:00:00.000Z' });
const SECOND = fakeRecord({ energy: -74.6, id: 'second', savedAt: '2026-09-20T10:00:00.000Z' });

describe('a log that lives in memory', () => {
  it('gives back what was put in, oldest first', async () => {
    const store = new MemoryRecordStore();
    await store.put(SECOND);
    await store.put(FIRST);
    expect((await store.load()).map((record) => record.id)).toEqual(['first', 'second']);
  });

  it('replaces a record with the same id rather than keeping both', async () => {
    // What renaming one does.
    const store = new MemoryRecordStore([FIRST]);
    await store.put({ ...FIRST, name: 'ねじれ形' });
    const records = await store.load();
    expect(records).toHaveLength(1);
    expect(records[0].name).toBe('ねじれ形');
  });

  it('takes several at once', async () => {
    const store = new MemoryRecordStore();
    await store.putAll([FIRST, SECOND]);
    expect(await store.load()).toHaveLength(2);
  });

  it('removes one and empties the rest', async () => {
    const store = new MemoryRecordStore([FIRST, SECOND]);
    await store.remove('first');
    expect((await store.load()).map((record) => record.id)).toEqual(['second']);
    await store.clear();
    expect(await store.load()).toEqual([]);
  });

  it('hands out copies, so the list a panel holds cannot change underneath it', async () => {
    const store = new MemoryRecordStore([FIRST]);
    (await store.load()).pop();
    expect(await store.load()).toHaveLength(1);
  });
});

describe('opening the log where there is nowhere to keep it', () => {
  it('falls back to memory rather than failing', async () => {
    // A private window, or site data turned off.
    const opened = await openRecordStore(undefined);
    expect(opened.persistent).toBe(false);
    await opened.store.put(FIRST);
    expect(await opened.store.load()).toHaveLength(1);
  });

  it('falls back when the database refuses to open', async () => {
    const refusing = {
      open: () => {
        const request: Record<string, unknown> = { error: new Error('no') };
        queueMicrotask(() => (request.onerror as () => void)());
        return request;
      },
    } as unknown as IDBFactory;
    expect((await openRecordStore(refusing)).persistent).toBe(false);
  });

  it('falls back when the database never answers, instead of waiting for ever', async () => {
    // Some private windows do this: `open` returns a request that stays silent.
    const silent = { open: () => ({}) } as unknown as IDBFactory;
    const opened = await openRecordStore(silent, 5);
    expect(opened.persistent).toBe(false);
    await opened.store.put(FIRST);
    expect(await opened.store.load()).toHaveLength(1);
  });
});
