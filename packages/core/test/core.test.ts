import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  allocate, applyOp, buildState, computeLedger, computeShares, convertMinor, exportCsv,
  expenseViews, makeOp, memberViews, parseAmount, receive, settle, tick, validateOp,
  type Clock, type Op, type Split,
} from '../src/index.js';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../spec/fixtures/${name}`, import.meta.url), 'utf8'));

describe('money (shared fixtures)', () => {
  const f = fixture('money.json');
  for (const c of f.parse) {
    it(`parse ${c.input} ${c.currency}`, () => expect(parseAmount(c.input, c.currency)).toBe(c.minor));
  }
  for (const c of f.convert) {
    it(`convert ${c.amount} ${c.from}->${c.to}`, () =>
      expect(convertMinor(c.amount, c.from, c.to, c.rate)).toBe(c.result));
  }
});

describe('splits (shared fixtures)', () => {
  for (const c of fixture('splits.json')) {
    it(c.name, () => expect(computeShares(c.total, c.split as Split)).toEqual(c.shares));
  }
  it('always sums to the total', () => {
    for (let i = 0; i < 2000; i++) {
      const total = Math.floor(Math.random() * 1e7);
      const w: Array<[string, number]> = Array.from({ length: 1 + (i % 9) }, (_, k) => [
        `m${k}`, Math.random() * 10 + 0.01,
      ]);
      const s = allocate(total, w);
      expect(Object.values(s).reduce((a, b) => a + b, 0)).toBe(total);
    }
  });
});

describe('settle', () => {
  for (const c of fixture('settle.json')) {
    it(`${c.name} -> ${c.count} payments`, () => {
      const t = settle(c.balances);
      expect(t.length).toBe(c.count);
      const after = { ...c.balances } as Record<string, number>;
      for (const x of t) {
        expect(x.amount).toBeGreaterThan(0);
        after[x.from]! += x.amount;
        after[x.to]! -= x.amount;
      }
      expect(Object.values(after).every((v) => v === 0)).toBe(true);
    });
  }
  it('is never worse than n-1 and settles random groups', () => {
    for (let i = 0; i < 300; i++) {
      const n = 2 + (i % 12);
      const bal: Record<string, number> = {};
      let sum = 0;
      for (let k = 0; k < n - 1; k++) {
        bal[`p${k}`] = Math.floor(Math.random() * 2000) - 1000;
        sum += bal[`p${k}`]!;
      }
      bal[`p${n - 1}`] = -sum;
      const nonZero = Object.values(bal).filter((v) => v !== 0).length;
      const t = settle(bal);
      expect(t.length).toBeLessThanOrEqual(Math.max(0, nonZero - 1));
      for (const x of t) { bal[x.from]! += x.amount; bal[x.to]! -= x.amount; }
      expect(Object.values(bal).every((v) => v === 0)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------

function device(node: string, start = 1_700_000_000_000): Clock {
  return { wall: start, counter: 0, node };
}
const G = 'group0000000001';

function seed(): Op[] {
  const c = device('setupdevice');
  const s = buildState(G, []);
  const ops: Op[] = [];
  const push = (op: Op | null) => { if (op) { ops.push(op); applyOp(s, op); } };
  push(makeOp(s, c, 'group', G, { name: 'Trip', baseCurrency: 'AUD' }));
  push(makeOp(s, c, 'member', 'alice0000001', { name: 'Alice' }));
  push(makeOp(s, c, 'member', 'bob000000001', { name: 'Bob' }));
  push(makeOp(s, c, 'member', 'carol0000001', { name: 'Carol' }));
  push(makeOp(s, c, 'expense', 'dinner000001', {
    description: 'Dinner', amount: 9000, currency: 'AUD', rate: 1, paidBy: 'alice0000001',
    split: { mode: 'equal', entries: { alice0000001: 1, bob000000001: 1, carol0000001: 1 } },
    date: '2026-11-01', kind: 'expense',
  }));
  return ops;
}

function shuffle<T>(a: T[]): T[] {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j]!, b[i]!];
  }
  return b;
}

/** Two devices go offline with the same state and each makes edits. */
function offlineEdits(edit: (s: ReturnType<typeof buildState>, c: Clock, who: 'A' | 'B') => Op[]) {
  const base = seed();
  const sa = buildState(G, base);
  const sb = buildState(G, base);
  const ca = device('deviceAAAA', 1_700_000_100_000);
  const cb = device('deviceBBBB', 1_700_000_100_000);
  for (const op of base) { receive(ca, op.hlc, 0); receive(cb, op.hlc, 0); }
  const a = edit(sa, ca, 'A');
  const b = edit(sb, cb, 'B');
  return { all: [...base, ...a, ...b] };
}

describe('offline merge', () => {
  it('converges regardless of op order', () => {
    const { all } = offlineEdits((s, c, who) => [
      makeOp(s, c, 'expense', 'dinner000001', { amount: who === 'A' ? 9900 : 9300 })!,
      makeOp(s, c, 'expense', `taxi${who}0000001`, {
        description: 'Taxi', amount: 3000, currency: 'AUD', rate: 1, paidBy: 'bob000000001',
        split: { mode: 'equal', entries: { alice0000001: 1, bob000000001: 1 } }, date: '2026-11-02', kind: 'expense',
      })!,
    ]);
    const ref = JSON.stringify(expenseViews(buildState(G, all)));
    for (let i = 0; i < 50; i++) {
      // duplicates must be harmless too
      expect(JSON.stringify(expenseViews(buildState(G, shuffle([...all, ...all]))))).toBe(ref);
    }
  });

  it('merges edits to different fields of the same expense', () => {
    const { all } = offlineEdits((s, c, who) => [
      who === 'A'
        ? makeOp(s, c, 'expense', 'dinner000001', { description: 'Dinner at Lygon St' })!
        : makeOp(s, c, 'expense', 'dinner000001', { amount: 12000 })!,
    ]);
    const [x] = expenseViews(buildState(G, all));
    expect(x!.description).toBe('Dinner at Lygon St');
    expect(x!.amount).toBe(12000);
    expect(x!.conflicts).toEqual([]);
  });

  it('keeps both values when the same field is edited offline, and resolves', () => {
    const { all } = offlineEdits((s, c, who) => [
      makeOp(s, c, 'expense', 'dinner000001', { amount: who === 'A' ? 9900 : 9300 })!,
    ]);
    const s = buildState(G, all);
    const [x] = expenseViews(s);
    expect(x!.conflicts).toHaveLength(1);
    expect(x!.conflicts[0]!.versions.map((v) => v.v).sort()).toEqual([9300, 9900]);

    // Someone picks the losing value; the conflict disappears everywhere.
    const loser = x!.conflicts[0]!.versions[1]!.v;
    const c = device('deviceCCCC', 1_700_000_200_000);
    for (const o of all) receive(c, o.hlc);
    const fix = makeOp(s, c, 'expense', 'dinner000001', { amount: loser })!;
    const s2 = buildState(G, shuffle([...all, fix]));
    const [y] = expenseViews(s2);
    expect(y!.amount).toBe(loser);
    expect(y!.conflicts).toEqual([]);
  });

  it('sequential edits do not conflict', () => {
    const ops = seed();
    const s = buildState(G, ops);
    const c = device('deviceAAAA', 1_700_000_100_000);
    for (const v of [100, 200, 300]) {
      const op = makeOp(s, c, 'expense', 'dinner000001', { amount: v })!;
      applyOp(s, op);
    }
    const [x] = expenseViews(s);
    expect(x!.amount).toBe(300);
    expect(x!.conflicts).toEqual([]);
  });

  it('an offline edit survives a concurrent delete', () => {
    const { all } = offlineEdits((s, c, who) =>
      who === 'A'
        ? [makeOp(s, c, 'expense', 'dinner000001', { deleted: true })!]
        : [makeOp(s, { ...c, wall: c.wall + 5000 }, 'expense', 'dinner000001', { description: 'Dinner + drinks' })!],
    );
    const s = buildState(G, all);
    const [x] = expenseViews(s);
    expect(x).toBeDefined();
    expect(x!.description).toBe('Dinner + drinks');
    expect(x!.conflicts[0]!.field).toBe('deleted');

    // Confirming the delete must actually delete it.
    const c = device('deviceCCCC', 1_700_000_300_000);
    for (const o of all) receive(c, o.hlc);
    const op = makeOp(s, c, 'expense', 'dinner000001', { deleted: true }, ['deleted'])!;
    applyOp(s, op);
    expect(expenseViews(s)).toHaveLength(0);
  });

  it('computes ledger with mixed currencies', () => {
    const ops = seed();
    const s = buildState(G, ops);
    const c = device('deviceAAAA', 1_700_000_100_000);
    applyOp(s, makeOp(s, c, 'expense', 'hotel0000001', {
      description: 'Hotel', amount: 20000, currency: 'USD', rate: 1.5, paidBy: 'bob000000001',
      split: { mode: 'percent', entries: { alice0000001: 50, bob000000001: 25, carol0000001: 25 } },
      date: '2026-11-03', kind: 'expense',
    })!);
    const l = computeLedger(s);
    // Dinner 90 AUD (30 each, Alice paid). Hotel 300 AUD (A 150, B 75, C 75, Bob paid)
    expect(l.balances).toEqual({ alice0000001: 9000 - 3000 - 15000, bob000000001: 30000 - 3000 - 7500, carol0000001: -3000 - 7500 });
    expect(l.total).toBe(39000);
    expect(l.transfers.length).toBe(2);
    const csv = exportCsv(s);
    expect(csv).toContain('Hotel,expense,Bob,200.00,USD,1.5,300.00,percent,150.00,75.00,75.00');
    expect(memberViews(s).map((m) => m.name)).toEqual(['Alice', 'Bob', 'Carol']);
  });
});

describe('validateOp', () => {
  it('accepts ops from makeOp', () => {
    for (const op of seed()) expect(validateOp(op)).toBeNull();
  });
  it('rejects bad input', () => {
    const op = seed()[4]!;
    expect(validateOp({ ...op, set: { amount: { v: -1, b: [] } } })).toMatch(/invalid value/);
    expect(validateOp({ ...op, set: { hacked: { v: 1, b: [] } } })).toMatch(/unknown field/);
    expect(validateOp({ ...op, set: { amount: { v: 1, b: [op.hlc] } } })).toMatch(/not older/);
    expect(validateOp({ ...op, entity: 'nope' })).toMatch(/entity/);
    expect(validateOp({ ...op, hlc: '1' })).toMatch(/hlc/);
  });
});

describe('hlc', () => {
  it('advances past remote timestamps even with a slow wall clock', () => {
    const a = device('aaaaaaaa', 2_000_000_000_000);
    const b = device('bbbbbbbb', 1_000_000_000_000);
    const ta = tick(a, 2_000_000_000_000);
    receive(b, ta, 1_000_000_000_000);
    const tb = tick(b, 1_000_000_000_001);
    expect(tb > ta).toBe(true);
  });
});
