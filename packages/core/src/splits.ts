// Unequal splits. Every split mode is reduced to a list of weights and the
// (base-currency) total is allocated with the largest-remainder method, so
// shares always sum exactly to the total, with deterministic tie-breaking.

export type SplitMode = 'equal' | 'exact' | 'percent' | 'shares';

export interface Split {
  mode: SplitMode;
  /**
   * memberId -> value.
   *  equal:   1 = included (0/absent = excluded)
   *  exact:   minor units in the expense currency
   *  percent: percentage, e.g. 33.33
   *  shares:  any non-negative number, e.g. 1, 2, 0.5
   */
  entries: Record<string, number>;
}

export const SPLIT_MODES: SplitMode[] = ['equal', 'exact', 'percent', 'shares'];

export function isSplit(x: unknown): x is Split {
  if (!x || typeof x !== 'object') return false;
  const s = x as Split;
  if (!SPLIT_MODES.includes(s.mode)) return false;
  if (!s.entries || typeof s.entries !== 'object' || Array.isArray(s.entries)) return false;
  return Object.values(s.entries).every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0);
}

/** Returns a human-readable problem, or null if the split is valid for this amount. */
export function validateSplit(split: Split, amountMinor: number): string | null {
  const vals = Object.values(split.entries).filter((v) => v > 0);
  if (vals.length === 0) return 'Pick at least one person to split with';
  if (split.mode === 'exact') {
    const sum = vals.reduce((a, b) => a + b, 0);
    if (!vals.every(Number.isInteger)) return 'Exact amounts must be whole minor units';
    if (sum !== amountMinor) return `Exact amounts add up to ${sum}, not ${amountMinor}`;
  }
  if (split.mode === 'percent') {
    const sum = sumSorted(split.entries);
    if (Math.abs(sum - 100) > 0.0001) return `Percentages add up to ${round4(sum)}%, not 100%`;
  }
  return null;
}

function round4(x: number) {
  return Math.round(x * 10000) / 10000;
}

function sumSorted(entries: Record<string, number>): number {
  let s = 0;
  for (const k of Object.keys(entries).sort()) s += entries[k]!;
  return s;
}

export function splitWeights(split: Split): Array<[string, number]> {
  const ids = Object.keys(split.entries).sort();
  const out: Array<[string, number]> = [];
  for (const id of ids) {
    const v = split.entries[id]!;
    if (!(v > 0)) continue;
    out.push([id, split.mode === 'equal' ? 1 : v]);
  }
  return out;
}

/**
 * Allocate `total` minor units across weights. Shares sum exactly to total.
 * Leftover units go to the largest fractional remainders; ties go to the
 * lexicographically smallest member id.
 */
export function allocate(total: number, weights: Array<[string, number]>): Record<string, number> {
  const result: Record<string, number> = {};
  if (weights.length === 0) return result;
  let W = 0;
  for (const [, w] of weights) W += w;
  if (!(W > 0)) return result;

  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const rows = weights.map(([id, w]) => {
    const quota = (abs * w) / W;
    const floor = Math.floor(quota);
    return { id, floor, frac: quota - floor };
  });
  let remaining = abs - rows.reduce((a, r) => a + r.floor, 0);
  const order = [...rows].sort((a, b) => b.frac - a.frac || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (let i = 0; remaining > 0; i = (i + 1) % order.length) {
    order[i]!.floor += 1;
    remaining -= 1;
  }
  for (const r of rows) result[r.id] = sign * r.floor;
  return result;
}

export function computeShares(totalMinor: number, split: Split): Record<string, number> {
  return allocate(totalMinor, splitWeights(split));
}
