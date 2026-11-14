import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildState, emptyState, expenseViews, makeOp, type Clock, type Op } from '@splitter/core';
import { buildApp } from '../src/app.js';
import { MemoryStore, PgStore, type Store } from '../src/store.js';

// Runs against Postgres when TEST_DATABASE_URL is set, otherwise in memory.
const pgUrl = process.env.TEST_DATABASE_URL;
let store: Store;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  store = pgUrl ? await PgStore.connect(pgUrl) : new MemoryStore();
  app = await buildApp({ store });
});
afterAll(async () => {
  await app.close();
  await store.close();
});

const gid = () => 'test' + Math.random().toString(36).slice(2, 14).padEnd(12, 'x');

function newGroupOps(G: string): Op[] {
  const s = emptyState(G);
  const c: Clock = { wall: 0, counter: 0, node: 'testdevice' };
  return [
    makeOp(s, c, 'group', G, { name: 'Trip', baseCurrency: 'AUD' })!,
    makeOp(s, c, 'member', 'alice0000001', { name: 'Alice' })!,
    makeOp(s, c, 'member', 'bob000000001', { name: 'Bob' })!,
    makeOp(s, c, 'expense', 'dinner000001', {
      description: 'Dinner, "fancy"', amount: 6000, currency: 'AUD', rate: 1, paidBy: 'alice0000001',
      split: { mode: 'equal', entries: { alice0000001: 1, bob000000001: 1 } }, date: '2026-11-01', kind: 'expense',
    })!,
  ];
}

const sync = (G: string, body: object) =>
  app.inject({ method: 'POST', url: `/api/groups/${G}/sync`, payload: body });

describe('sync API', () => {
  it('404s for unknown groups unless create is set', async () => {
    const G = gid();
    expect((await sync(G, { since: 0, ops: [] })).statusCode).toBe(404);
    expect((await sync(G, { since: 0, ops: [], create: true })).statusCode).toBe(200);
  });

  it('pushes, pulls with a cursor, and is idempotent', async () => {
    const G = gid();
    const ops = newGroupOps(G);
    const r1 = (await sync(G, { since: 0, ops, create: true })).json();
    expect(r1.rejected).toEqual([]);
    expect(r1.ops).toHaveLength(4);
    expect(r1.cursor).toBe(4);

    // Retrying the same push (e.g. after a dropped response) adds nothing.
    const r2 = (await sync(G, { since: r1.cursor, ops })).json();
    expect(r2.ops).toHaveLength(0);
    expect(r2.cursor).toBe(4);

    // A second device starting from scratch gets the same state.
    const r3 = (await sync(G, { since: 0, ops: [] })).json();
    const view = expenseViews(buildState(G, r3.ops));
    expect(view[0]!.amount).toBe(6000);
  });

  it('rejects invalid ops but keeps valid ones', async () => {
    const G = gid();
    const ops = newGroupOps(G);
    const bad = { ...ops[1]!, id: 'badop0000001', set: { name: { v: '', b: [] } } };
    const other = { ...ops[2]!, id: 'other0000001', groupId: 'someothergroup' };
    const r = (await sync(G, { since: 0, ops: [...ops, bad, other], create: true })).json();
    expect(r.ops).toHaveLength(4);
    expect(r.rejected.map((x: { id: string }) => x.id).sort()).toEqual(['badop0000001', 'other0000001']);
  });

  it('exports CSV', async () => {
    const G = gid();
    await sync(G, { since: 0, ops: newGroupOps(G), create: true });
    const r = await app.inject({ method: 'GET', url: `/api/groups/${G}/export.csv` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.body).toContain('"Dinner, ""fancy""",expense,Alice,60.00,AUD');
    expect(r.body).toContain('Bob pays Alice,30.00');
  });

  it('handles concurrent pushes without losing or duplicating ops', async () => {
    const G = gid();
    await sync(G, { since: 0, ops: newGroupOps(G), create: true });
    const s = emptyState(G);
    const batches = Array.from({ length: 8 }, (_, i) => {
      const c: Clock = { wall: 0, counter: 0, node: `device${i}xx` };
      return Array.from({ length: 10 }, (_, k) =>
        makeOp(s, c, 'member', `m${i}x${k}xxxxxx`, { name: `M${i}.${k}` })!,
      );
    });
    await Promise.all(batches.map((ops) => sync(G, { since: 0, ops })));
    const all = (await sync(G, { since: 0, ops: [] })).json();
    expect(all.ops).toHaveLength(84);
    expect(all.ops.map((o: { seq: number }) => o.seq)).toEqual(Array.from({ length: 84 }, (_, i) => i + 1));
  });
});
