// "Who owes whom" with the fewest possible payments.
//
// Minimising the number of transfers is NP-hard in general, but it equals
//   (number of people with a non-zero balance) - (max number of disjoint
//    zero-sum subgroups they can be partitioned into)
// For up to EXACT_LIMIT people we find that partition exactly with a bitmask
// DP; each subgroup of k people is then settled with k-1 payments. Above the
// limit we fall back to the greedy largest-debtor/largest-creditor heuristic,
// which is at most n-1 payments and usually optimal in practice.

export interface Transfer {
  from: string;
  to: string;
  amount: number;
}

export const EXACT_LIMIT = 18;

export function settle(balances: Record<string, number>): Transfer[] {
  const people = Object.keys(balances)
    .filter((id) => balances[id] !== 0)
    .sort();
  if (people.length === 0) return [];
  const total = people.reduce((s, id) => s + balances[id]!, 0);
  if (total !== 0) throw new Error(`Balances do not sum to zero (${total})`);

  const groups = people.length <= EXACT_LIMIT ? zeroSumPartition(people, balances) : [people];
  const out: Transfer[] = [];
  for (const g of groups) out.push(...greedy(g, balances));
  return out;
}

function zeroSumPartition(people: string[], balances: Record<string, number>): string[][] {
  const n = people.length;
  const full = (1 << n) - 1;
  const sum = new Float64Array(1 << n);
  const dp = new Int16Array(1 << n);
  const pick = new Int8Array(1 << n);
  for (let mask = 1; mask <= full; mask++) {
    const low = 31 - Math.clz32(mask & -mask);
    sum[mask] = sum[mask & (mask - 1)]! + balances[people[low]!]!;
    let best = -1;
    let bestI = 0;
    for (let i = 0; i < n; i++) {
      if (!(mask & (1 << i))) continue;
      const v = dp[mask ^ (1 << i)]!;
      if (v > best) {
        best = v;
        bestI = i;
      }
    }
    dp[mask] = best + (sum[mask] === 0 ? 1 : 0);
    pick[mask] = bestI;
  }
  // Walk back to get an ordering whose zero-sum prefixes are the groups.
  const order: number[] = [];
  for (let mask = full; mask; mask ^= 1 << pick[mask]!) order.push(pick[mask]!);
  order.reverse();
  const groups: string[][] = [];
  let cur: string[] = [];
  let run = 0;
  for (const i of order) {
    cur.push(people[i]!);
    run += balances[people[i]!]!;
    if (run === 0) {
      groups.push(cur);
      cur = [];
    }
  }
  if (cur.length) groups.push(cur);
  return groups;
}

function greedy(group: string[], balances: Record<string, number>): Transfer[] {
  const bal = group.map((id) => ({ id, v: balances[id]! }));
  const out: Transfer[] = [];
  const cmp = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (;;) {
    const debtors = bal.filter((b) => b.v < 0).sort((a, b) => a.v - b.v || cmp(a, b));
    const creditors = bal.filter((b) => b.v > 0).sort((a, b) => b.v - a.v || cmp(a, b));
    const d = debtors[0];
    const c = creditors[0];
    if (!d || !c) break;
    const amount = Math.min(-d.v, c.v);
    out.push({ from: d.id, to: c.id, amount });
    d.v += amount;
    c.v -= amount;
  }
  return out;
}
