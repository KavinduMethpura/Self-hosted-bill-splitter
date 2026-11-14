import { useMemo, useState } from 'react';
import {
  COMMON_CURRENCIES, computeShares, convertMinor, formatMoney, minorToDecimal, newId, parseAmount,
  validateSplit, type ExpenseView, type Split, type SplitMode,
} from '@splitter/core';
import type { GroupStore } from '../store';
import { Avatar } from '../pages/GroupPage';
import { ConflictList } from './Conflicts';

const MODES: Array<{ mode: SplitMode; label: string }> = [
  { mode: 'equal', label: 'Equally' },
  { mode: 'exact', label: 'Amounts' },
  { mode: 'percent', label: '%' },
  { mode: 'shares', label: 'Shares' },
];

interface Props {
  store: GroupStore;
  me: string;
  expense: ExpenseView | null;
  onDone: () => void;
}

export function ExpenseForm({ store, me, expense, onDone }: Props) {
  const base = store.group.baseCurrency;
  const isTransfer = expense?.kind === 'transfer';
  // Re-read the live version so remote edits and conflict resolutions show up.
  const live = expense ? store.expenses.find((x) => x.id === expense.id) ?? expense : null;

  const [description, setDescription] = useState(expense?.description ?? '');
  const [currency, setCurrency] = useState(expense?.currency ?? base);
  const [amountText, setAmountText] = useState(expense ? minorToDecimal(expense.amount, expense.currency) : '');
  const [rateText, setRateText] = useState(expense && expense.currency !== base ? String(expense.rate) : '');
  const [paidBy, setPaidBy] = useState(expense?.paidBy ?? me);
  const [date, setDate] = useState(expense?.date ?? new Date().toISOString().slice(0, 10));
  const [mode, setMode] = useState<SplitMode>(expense?.split.mode ?? 'equal');
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(expense, store));

  // Everyone active, plus anyone already in this expense (even if removed since).
  const people = useMemo(() => {
    const ids = new Set(store.members.map((m) => m.id));
    for (const id of Object.keys(expense?.split.entries ?? {})) ids.add(id);
    if (expense?.paidBy) ids.add(expense.paidBy);
    return store.allMembers.filter((m) => ids.has(m.id));
  }, [store.version, expense]);

  const amount = parseAmount(amountText, currency);
  const lastRate = useMemo(() => {
    const prev = store.expenses.find((x) => x.currency === currency && x.id !== expense?.id);
    return prev?.rate;
  }, [currency, store.version]);
  const rate = currency === base ? 1 : Number(rateText || lastRate || NaN);
  const rateOk = currency === base || (Number.isFinite(rate) && rate > 0);

  const split: Split = useMemo(() => {
    if (isTransfer) {
      // A payment goes entirely to one person, so its split follows the amount.
      const to = Object.keys(expense!.split.entries)[0] ?? '';
      return { mode: 'exact', entries: { [to]: amount ?? 0 } };
    }
    const entries: Record<string, number> = {};
    for (const p of people) {
      const t = values[p.id] ?? '';
      let v = 0;
      if (mode === 'equal') v = t === '1' ? 1 : 0;
      else if (mode === 'exact') v = parseAmount(t || '0', currency) ?? NaN;
      else v = t.trim() === '' ? 0 : Number(t);
      if (v !== 0) entries[p.id] = v;
    }
    return { mode, entries };
  }, [values, mode, people, currency, isTransfer, amount]);

  const badEntry = Object.values(split.entries).some((v) => !Number.isFinite(v) || v < 0);
  const splitError = badEntry ? 'Check the numbers' : amount ? validateSplit(split, amount) : null;
  const baseTotal = amount && rateOk ? convertMinor(amount, currency, base, rate) : 0;
  const shares = !splitError && amount && rateOk ? computeShares(baseTotal, split) : {};
  const canSave = !!amount && rateOk && !splitError && !!paidBy && (isTransfer || description.trim().length > 0);

  const setMode2 = (m: SplitMode) => {
    setMode(m);
    const included = people.filter((p) => mode === 'equal' ? values[p.id] === '1' : Number(values[p.id] || 0) > 0);
    const who = included.length ? included : people;
    const next: Record<string, string> = {};
    for (const p of who) {
      next[p.id] =
        m === 'equal' ? '1' :
        m === 'shares' ? '1' :
        m === 'percent' ? String(Math.round((100 / who.length) * 100) / 100) :
        '';
    }
    setValues(next);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave || !amount) return;
    await store.edit('expense', expense?.id ?? newId(), {
      description: description.trim(),
      amount,
      currency,
      rate: currency === base ? 1 : rate,
      paidBy,
      split,
      date,
      kind: expense?.kind ?? 'expense',
      ...(expense ? {} : { deleted: false }),
    });
    onDone();
  };

  const remove = async () => {
    if (!expense || !confirm('Delete this expense? You can restore it from More → Recently deleted.')) return;
    await store.edit('expense', expense.id, { deleted: true }, ['deleted']);
    onDone();
  };

  // Footer hint for the unequal modes.
  let hint: string | null = null;
  if (amount && mode === 'exact' && !badEntry) {
    const left = amount - Object.values(split.entries).reduce((a, b) => a + b, 0);
    hint = left === 0 ? 'All assigned' : left > 0 ? `${formatMoney(left, currency)} left to assign` : `${formatMoney(-left, currency)} too much`;
  } else if (mode === 'percent' && !badEntry) {
    const sum = Object.values(split.entries).reduce((a, b) => a + b, 0);
    hint = `${Math.round(sum * 100) / 100}% of 100%`;
  }

  return (
    <form className="card form expense-form" onSubmit={save}>
      <div className="form-head">
        <button type="button" className="icon-btn" onClick={onDone} aria-label="Back">‹</button>
        <h1 className="grow">{expense ? (isTransfer ? 'Payment' : 'Edit expense') : 'Add expense'}</h1>
      </div>

      {live && <ConflictList store={store} entity="expense" id={live.id} currency={live.currency} />}
      {live && live.conflicts.length > 0 && (
        <p className="muted small">After picking, reopen the expense to edit it further.</p>
      )}

      {!isTransfer && (
        <label>
          What was it for?
          <input value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} placeholder="Groceries" autoFocus={!expense} />
        </label>
      )}

      <div className="two">
        <label className="grow">
          Amount
          <input inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} placeholder="0.00" />
        </label>
        <label>
          Currency
          <select value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={isTransfer}>
            {[...new Set([base, ...COMMON_CURRENCIES])].map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
      </div>
      {amountText && !amount && <p className="error">Enter a valid amount for {currency}.</p>}

      {currency !== base && (
        <label>
          Exchange rate: 1 {currency} = ? {base}
          <input
            inputMode="decimal"
            value={rateText}
            onChange={(e) => setRateText(e.target.value)}
            placeholder={lastRate ? `${lastRate} (last used)` : 'e.g. 1.52'}
          />
          {amount && rateOk && <small className="muted">= {formatMoney(baseTotal, base)}</small>}
        </label>
      )}

      <div className="two">
        <label className="grow">
          Paid by
          <select value={paidBy} onChange={(e) => setPaidBy(e.target.value)}>
            {people.map((p) => <option key={p.id} value={p.id}>{p.id === me ? `${p.name} (you)` : p.name}</option>)}
          </select>
        </label>
        <label>
          Date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </label>
      </div>

      {!isTransfer && (
        <fieldset className="split">
          <legend>Split</legend>
          <div className="segmented" role="radiogroup">
            {MODES.map((m) => (
              <button type="button" key={m.mode} role="radio" aria-checked={mode === m.mode} className={mode === m.mode ? 'active' : ''} onClick={() => setMode2(m.mode)}>
                {m.label}
              </button>
            ))}
          </div>
          <ul className="list">
            {people.map((p) => (
              <li key={p.id} className="row">
                <Avatar name={p.name} />
                <span className="grow">{p.name}</span>
                {shares[p.id] !== undefined && mode !== 'equal' && mode !== 'exact' && (
                  <span className="muted small">{formatMoney(shares[p.id]!, base)}</span>
                )}
                {mode === 'equal' ? (
                  <>
                    {shares[p.id] !== undefined && <span className="muted small">{formatMoney(shares[p.id]!, base)}</span>}
                    <input
                      type="checkbox"
                      aria-label={`Include ${p.name}`}
                      checked={values[p.id] === '1'}
                      onChange={(e) => setValues({ ...values, [p.id]: e.target.checked ? '1' : '' })}
                    />
                  </>
                ) : (
                  <input
                    className="num"
                    inputMode="decimal"
                    aria-label={`${p.name} ${mode}`}
                    value={values[p.id] ?? ''}
                    placeholder="0"
                    onChange={(e) => setValues({ ...values, [p.id]: e.target.value })}
                  />
                )}
                {mode === 'percent' && <span className="muted">%</span>}
              </li>
            ))}
          </ul>
          {hint && <p className={`small ${splitError ? 'error' : 'muted'}`}>{hint}</p>}
          {splitError && mode !== 'exact' && mode !== 'percent' && <p className="error small">{splitError}</p>}
        </fieldset>
      )}

      <div className="actions">
        {expense && <button type="button" className="btn danger ghost" onClick={() => void remove()}>Delete</button>}
        <span className="grow" />
        <button type="button" className="btn ghost" onClick={onDone}>Cancel</button>
        <button className="btn primary" disabled={!canSave}>Save</button>
      </div>
    </form>
  );
}

function initialValues(expense: ExpenseView | null, store: GroupStore): Record<string, string> {
  if (!expense) return Object.fromEntries(store.members.map((m) => [m.id, '1']));
  const out: Record<string, string> = {};
  for (const [id, v] of Object.entries(expense.split.entries)) {
    out[id] =
      expense.split.mode === 'equal' ? (v > 0 ? '1' : '') :
      expense.split.mode === 'exact' ? minorToDecimal(v, expense.currency) :
      String(v);
  }
  return out;
}
