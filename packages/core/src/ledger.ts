// Balances and CSV export, derived from the materialised group state.

import { convertMinor, minorToDecimal } from './money.js';
import { settle, type Transfer } from './settle.js';
import { computeShares, validateSplit } from './splits.js';
import { expenseViews, groupView, memberViews, type ExpenseView, type GroupState } from './ops.js';

/** Expense total in the group's base currency. */
export function baseAmount(x: ExpenseView, baseCurrency: string): number {
  return convertMinor(x.amount, x.currency, baseCurrency, x.rate);
}

/** memberId -> share of this expense in base currency. */
export function expenseShares(x: ExpenseView, baseCurrency: string): Record<string, number> {
  return computeShares(baseAmount(x, baseCurrency), x.split);
}

export function expenseProblem(x: ExpenseView): string | null {
  if (!x.paidBy) return 'No payer';
  return validateSplit(x.split, x.amount);
}

export interface Ledger {
  baseCurrency: string;
  /** memberId -> net balance in base minor units. Positive = is owed money. */
  balances: Record<string, number>;
  /** memberId -> total spent on their behalf (excludes transfers) */
  spent: Record<string, number>;
  transfers: Transfer[];
  total: number;
}

export function computeLedger(state: GroupState): Ledger {
  const base = groupView(state).baseCurrency;
  const balances: Record<string, number> = {};
  const spent: Record<string, number> = {};
  for (const m of memberViews(state, true)) {
    balances[m.id] = 0;
    spent[m.id] = 0;
  }
  let total = 0;
  for (const x of expenseViews(state)) {
    if (!x.paidBy) continue;
    const shares = expenseShares(x, base);
    const ids = Object.keys(shares);
    if (ids.length === 0) continue;
    const amt = ids.reduce((s, id) => s + shares[id]!, 0);
    balances[x.paidBy] = (balances[x.paidBy] ?? 0) + amt;
    for (const id of ids) {
      balances[id] = (balances[id] ?? 0) - shares[id]!;
      if (x.kind === 'expense') spent[id] = (spent[id] ?? 0) + shares[id]!;
    }
    if (x.kind === 'expense') total += amt;
  }
  return { baseCurrency: base, balances, spent, transfers: settle(balances), total };
}

function csvCell(v: string | number): string {
  let s = String(v);
  // Guard against CSV/formula injection when opened in a spreadsheet.
  if (/^[=+\-@\t\r]/.test(s) && typeof v === 'string') s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function exportCsv(state: GroupState): string {
  const g = groupView(state);
  const members = memberViews(state, true);
  const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? id;
  const header = [
    'Date', 'Description', 'Type', 'Paid by', 'Amount', 'Currency', 'Exchange rate',
    `Amount (${g.baseCurrency})`, 'Split', ...members.map((m) => `${m.name} share (${g.baseCurrency})`),
  ];
  const rows: Array<Array<string | number>> = [header];
  for (const x of [...expenseViews(state)].reverse()) {
    const shares = expenseShares(x, g.baseCurrency);
    rows.push([
      x.date,
      x.description,
      x.kind,
      nameOf(x.paidBy),
      minorToDecimal(x.amount, x.currency),
      x.currency,
      x.currency === g.baseCurrency ? 1 : x.rate,
      minorToDecimal(baseAmount(x, g.baseCurrency), g.baseCurrency),
      x.split.mode,
      ...members.map((m) => minorToDecimal(shares[m.id] ?? 0, g.baseCurrency)),
    ]);
  }
  const ledger = computeLedger(state);
  rows.push([]);
  rows.push(['Balances']);
  for (const m of members) rows.push([m.name, minorToDecimal(ledger.balances[m.id] ?? 0, g.baseCurrency)]);
  rows.push([]);
  rows.push(['Suggested payments']);
  for (const t of ledger.transfers) {
    rows.push([`${nameOf(t.from)} pays ${nameOf(t.to)}`, minorToDecimal(t.amount, g.baseCurrency)]);
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
